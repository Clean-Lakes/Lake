//go:build !darwin

package main

import (
	"errors"
	"io"
)

func installScheduleLaunchAgent(string, io.Writer) error {
	return errors.New("计划 LaunchAgent 仅支持 macOS")
}
func uninstallScheduleLaunchAgent(io.Writer) error {
	return errors.New("计划 LaunchAgent 仅支持 macOS")
}
