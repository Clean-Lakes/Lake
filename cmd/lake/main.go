package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/legacykeychain"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

// Set by scripts/build_lake.sh after the complete TypeScript runtime is verified.
var agentRelease string

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
	if agentRelease != "" {
		return launchAgent(ctx, args)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	base := filepath.Dir(self)
	runtimeDir := os.Getenv("LAKE_ZCODE_DIR")
	if runtimeDir == "" {
		runtimeDir = filepath.Join(base, "zcode")
		// Electron 安装包将原生 CLI 放在 Resources/lake-runtime；源码目录
		// 仍使用 bin/zcode，不能让安装后的签名启动器查找不存在的目录。
		if _, err := os.Stat(runtimeDir); os.IsNotExist(err) {
			packagedRuntime := filepath.Join(base, "lake-runtime")
			if info, err := os.Stat(packagedRuntime); err == nil && info.IsDir() {
				runtimeDir = packagedRuntime
			}
		}
	}
	node := filepath.Join(runtimeDir, "node")
	if filepath.Ext(self) == ".exe" {
		node += ".exe"
	}
	cli := filepath.Join(runtimeDir, "zcode.cjs")
	for _, path := range []string{node, cli} {
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			return fmt.Errorf("缺少 LAKE 原生运行时；先运行 scripts/build_zcode_agent.mjs")
		}
	}
	entry := cli
	if len(args) > 0 && args[0] == "data" {
		entry = filepath.Join(runtimeDir, "lake-data.cjs")
		args = args[1:]
	} else if len(args) == 2 && args[0] == "secrets" && args[1] == "migrate" {
		args = append([]string{"lake"}, args...)
	}
	argv := append([]string{"--disable-warning=ExperimentalWarning", entry}, args...)
	command := exec.CommandContext(ctx, node, argv...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "LAKE_EXPLICIT_SECRET_MIGRATION=") && !strings.HasPrefix(variable, "LAKE_SIGNED_LAUNCHER=") {
			command.Env = append(command.Env, variable)
		}
	}
	lakeHome := os.Getenv("LAKE_HOME")
	if lakeHome == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		lakeHome = filepath.Join(homeDir, ".lake")
	}
	command.Env = append(command.Env, "LAKE_HOME="+lakeHome, "ZCODE_STORAGE_DIR="+lakeHome, "LAKE_SIGNED_LAUNCHER="+self)
	if len(args) == 3 && args[0] == "lake" && args[1] == "secrets" && args[2] == "migrate" {
		command.Env = append(command.Env, "LAKE_EXPLICIT_SECRET_MIGRATION=1")
	}
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	return command.Run()
}

func launchAgent(ctx context.Context, args []string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	base := filepath.Dir(self)
	runtimeDir := filepath.Join(base, filepath.FromSlash(agentRelease))
	if err := verifyAgentRelease(runtimeDir); err != nil {
		return err
	}
	node := filepath.Join(runtimeDir, "node")
	entry := filepath.Join(runtimeDir, "dist", "surfaces", "cli.js")
	command := exec.CommandContext(ctx, node, append([]string{entry}, args...)...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	for _, variable := range os.Environ() {
		if !strings.HasPrefix(variable, "LAKE_EXPLICIT_SECRET_MIGRATION=") && !strings.HasPrefix(variable, "LAKE_SIGNED_LAUNCHER=") {
			command.Env = append(command.Env, variable)
		}
	}
	lakeHome := os.Getenv("LAKE_HOME")
	if lakeHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		lakeHome = filepath.Join(home, ".lake")
	}
	command.Env = append(command.Env, "LAKE_HOME="+lakeHome, "LAKE_SIGNED_LAUNCHER="+self)
	if len(args) >= 2 && args[0] == "secrets" && args[1] == "migrate" {
		command.Env = append(command.Env, "LAKE_EXPLICIT_SECRET_MIGRATION=1")
	}
	command.Cancel = func() error { return command.Process.Signal(syscall.SIGTERM) }
	return command.Run()
}

func verifyAgentRelease(root string) error {
	contents, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		return errors.New("Lake TypeScript runtime is missing")
	}
	var manifest map[string]json.RawMessage
	if json.Unmarshal(contents, &manifest) != nil {
		return errors.New("Lake runtime manifest is invalid")
	}
	var digest string
	if json.Unmarshal(manifest["digest"], &digest) != nil {
		return errors.New("Lake runtime digest is invalid")
	}
	var platform, arch string
	json.Unmarshal(manifest["platform"], &platform)
	json.Unmarshal(manifest["arch"], &arch)
	expectedArch := map[string]string{"amd64": "x64", "arm64": "arm64"}[runtime.GOARCH]
	if platform != runtime.GOOS || arch != expectedArch {
		return errors.New("Lake runtime target mismatch")
	}
	delete(manifest, "digest")
	var body map[string]interface{}
	if json.Unmarshal(contents, &body) != nil {
		return errors.New("Lake runtime manifest is invalid")
	}
	delete(body, "digest")
	canonical, err := json.Marshal(body)
	if err != nil {
		return errors.New("Lake runtime manifest is invalid")
	}
	sum := sha256.Sum256(canonical)
	if hex.EncodeToString(sum[:]) != digest || !strings.HasSuffix(filepath.Base(root), "-"+digest) {
		return errors.New("Lake runtime manifest was changed")
	}
	var files, links map[string]string
	if json.Unmarshal(manifest["files"], &files) != nil || json.Unmarshal(manifest["links"], &links) != nil {
		return errors.New("Lake runtime inventory is invalid")
	}
	for name, expected := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("Lake runtime path escapes its release")
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("Lake runtime file is missing")
		}
		file, err := os.Open(path)
		if err != nil {
			return errors.New("Lake runtime file cannot be read")
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		file.Close()
		if copyErr != nil || hex.EncodeToString(hash.Sum(nil)) != expected {
			return errors.New("Lake runtime file was changed")
		}
	}
	for name, expected := range links {
		path := filepath.Join(root, filepath.FromSlash(name))
		rel, err := filepath.Rel(root, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("Lake runtime path escapes its release")
		}
		target, err := os.Readlink(path)
		if err != nil || target != expected || filepath.IsAbs(target) {
			return errors.New("Lake runtime link was changed")
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return errors.New("Lake runtime link is invalid")
		}
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil || !strings.HasPrefix(resolved, realRoot+string(filepath.Separator)) {
			return errors.New("Lake runtime link escapes its release")
		}
	}
	return nil
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
