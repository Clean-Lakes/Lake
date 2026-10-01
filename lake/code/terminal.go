package code

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TerminalSession keeps one controlled shell. Commands are individually approved
// by the caller, run sequentially, and retain cd/export state. It is not a TTY:
// command stdin is closed, so interactive programs cannot consume the protocol.
type TerminalSession struct {
	TransportTarget         string `json:"-"`
	ID                      string `json:"id"`
	Root                    string `json:"root"`
	User                    string `json:"user"`
	workspace               *Workspace
	mu                      sync.Mutex
	closed                  bool
	cancel                  context.CancelFunc
	directory               string
	command                 *exec.Cmd
	stdin                   io.WriteCloser
	stdout, stderr, control *bufio.Reader
	files                   []*os.File
	closeTransport          func() error
	closeOnce               sync.Once
}
type TerminalResult struct {
	Command          string `json:"command"`
	WorkingDirectory string `json:"working_directory"`
	NextDirectory    string `json:"next_directory"`
	User             string `json:"user"`
	Truncated        bool   `json:"truncated"`
	CommandResult
}

func NewTerminalSession(workspace *Workspace) (*TerminalSession, error) {
	if workspace == nil || workspace.Root == "" {
		return nil, errors.New("代码项目未绑定")
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	name := "local"
	if current, err := user.Current(); err == nil {
		name = current.Username
	}
	session := &TerminalSession{ID: hex.EncodeToString(nonce), Root: workspace.Root, User: name, workspace: workspace, directory: workspace.Root}
	command := exec.CommandContext(context.Background(), "sh")
	command.Dir = workspace.Root
	command.Env = []string{}
	for _, key := range []string{"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "GOPATH", "GOROOT", "GOCACHE"} {
		if value, ok := os.LookupEnv(key); ok {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	isolateTerminalProcess(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	var readers, writers []*os.File
	for i := 0; i < 3; i++ {
		r, w, e := os.Pipe()
		if e != nil {
			stdin.Close()
			for _, f := range append(readers, writers...) {
				f.Close()
			}
			return nil, e
		}
		readers = append(readers, r)
		writers = append(writers, w)
	}
	command.Stdout, command.Stderr = writers[0], writers[1]
	command.ExtraFiles = []*os.File{writers[2]}
	if err := command.Start(); err != nil {
		stdin.Close()
		for _, f := range append(readers, writers...) {
			f.Close()
		}
		return nil, err
	}
	for _, f := range writers {
		f.Close()
	}
	session.command, session.stdin, session.files = command, stdin, readers
	session.stdout, session.stderr, session.control = bufio.NewReader(readers[0]), bufio.NewReader(readers[1]), bufio.NewReader(readers[2])
	go func() {
		_ = command.Wait()
		session.mu.Lock()
		session.closed = true
		session.mu.Unlock()
		cleanupTerminalProcess(command)
	}()
	return session, nil
}
func (s *TerminalSession) CurrentDirectory() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.directory
}
func (s *TerminalSession) IsClosed() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.closed }

type terminalStream struct {
	text      string
	truncated bool
	err       error
}

func readTerminalStream(reader *bufio.Reader, marker []byte) terminalStream {
	var output limitedBuffer
	pending := make([]byte, 0, len(marker))
	total := 0
	for {
		b, err := reader.ReadByte()
		if err != nil {
			output.Write(pending)
			return terminalStream{output.String(), total > maxOutputBytes, err}
		}
		pending = append(pending, b)
		for !bytes.HasPrefix(marker, pending) {
			output.Write(pending[:1])
			total++
			pending = pending[1:]
		}
		if len(pending) == len(marker) {
			return terminalStream{output.String(), total > maxOutputBytes, nil}
		}
	}
}
func readTerminalField(reader *bufio.Reader) (string, error) {
	var value strings.Builder
	for i := 0; i < 8192; i++ {
		b, err := reader.ReadByte()
		if err != nil {
			return "", err
		}
		if b == 0 {
			return value.String(), nil
		}
		value.WriteByte(b)
	}
	return "", errors.New("终端状态协议无效")
}
func (s *TerminalSession) Run(ctx context.Context, command string) (TerminalResult, error) {
	if strings.TrimSpace(command) == "" || len(command) > 4000 || strings.ContainsAny(command, "\x00\r\n") {
		return TerminalResult{}, errors.New("终端命令须为不超过 4000 字符的单行文本")
	}
	if s.workspace != nil {
		current, err := Open(s.Root)
		if err != nil || current.Root != s.Root {
			return TerminalResult{}, errors.New("代码项目路径在会话期间发生变化")
		}
	}
	runCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return TerminalResult{}, errors.New("终端会话已关闭")
	}
	if s.cancel != nil {
		s.mu.Unlock()
		return TerminalResult{}, errors.New("终端已有命令在运行")
	}
	s.cancel = cancel
	directory := s.directory
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.cancel = nil; s.mu.Unlock() }()
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return TerminalResult{}, err
	}
	token := hex.EncodeToString(nonce)
	marker := []byte("\x00" + token + "\x00")
	outDone, errDone := make(chan terminalStream, 1), make(chan terminalStream, 1)
	go func() { outDone <- readTerminalStream(s.stdout, marker) }()
	go func() { errDone <- readTerminalStream(s.stderr, marker) }()
	quoted := "'" + strings.ReplaceAll(command, "'", `'"'"'`) + "'"
	// The nonce is generated after authorization and only used as an output boundary.
	script := fmt.Sprintf("eval %s </dev/null; _lake_exit=$?; command printf '\\000%s\\000'; command printf '\\000%s\\000' >&2; command printf '%%s\\000%%s\\000' \"$_lake_exit\" \"$(command pwd -P)\" >&3\n", quoted, token, token)
	if _, err := io.WriteString(s.stdin, script); err != nil {
		s.Close()
	}
	type collected struct {
		out, errout terminalStream
		exit        int
		directory   string
		err         error
	}
	done := make(chan collected, 1)
	go func() {
		o := <-outDone
		exitText, failure := readTerminalField(s.control)
		dir, dirErr := readTerminalField(s.control)
		exit, exitErr := strconv.Atoi(exitText)
		e := <-errDone
		if failure == nil {
			failure = dirErr
		}
		if failure == nil {
			failure = exitErr
		}
		if failure == nil {
			failure = o.err
		}
		if failure == nil {
			failure = e.err
		}
		done <- collected{o, e, exit, dir, failure}
	}()

	var r collected
	select {
	case r = <-done:
	case <-runCtx.Done():
		s.Close()
		r = <-done
		r.err = runCtx.Err()
	}
	result := TerminalResult{Command: command, WorkingDirectory: directory, NextDirectory: r.directory, User: s.User, Truncated: r.out.truncated || r.errout.truncated, CommandResult: CommandResult{Stdout: r.out.text, Stderr: r.errout.text, ExitCode: r.exit}}
	if r.err != nil {
		s.Close()
		result.ExitCode = -1
		result.NextDirectory = directory
		return result, errors.New("终端执行中断或超时，结果未知；此 Shell 已关闭，请核对后再启动")
	}
	s.mu.Lock()
	s.directory = r.directory
	s.mu.Unlock()
	return result, nil
}
func (s *TerminalSession) Close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		cancel := s.cancel
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if s.command != nil {
			cleanupTerminalProcess(s.command)
		}
		if s.closeTransport != nil {
			_ = s.closeTransport()
		}
		s.stdin.Close()
		for _, f := range s.files {
			f.Close()
		}
	})
}

// NewStreamTerminal runs the same sequential command protocol over a verified
// remote shell. Its fd 3 must alias stdout; the service checks scope each Run.
func NewStreamTerminal(root, user string, input io.WriteCloser, stdout, stderr io.Reader, closeTransport func() error) (*TerminalSession, error) {
	if root == "" || input == nil || stdout == nil || stderr == nil || closeTransport == nil {
		return nil, errors.New("终端传输参数无效")
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := bufio.NewReader(stdout)
	return &TerminalSession{ID: hex.EncodeToString(nonce), Root: root, User: user, directory: root, stdin: input, stdout: out, stderr: bufio.NewReader(stderr), control: out, closeTransport: closeTransport}, nil
}
