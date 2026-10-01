package sshtransport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ErrNotStarted is only attached before an SSH exec request can be sent.
var ErrNotStarted = errors.New("SSH 命令尚未派发")

type commandTimeoutKey struct{}

// WithCommandTimeout changes only remote execution, not connection setup.
// The parent's deadline and cancellation still take precedence.
func WithCommandTimeout(ctx context.Context, timeout time.Duration) context.Context {
	return context.WithValue(ctx, commandTimeoutKey{}, timeout)
}

func commandTimeout(ctx context.Context, fallback time.Duration) time.Duration {
	if timeout, ok := ctx.Value(commandTimeoutKey{}).(time.Duration); ok && timeout > 0 && timeout <= time.Hour {
		return timeout
	}
	return fallback
}

func transientSSHSetup(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED)
}

type Target struct {
	Host     string
	Port     int
	Username string
}

type Result struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated"`
}

type Client struct {
	KnownHostsPath string
	Timeout        time.Duration
}

// Connection keeps an authenticated SSH transport open. Each command uses a
// separate non-interactive SSH channel; no remote shell or PTY is kept alive.
type Connection struct {
	client    *ssh.Client
	timeout   time.Duration
	mu        sync.Mutex
	closeOnce sync.Once
	closed    chan struct{}
	closeErr  error
}

func (c *Connection) IsClosed() bool {
	if c == nil {
		return true
	}
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

func (c *Connection) Close() error {
	if c == nil {
		return nil
	}
	c.closeOnce.Do(func() {
		close(c.closed)
		c.closeErr = c.client.Close()
	})
	return c.closeErr
}

// Open verifies the host key and authenticates once, then keeps the SSH
// transport available until Close or a connection failure.
func (c Client) Open(ctx context.Context, target Target, privateKey []byte) (*Connection, error) {
	if target.Host == "" || target.Username == "" || target.Port < 1 || target.Port > 65535 {
		return nil, errors.New("无效的 SSH 执行参数")
	}
	signer, err := ssh.ParsePrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("解析 SSH 私钥: %w", err)
	}
	knownHostsPath := c.KnownHostsPath
	if knownHostsPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		knownHostsPath = filepath.Join(home, ".ssh", "known_hosts")
	}
	hostKeyCallback, err := knownhosts.New(knownHostsPath)
	if err != nil {
		return nil, fmt.Errorf("读取 SSH known_hosts: %w", err)
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	address := net.JoinHostPort(target.Host, strconv.Itoa(target.Port))
	raw, err := (&net.Dialer{}).DialContext(runCtx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("连接 SSH 主机: %w", err)
	}
	stop := context.AfterFunc(runCtx, func() { _ = raw.Close() })
	defer stop()
	if err := raw.SetDeadline(time.Now().Add(timeout)); err != nil {
		raw.Close()
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            target.Username,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: hostKeyCallback,
		Timeout:         timeout,
	}
	conn, chans, reqs, err := ssh.NewClientConn(raw, address, config)
	if err != nil {
		raw.Close()
		return nil, fmt.Errorf("SSH 握手或主机密钥校验失败: %w", err)
	}
	if err := raw.SetDeadline(time.Time{}); err != nil {
		raw.Close()
		return nil, err
	}
	client := ssh.NewClient(conn, chans, reqs)
	connection := &Connection{client: client, timeout: timeout, closed: make(chan struct{})}
	go func() {
		_ = client.Wait()
		connection.Close()
	}()
	go connection.keepalive()
	return connection, nil
}

// keepalive checks idle connections so the session list does not continue to
// show a transport that a network device silently dropped.
func (c *Connection) keepalive() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.closed:
			return
		case <-ticker.C:
			if !c.mu.TryLock() {
				continue
			}
			if c.IsClosed() {
				c.mu.Unlock()
				return
			}
			deadline := time.AfterFunc(10*time.Second, func() { _ = c.Close() })
			_, _, err := c.client.SendRequest("keepalive@openssh.com", true, nil)
			deadline.Stop()
			c.mu.Unlock()
			if err != nil {
				_ = c.Close()
				return
			}
		}
	}
}

// Run executes one command on a fresh SSH connection and closes it afterward.
func (c Client) Run(ctx context.Context, target Target, privateKey []byte, command string) (Result, error) {
	return c.RunWithInput(ctx, target, privateKey, command, nil)
}

