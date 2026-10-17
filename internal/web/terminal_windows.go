//go:build windows

package web

import (
	"github.com/UserExistsError/conpty"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

type windowsTerminal struct {
	*conpty.ConPty
	once       sync.Once
	err        error
	decoder    consoleFrameDecoder
	readBuffer []byte
	readErr    error
}

func windowsTerminalInput(value string) string {
	// ConPTY translates input into console key events: Enter is CR, not LF.
	// Shell initialization and managed commands use LF on Unix; normalize both
	// LF and CRLF here without submitting CRLF twice or changing VT key codes.
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\r"), "\n", "\r")
}
func (t *windowsTerminal) WriteString(value string) (int, error) {
	_, err := t.Write([]byte(windowsTerminalInput(consoleTerminalScript(value))))
	if err != nil {
		return 0, err
	}
	return len(value), nil
}
func (t *windowsTerminal) Close() error { t.once.Do(func() { t.err = t.ConPty.Close() }); return t.err }
func (t *windowsTerminal) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(t.readBuffer) == 0 && t.readErr == nil {
		var buf [8192]byte
		n, err := t.ConPty.Read(buf[:])
		t.readBuffer = append(t.readBuffer, t.decoder.feed(string(buf[:n]), err != nil)...)
		t.readErr = err
	}
	n := copy(p, t.readBuffer)
	t.readBuffer = t.readBuffer[n:]
	if n > 0 {
		return n, nil
	}
	return 0, t.readErr
}
func startTerminal(cmd *exec.Cmd, cols, rows int) (terminalDevice, error) {
	args, env := consoleTerminalCommand(cmd)
	parts := make([]string, len(args))
	for i, arg := range args {
		parts[i] = syscall.EscapeArg(arg)
	}
	env = consoleTerminalEnvironment(env)
	p, err := conpty.Start(strings.Join(parts, " "), conpty.ConPtyDimensions(cols, rows), conpty.ConPtyWorkDir(cmd.Dir), conpty.ConPtyEnv(env))
	if err != nil {
		return nil, err
	}
	cmd.Process, err = os.FindProcess(p.Pid())
	if err != nil {
		p.Close()
		return nil, err
	}
	return &windowsTerminal{ConPty: p}, nil
}
func resizeTerminal(f terminalDevice, cols, rows int) error {
	return f.(*windowsTerminal).Resize(cols, rows)
}
func killForeground(*liveTerminal) {}
func killTerminal(pid int) {
	cmd := exec.Command("taskkill.exe", "/PID", strconv.Itoa(pid), "/T", "/F")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Run()
}
