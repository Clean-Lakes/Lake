package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/legacykeychain"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
)

// The signed launcher has no agent, data, workflow or SSH execution implementation.
func main() {
	if len(os.Args) > 1 && os.Args[1] == "__legacy_keychain" {
		if err := legacySecret(os.Args[2:]); err != nil {
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := launch(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "lake:", err)
		if e, ok := err.(*exec.ExitError); ok {
			os.Exit(e.ExitCode())
		}
		os.Exit(1)
	}
}
func launch(ctx context.Context, args []string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	base := filepath.Dir(self)
	runtimeDir := os.Getenv("LAKE_ZCODE_DIR")
	if runtimeDir == "" {
		runtimeDir = filepath.Join(base, "zcode")
	}
	node := filepath.Join(runtimeDir, "node")
	if filepath.Ext(self) == ".exe" {
		node += ".exe"
	}
	cli := filepath.Join(runtimeDir, "zcode.cjs")
	for _, path := range []string{node, cli} {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return fmt.Errorf("缺少 ZCode 源码运行时；先运行 scripts/build_zcode_agent.mjs")
		}
	}
	argv := append([]string{"--disable-warning=ExperimentalWarning", cli, "lake"}, args...)
	command := exec.CommandContext(ctx, node, argv...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "LAKE_EXPLICIT_SECRET_MIGRATION=") && !strings.HasPrefix(variable, "LAKE_SIGNED_LAUNCHER=") {
			command.Env = append(command.Env, variable)
		}
	}
	command.Env = append(command.Env, "LAKE_SIGNED_LAUNCHER="+self)
	if len(args) == 2 && args[0] == "secrets" && args[1] == "migrate" {
		command.Env = append(command.Env, "LAKE_EXPLICIT_SECRET_MIGRATION=1")
	}
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	return command.Run()
}
func legacySecret(args []string) error {
	if os.Getenv("LAKE_EXPLICIT_SECRET_MIGRATION") != "1" || len(args) != 2 {
		return errors.New("legacy migration is unavailable")
	}
	vault := legacykeychain.Keychain{}
	var secret []byte
	var err error
	switch args[0] {
	case "load-model":
		secret, err = vault.LoadModelAPIKey(args[1])
	case "load-ssh":
		secret, err = vault.Load(args[1])
	case "delete-model":
		return vault.DeleteModelAPIKey(args[1])
	case "delete-ssh":
		return vault.Delete(args[1])
	default:
		return errors.New("unknown migration request")
	}
	if err != nil {
		return err
	}
	defer func() {
		for i := range secret {
			secret[i] = 0
		}
	}()
	// Credentials travel on a private inherited pipe, never stdout or logs.
	pipe := os.NewFile(3, "migration-secret")
	if pipe == nil {
		return errors.New("migration pipe unavailable")
	}
	defer pipe.Close()
	_, err = io.Copy(pipe, bytes.NewReader(secret))
	return err
}
