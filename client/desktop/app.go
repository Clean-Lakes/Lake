package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

type rpcReply struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	Event  map[string]any  `json:"event"`
}

// The window owns presentation and one TypeScript process connection.
type App struct {
	ctx                context.Context
	mu                 sync.Mutex
	writeMu            sync.Mutex
	process            *exec.Cmd
	stdin              io.WriteCloser
	pending            map[string]chan rpcReply
	counter            atomic.Uint64
	conversationID     string
	activeTurn         string
	done               chan struct{}
	rpcCall            func(string, map[string]any) (json.RawMessage, error)
	taskEvent          func(string, any)
	saveDownloadDialog func(wailsruntime.SaveDialogOptions) (string, error)
}

func NewApp() *App                         { return &App{} }
func (a *App) startup(ctx context.Context) { a.ctx = ctx }
func (a *App) emit(event map[string]any) {
	if event["type"] == "result" || event["type"] == "error" {
		a.mu.Lock()
		if event["id"] == a.activeTurn {
			a.activeTurn = ""
		}
		a.mu.Unlock()
	}
	if a.taskEvent != nil {
		a.taskEvent("lake:event", event)
	} else if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "lake:event", event)
	}
}
func (a *App) ensureRuntime() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stdin != nil {
		return nil
	}
	path, err := lakeBinary()
	if err != nil {
		return err
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	command := exec.CommandContext(ctx, path, "serve")
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	command.Stderr = io.Discard
	if err = command.Start(); err != nil {
		input.Close()
		return err
	}
	a.process, a.stdin, a.done = command, input, make(chan struct{})
	if a.pending == nil {
		a.pending = make(map[string]chan rpcReply)
	}
	done := a.done
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 65536), 16*1024*1024)
		for scanner.Scan() {
			var reply rpcReply
			if json.Unmarshal(scanner.Bytes(), &reply) != nil {
				continue
			}
			if reply.Event != nil {
				a.emit(reply.Event)
				continue
			}
			a.mu.Lock()
			waiting := a.pending[reply.ID]
			delete(a.pending, reply.ID)
			a.mu.Unlock()
			if waiting != nil {
				waiting <- reply
			} else if reply.Error != "" {
				a.emit(map[string]any{"type": "error", "id": reply.ID, "error": reply.Error})
			}
		}
		command.Wait()
		a.mu.Lock()
		if a.process == command {
			a.process, a.stdin = nil, nil
			for id, waiting := range a.pending {
				waiting <- rpcReply{ID: id, Error: "TypeScript 运行时已退出"}
				delete(a.pending, id)
			}
		}
		a.mu.Unlock()
		close(done)
		a.emit(map[string]any{"type": "closed"})
	}()
	return nil
}
func (a *App) writeRequest(id, method string, params map[string]any) error {
	if err := a.ensureRuntime(); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.mu.Lock()
	input := a.stdin
	a.mu.Unlock()
	if input == nil {
		return errors.New("TypeScript 运行时已关闭")
	}
	_, err = input.Write(append(body, 10))
	return err
}
func (a *App) request(method string, params map[string]any) (string, error) {
	if params == nil {
		params = map[string]any{}
	}
	if a.rpcCall != nil {
		result, err := a.rpcCall(method, params)
		return string(result), err
	}
	if err := a.ensureRuntime(); err != nil {
		return "", err
	}
	id := fmt.Sprintf("desktop-%d", a.counter.Add(1))
	waiting := make(chan rpcReply, 1)
	a.mu.Lock()
	a.pending[id] = waiting
	a.mu.Unlock()
	if err := a.writeRequest(id, method, params); err != nil {
		a.mu.Lock()
		delete(a.pending, id)
		a.mu.Unlock()
		return "", err
	}
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case reply := <-waiting:
		if reply.Error != "" {
			return "", errors.New(reply.Error)
		}
		return string(reply.Result), nil
	case <-ctx.Done():
		a.mu.Lock()
		delete(a.pending, id)
		a.mu.Unlock()
		return "", ctx.Err()
	}
}
func (a *App) cli(args ...string) (string, error) {
	return a.request("cli", map[string]any{"argv": args})
}
func (a *App) cliInput(input string, args ...string) (string, error) {
	return a.request("cli", map[string]any{"argv": args, "stdin": input})
}
func (a *App) call(method string, params map[string]any) error {
	_, err := a.request(method, params)
	return err
}
func (a *App) shutdown(_ context.Context) {
	a.mu.Lock()
	input, process, done := a.stdin, a.process, a.done
	a.mu.Unlock()
	if input != nil {
		input.Close()
	}
	if process != nil && done != nil {
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			process.Process.Kill()
			<-done
		}
	}
}
func lakeBinary() (string, error) {
	name := "lake"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if explicit := os.Getenv("LAKE_CLI_PATH"); explicit != "" {
		return explicit, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	executableDir := filepath.Dir(executable)
	candidates := []string{
		filepath.Join(executableDir, name),
		filepath.Join(executableDir, "..", "Resources", name),
		filepath.Join("..", "..", "bin", name),
		filepath.Join("bin", name),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return filepath.Abs(candidate)
		}
	}
	return "", fmt.Errorf("找不到 Lake CLI；请先编译 bin/%s", name)
}
