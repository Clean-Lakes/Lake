//go:build !darwin && !linux

package code

import "os/exec"

func isolateTerminalProcess(_ *exec.Cmd) {}
func cleanupTerminalProcess(_ *exec.Cmd) {}
