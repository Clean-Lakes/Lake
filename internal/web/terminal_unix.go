//go:build !windows

package web

import (
	"github.com/creack/pty"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"syscall"
)

func startTerminal(cmd *exec.Cmd, cols, rows int) (terminalDevice, error) {
	return pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func resizeTerminal(f terminalDevice, cols, rows int) error {
	return pty.Setsize(f.(*os.File), &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func killForeground(l *liveTerminal) {
	if l.cmd.Process == nil {
		return
	}
	if foreground, err := unix.IoctlGetInt(int(l.pty.(*os.File).Fd()), unix.TIOCGPGRP); err == nil && foreground > 0 && foreground != syscall.Getpgrp() {
		syscall.Kill(-foreground, syscall.SIGKILL)
	}
}
func killTerminal(pid int) { syscall.Kill(-pid, syscall.SIGKILL); syscall.Kill(pid, syscall.SIGKILL) }
