//go:build windows

package ai

import (
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

func setupProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		kill := exec.Command("taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
		kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		return kill.Run()
	}
	cmd.WaitDelay = 2 * time.Second
}
func ownedFile(info interface{ Sys() any }) bool { return info != nil }