func (c Client) RunWithInput(ctx context.Context, target Target, privateKey []byte, command string, input []byte) (Result, error) {
	if command == "" {
		return Result{}, errors.New("无效的 SSH 执行参数")
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 20 * time.Second
	}
	setupCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var connection *Connection
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		connection, err = c.Open(setupCtx, target, privateKey)
		if err == nil || !transientSSHSetup(err) || setupCtx.Err() != nil || attempt == 2 {
			break
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 250 * time.Millisecond)
		select {
		case <-setupCtx.Done():
			timer.Stop()
			return Result{}, fmt.Errorf("%w: %w", ErrNotStarted, setupCtx.Err())
		case <-timer.C:
		}
	}
	if err != nil {
		return Result{}, fmt.Errorf("%w: %w", ErrNotStarted, err)
	}
	defer connection.Close()
	return connection.RunWithInput(ctx, command, input)
}

// Run creates a fresh non-interactive SSH session on an existing connection.
func (c *Connection) Run(ctx context.Context, command string) (Result, error) {
	return c.RunWithInput(ctx, command, nil)
}

func (c *Connection) RunWithInput(ctx context.Context, command string, input []byte) (Result, error) {
	if command == "" {
		return Result{}, errors.New("无效的 SSH 执行参数")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.IsClosed() {
		return Result{}, fmt.Errorf("%w: SSH 连接已关闭", ErrNotStarted)
	}
	runCtx, cancel := context.WithTimeout(ctx, commandTimeout(ctx, c.timeout))
	defer cancel()
	stop := context.AfterFunc(runCtx, func() { c.Close() })
	defer stop()
	session, err := c.client.NewSession()
	if err != nil {
		return Result{}, fmt.Errorf("%w: 创建 SSH 会话: %w", ErrNotStarted, err)
	}
	defer session.Close()
	stdout, stderr := &limitBuffer{limit: 64 << 10}, &limitBuffer{limit: 64 << 10}
	session.Stdout, session.Stderr = stdout, stderr
	if input != nil {
		session.Stdin = bytes.NewReader(input)
	}
	err = session.Run(command)
	result := Result{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 0, Truncated: stdout.truncated || stderr.truncated}
	if err == nil {
		return result, nil
	}
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitStatus()
		return result, nil
	}
	if runCtx.Err() != nil {
		return result, fmt.Errorf("SSH 操作超时或取消: %w", runCtx.Err())
	}
	return result, fmt.Errorf("SSH 命令结果不确定: %w", err)
}

type limitBuffer struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (b *limitBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - b.buffer.Len()
	if remaining > 0 {
		if len(p) > remaining {
			b.buffer.Write(p[:remaining])
			b.truncated = true
		} else {
			b.buffer.Write(p)
		}
	} else {
		b.truncated = true
	}
	return n, nil
}

func (b *limitBuffer) String() string { return b.buffer.String() }

// Shell keeps a verified SSH channel with a controlled persistent sh (no PTY).
// Authentication and host-key verification remain in Client.Open.
type Shell struct {
	Stdin  io.WriteCloser
	Stdout io.Reader
	Stderr io.Reader
	close  func() error
}

func (s *Shell) Close() error { return s.close() }
func (c Client) OpenShell(ctx context.Context, target Target, key []byte, root string) (*Shell, error) {
	if !strings.HasPrefix(root, "/") || strings.ContainsAny(root, "\x00\r\n") {
		return nil, errors.New("远程 Shell 目录无效")
	}
	conn, err := c.Open(ctx, target, key)
	if err != nil {
		return nil, err
	}
	session, err := conn.client.NewSession()
	if err != nil {
		conn.Close()
		return nil, err
	}
	cleanup := func() error { _ = session.Close(); return conn.Close() }
	in, err := session.StdinPipe()
	if err != nil {
		cleanup()
		return nil, err
	}
	out, err := session.StdoutPipe()
	if err != nil {
		cleanup()
		return nil, err
	}
	errout, err := session.StderrPipe()
	if err != nil {
		cleanup()
		return nil, err
	}
	quoted := "'" + strings.ReplaceAll(root, "'", `'"'"'`) + "'"
	if err := session.Start("cd -- " + quoted + " && test \"$(pwd -P)\" = " + quoted + " && exec 3>&1 && exec sh"); err != nil {
		cleanup()
		return nil, err
	}
	return &Shell{Stdin: in, Stdout: out, Stderr: errout, close: cleanup}, nil
}
