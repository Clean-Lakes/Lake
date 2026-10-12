//go:build !darwin && !linux

package ai

import (
	"os/exec"
	"time"
)

func setupProcess(cmd *exec.Cmd)                 { cmd.WaitDelay = 2 * time.Second }
func ownedFile(info interface{ Sys() any }) bool { return true }
