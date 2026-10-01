package zcode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type wireMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}

type protocol struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  uint64
	pending map[string]chan wireMessage
	Events  chan wireMessage
	done    chan struct{}
	cancel  context.CancelFunc
}

func startProtocol(ctx context.Context, dir string, opts Options) (*protocol, error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, opts.NodePath, opts.CLIPath, "app-server", "--cwd", dir, "--surface", "desktop")
	cmd.Dir = dir
	for _, name := range []string{"PATH", "HOME", "USER", "TMPDIR", "LANG", "SystemRoot", "TEMP", "TMP"} {
		if value, ok := os.LookupEnv(name); ok {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "NODE_ENV=production", "ZCODE_MODEL_TELEMETRY_ENABLED=false", "ZCODE_DATA_BASE_DIR="+dir, "ZCODE_STORAGE_DIR="+filepath.Join(dir, "storage"), "ZCODE_SESSION_DB_PATH="+filepath.Join(dir, "sessions.sqlite"), "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE="+filepath.Join(dir, "builtin.json"), "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="+filepath.Join(dir, "personal.json"))
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	// Never relay raw Agent diagnostic output; it can contain prompt data.
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		cancel()
		return nil, err
	}
	p := &protocol{command: cmd, stdin: stdin, pending: make(map[string]chan wireMessage), Events: make(chan wireMessage, 256), done: make(chan struct{}), cancel: cancel}
	go p.read(ctx, stdout)
	return p, nil
}

func (p *protocol) write(message any) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	return json.NewEncoder(p.stdin).Encode(message)
}

func (p *protocol) read(ctx context.Context, stdout io.Reader) {
	defer close(p.done)
	defer close(p.Events)
	defer func() { _ = p.command.Wait() }()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 32*1024*1024)
	for scanner.Scan() {
		var message wireMessage
		if json.Unmarshal(scanner.Bytes(), &message) != nil {
			continue
		}
		if len(message.ID) > 0 && message.Method != "" {
			// Host tools already perform Lake approval. Any extra native request
			// remains denied; neither model text nor an allowlist can grant it.
			_ = p.write(map[string]any{"id": message.ID, "error": map[string]any{"code": -32601, "message": "Use LAKE host tools and approval"}})
			continue
		}
		if len(message.ID) > 0 {
			p.mu.Lock()
			reply := p.pending[string(message.ID)]
			p.mu.Unlock()
			if reply != nil {
				select {
				case reply <- message:
				default:
				}
			}
			continue
		}
		select {
		case p.Events <- message:
		case <-ctx.Done():
			return
		}
	}
}

func (p *protocol) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	p.mu.Lock()
	p.nextID++
	id := p.nextID
	keyBytes, _ := json.Marshal(id)
	key := string(keyBytes)
	reply := make(chan wireMessage, 1)
	p.pending[key] = reply
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, key); p.mu.Unlock() }()
	if err := p.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	timer := time.NewTimer(45 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-p.done:
		return nil, errors.New("ZCode 启动或协议连接失败")
	case <-timer.C:
		return nil, errors.New("ZCode 协议请求超时")
	case message := <-reply:
		if len(message.Error) > 0 {
			return nil, errors.New("ZCode 拒绝协议请求：" + method)
		}
		return message.Result, nil
	}
}

func (p *protocol) Close() {
	p.cancel()
	_ = p.stdin.Close()
	<-p.done
}
