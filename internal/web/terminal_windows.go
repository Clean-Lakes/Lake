//go:build windows

package web

import (
	"github.com/UserExistsError/conpty"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

type windowsTerminal struct {
	*conpty.ConPty
	once sync.Once
	err  error
}

func (t *windowsTerminal) WriteString(value string) (int, error) { return t.Write([]byte(value)) }
func (t *windowsTerminal) Close() error                          { t.once.Do(func() { t.err = t.ConPty.Close() }); return t.err }
func startTerminal(cmd *exec.Cmd, cols, rows int) (terminalDevice, error) {
	parts := make([]string, len(cmd.Args))
	for i, arg := range cmd.Args {
		parts[i] = syscall.EscapeArg(arg)
	}
	env := append([]string(nil), cmd.Env...)
	sort.Slice(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
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
