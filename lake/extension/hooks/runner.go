// Package hooks executes explicitly enabled workspace hooks behind approval.
package hooks

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Event string

const (
	SessionStart       Event = "SessionStart"
	UserPromptSubmit   Event = "UserPromptSubmit"
	PreToolUse         Event = "PreToolUse"
	PermissionRequest  Event = "PermissionRequest"
	PostToolUse        Event = "PostToolUse"
	PostToolUseFailure Event = "PostToolUseFailure"
	Stop               Event = "Stop"
)

var (
	ErrDisabled = errors.New("Hook 未启用")
	ErrChanged  = errors.New("Hook 声明已变化，原许可失效")
)

type Declaration struct {
	Event   Event    `json:"event"`
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
}

type Manifest struct {
	Version int           `json:"version"`
	Hooks   []Declaration `json:"hooks"`
}

type Runner struct {
	Root            string
	Digest          string
	Manifest        Manifest
	Enabled         bool
	DeclarationPath string
}

type Result struct {
	Event     Event  `json:"event"`
	Status    string `json:"status"`
	Stdout    string `json:"stdout,omitempty"`
	Stderr    string `json:"stderr,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

type Approval func(kind, path, detail string) (bool, error)

func validEvent(event Event) bool {
	switch event {
	case SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop:
		return true
	default:
		return false
	}
}

func commandPath(root, command string) (string, error) {
	if command == "" || filepath.IsAbs(command) || strings.ContainsRune(command, '\x00') {
		return "", errors.New("Hook 命令必须是工作区内相对路径")
	}
	clean := filepath.Clean(command)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("Hook 命令超出工作区")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(root, clean))
	if err != nil {
		return "", errors.New("Hook 命令不存在")
	}
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("Hook 命令超出工作区")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return "", errors.New("Hook 命令不是可执行的普通文件")
	}
	return path, nil
}

func Load(root string) (*Runner, error) { return LoadFile(root, ".lake/hooks.json") }

func LoadFile(root, relative string) (*Runner, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	if filepath.IsAbs(relative) || filepath.Clean(relative) != relative || strings.HasPrefix(relative, "..") {
		return nil, errors.New("Hook 声明路径无效")
	}
	path := filepath.Join(absolute, relative)
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return nil, errors.New("Hook 声明路径无效")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64*1024 {
		return nil, errors.New("Hook 配置文件无效或过大")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return nil, errors.New("Hook 配置文件读取失败或过大")
	}
	var manifest Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, errors.New("Hook 配置格式无效")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || manifest.Version != 1 || len(manifest.Hooks) == 0 || len(manifest.Hooks) > 16 {
		return nil, errors.New("Hook 配置版本或声明数量无效")
	}
	hash := sha256.New()
	hash.Write(data)
	for _, hook := range manifest.Hooks {
		if !validEvent(hook.Event) || len(hook.Args) > 16 {
			return nil, errors.New("Hook 事件或参数数量无效")
		}
		command, err := commandPath(absolute, hook.Command)
		if err != nil {
			return nil, err
		}
		file, err := os.Open(command)
		if err != nil {
			return nil, err
		}
		commandData, readErr := io.ReadAll(io.LimitReader(file, 1<<20+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || len(commandData) > 1<<20 {
			return nil, errors.New("Hook 命令文件读取失败或超过 1 MiB")
		}
		hash.Write([]byte(hook.Command))
		hash.Write([]byte{0})
		hash.Write(commandData)
		hash.Write([]byte{0})
		for _, arg := range hook.Args {
			if len(arg) > 1024 || strings.ContainsRune(arg, '\x00') {
				return nil, errors.New("Hook 参数无效")
			}
		}
	}
	return &Runner{Root: absolute, Digest: hex.EncodeToString(hash.Sum(nil)), Manifest: manifest, DeclarationPath: relative}, nil
}

type cappedBuffer struct {
	buffer    bytes.Buffer
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	const limit = 8192
	remaining := max(0, limit-b.buffer.Len())
	if len(p) > remaining {
		b.truncated = true
	}
	if remaining > 0 {
		_, _ = b.buffer.Write(p[:min(len(p), remaining)])
	}
	return len(p), nil
}

func (b *cappedBuffer) String() string { return b.buffer.String() }

func filteredEnv() []string {
	var env []string
	for _, key := range []string{"PATH", "TMPDIR", "LANG", "LC_ALL"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func checkedMeta(meta map[string]string) ([]byte, error) {
	for key, value := range meta {
		switch key {
		case "tool", "status", "sha256", "prompt_sha256", "duration_ms":
		default:
			return nil, errors.New("Hook 事件字段无效")
		}
		if len(value) > 256 {
			return nil, errors.New("Hook 事件字段过长")
		}
	}
	return json.Marshal(meta)
}

// Run rechecks the declaration digest before each event. Approval is required
// for every matching command; a denied command does not run.
func (r *Runner) Run(ctx context.Context, event Event, meta map[string]string, approve Approval) ([]Result, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !r.Enabled {
		return nil, ErrDisabled
	}
	if !validEvent(event) {
		return nil, errors.New("未知 Hook 事件")
	}
	relative := r.DeclarationPath
	if relative == "" {
		relative = ".lake/hooks.json"
	}
	current, err := LoadFile(r.Root, relative)
	if err != nil || current.Digest != r.Digest {
		return nil, ErrChanged
	}
	input, err := checkedMeta(meta)
	if err != nil {
		return nil, err
	}
	results := make([]Result, 0)
	for _, hook := range current.Manifest.Hooks {
		if hook.Event != event {
			continue
		}
		command, err := commandPath(r.Root, hook.Command)
		if err != nil {
			return results, err
		}
		result := Result{Event: event, Status: "denied"}
		if approve == nil {
			results = append(results, result)
			continue
		}
		detail := "事件: " + string(event) + "\n命令: " + hook.Command + "\n参数: " + strings.Join(hook.Args, " ") + "\n声明 SHA-256: " + r.Digest
		allowed, err := approve("hook", command, detail)
		if err != nil {
			return results, err
		}
		if !allowed {
			results = append(results, result)
			continue
		}
		latest, err := LoadFile(r.Root, relative)
		if err != nil || latest.Digest != r.Digest {
			return results, ErrChanged
		}
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		cmd := exec.CommandContext(callCtx, command, hook.Args...)
		cmd.Dir, cmd.Env = r.Root, filteredEnv()
		cmd.Stdin = bytes.NewReader(input)
		var stdout, stderr cappedBuffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		runErr := cmd.Run()
		result.Stdout, result.Stderr, result.Truncated = stdout.String(), stderr.String(), stdout.truncated || stderr.truncated
		result.Status = "completed"
		if runErr != nil {
			result.Status = "failed"
		}
		results = append(results, result)
		if err := callCtx.Err(); err != nil {
			cancel()
			return results, err
		}
		cancel()
	}
	return results, nil
}
