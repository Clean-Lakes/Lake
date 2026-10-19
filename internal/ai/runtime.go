package ai

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
func joinArgs(a []string) string {
	out := []string{}
	for _, s := range a {
		out = append(out, quote(s))
	}
	return strings.Join(out, " ")
}
func bounded(n, min, max int) int {
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}
func duration(a map[string]any) time.Duration {
	return time.Duration(bounded(num(a["timeout"], num(a["timeout_ms"], 30000)), 1, 300000)) * time.Millisecond
}

type limitBuffer struct {
	mu sync.Mutex
	bytes.Buffer
	limit int
}

func (b *limitBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	if remaining := b.limit - b.Len(); remaining > 0 {
		b.Buffer.Write(p[:min(n, remaining)])
	}
	return n, nil
}
func privateCredential(path string, roots ...string) (string, error) {
	home, _ := os.UserHomeDir()
	secretHome := os.Getenv("LAKE_HOME")
	if secretHome == "" {
		secretHome = filepath.Join(home, ".lake")
	}
	root := filepath.Join(secretHome, "secrets")
	if len(roots) > 0 && roots[0] != "" {
		root = roots[0]
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(root, path)
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", errors.New("credential directory unavailable")
	}
	rootInfo, err := os.Stat(realRoot)
	if err != nil || !platform.Private(realRoot, rootInfo) {
		return "", errors.New("credential directory must be private")
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil || !strings.HasPrefix(path, realRoot+string(filepath.Separator)) {
		return "", errors.New("credential must be under ~/.lake/secrets")
	}
	st, err := os.Stat(path)
	if err != nil || !st.Mode().IsRegular() || !platform.Private(path, st) {
		return "", errors.New("credential must be a private file")
	}
	return path, nil
}

var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$`)
var userPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`)

func sshBase(c *SSH, roots ...string) ([]string, error) {
	if c == nil || !hostPattern.MatchString(c.Host) || !userPattern.MatchString(c.Username) || c.Port < 1 || c.Port > 65535 {
		return nil, errors.New("invalid SSH target")
	}
	mode := c.AuthMethod
	if mode == "" {
		mode = "key"
	}
	if mode != "key" && mode != "password" {
		return nil, errors.New("invalid SSH authentication method")
	}
	home, _ := os.UserHomeDir()
	known := filepath.Join(home, ".ssh", "known_hosts")
	if c.KnownHosts != "" {
		known = c.KnownHosts
	}
	args := []string{"-F", "/dev/null", "-o", "StrictHostKeyChecking=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "AddKeysToAgent=no", "-o", "NumberOfPasswordPrompts=1", "-o", platform.SSHFileOption("UserKnownHostsFile", known), "-o", "ConnectTimeout=10"}
	if c.KnownHosts != "" {
		args = append(args, "-o", "GlobalKnownHostsFile=/dev/null")
	}
	root := ""
	if len(roots) > 0 {
		root = roots[0]
	}
	if c.CredentialRef != "" {
		if _, err := sshSecret(c.CredentialRef, root); err != nil {
			return nil, err
		}
	}
	if mode == "password" {
		if c.CredentialRef == "" {
			return nil, errors.New("SSH password reference required")
		}
		return append(args, "-o", "BatchMode=no", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "KbdInteractiveAuthentication=yes", "-o", "PasswordAuthentication=yes", "-o", "PubkeyAuthentication=no"), nil
	}
	path, err := privateCredential(c.IdentityFile, roots...)
	if err != nil {
		return nil, err
	}
	batch := "yes"
	if c.CredentialRef != "" {
		batch = "no"
	}
	return append(args, "-o", "BatchMode="+batch, "-o", "PreferredAuthentications=publickey", "-o", "KbdInteractiveAuthentication=no", "-o", "PasswordAuthentication=no", "-i", path), nil
}
func (e *Engine) execRuntime(ctx context.Context, c Config, a map[string]any, argv []string, input string) (map[string]any, error) {
	return e.execRuntimeInput(ctx, c, a, argv, strings.NewReader(input))
}

// Structured file adapters must not parse SSH warnings or other stderr as data.
// The fallback supports older adapters that only provided a combined output.
func runtimeStdout(result map[string]any) string {
	if stdout, ok := result["stdout"].(string); ok {
		return stdout
	}
	return str(result["output"])
}
func (e *Engine) execRuntimeInput(ctx context.Context, c Config, a map[string]any, argv []string, input io.Reader) (result map[string]any, err error) {
	processMayHaveStarted := false
	defer func() {
		if err != nil && !processMayHaveStarted {
			err = &ToolNotExecutedError{Err: err}
		}
	}()
	target := str(a["runtime"])
	if target == "" {
		target = c.Runtime
	}
	ref := str(a["asset_ref"])
	if ref == "" {
		ref = c.AssetRef
	}
	container := str(a["container_id"])
	if container == "" {
		container = c.Container
	}
	cmdline := joinArgs(argv)
	executable := argv[0]
	cmdargs := argv[1:]
	var sshTarget *SSH
	if target == "container" {
		if !containerName.MatchString(container) {
			return nil, errors.New("invalid container name")
		}
		if ref == "" || container == "" {
			return nil, errors.New("container runtime needs Docker asset_ref and container_id")
		}
		as, err := asset(c, ref)
		if err != nil || as.Kind != "docker" {
			return nil, errors.New("container target must reference Docker asset")
		}
		dockerArgs, host, err := dockerCommand(c, as, append([]string{"exec", "-i", "--", container}, argv...))
		if err != nil {
			return nil, err
		}
		executable = "docker"
		cmdargs = dockerArgs
		if host != nil {
			sshTarget = host
			base, err := sshBase(host, c.CredentialDir)
			if err != nil {
				return nil, err
			}
			executable = "ssh"
			cmdargs = append(base, "-p", fmt.Sprint(host.Port), "-l", host.Username, host.Host, joinArgs(append([]string{"docker"}, dockerArgs...)))
		}
	}
	if target == "ssh" {
		as, err := asset(c, ref)
		if err != nil || as.Kind != "ssh" {
			return nil, errors.New("SSH runtime requires a session SSH asset")
		}
		sshTarget = as.SSH
		base, err := sshBase(as.SSH, c.CredentialDir)
		if err != nil {
			return nil, err
		}
		executable = "ssh"
		cmdargs = append(base, "-p", fmt.Sprint(as.SSH.Port), "-l", as.SSH.Username, as.SSH.Host, cmdline)
	} else if target != "container" && target != "local" {
		return nil, errors.New("unknown runtime")
	}
	if target == "local" && ref != "" {
		as, err := asset(c, ref)
		if err != nil || as.Kind != "local" {
			return nil, errors.New("cannot run a remote asset locally")
		}
	}
	ctx, cancel := context.WithTimeout(ctx, duration(a))
	defer cancel()
	cmd := exec.CommandContext(ctx, platform.Executable(executable), cmdargs...)
	setupProcess(cmd)
	home, _ := os.UserHomeDir()
	cmd.Env = platform.Environment(home)
	if sshTarget != nil {
		var err error
		cmd.Env, err = sshEnvironment(sshTarget, c.CredentialDir)
		if err != nil {
			return nil, err
		}
	}
	if target == "local" && c.Workspace != "" {
		cmd.Dir = c.Workspace
	}
	cmd.Stdin = input
	outputLimit := bounded(num(a["__output_limit"], 100000), 100000, 3<<20)
	output := &limitBuffer{limit: outputLimit}
	stdout := &limitBuffer{limit: outputLimit}
	stderr := &limitBuffer{limit: outputLimit}
	cmd.Stdout = io.MultiWriter(output, stdout)
	cmd.Stderr = io.MultiWriter(output, stderr)
	// From this point failures may have an effect. Never infer non-execution
	// from a transport error, timeout or a process's output text.
	processMayHaveStarted = true
	err = cmd.Run()
	code := 0
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			return nil, errors.New("runtime process could not start")
		}
	}
	if executable == "ssh" && code == 255 {
		return nil, errors.New("SSH connection failed; verify host trust and credentials")
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("runtime interrupted; outcome unknown: %w", ctx.Err())
	}
	return map[string]any{"output": redact(output.String(), c), "stdout": redact(stdout.String(), c), "stderr": redact(stderr.String(), c), "exitCode": code, "truncated": output.Len() >= output.limit}, nil
}
func (e *Engine) command(ctx context.Context, c Config, a map[string]any, command string) (any, error) {
	if strings.TrimSpace(command) == "" || len(command) > 20000 {
		return nil, errors.New("invalid command")
	}
	if a["run_in_background"] == true {
		return e.startShell(c, a, command)
	}
	return e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", command}, "")
}
func dockerCommand(c Config, as Asset, argv []string) ([]string, *SSH, error) {
	if as.Kind != "docker" {
		return nil, nil, errors.New("not a Docker asset")
	}
	if ref := str(as.Settings["ssh_asset_ref"]); ref != "" {
		host, err := asset(c, ref)
		if err != nil || host.SSH == nil {
			return nil, nil, errors.New("Docker SSH target unavailable")
		}
		return argv, host.SSH, nil
	}
	endpoint := str(as.Settings["endpoint"])
	if endpoint == "" {
		return nil, nil, errors.New("Docker asset needs explicit endpoint or ssh_asset_ref")
	}
	if !strings.HasPrefix(endpoint, "unix://") && !strings.HasPrefix(endpoint, "tcp://") {
		return nil, nil, errors.New("Docker endpoint must use unix:// or tcp://")
	}
	return append([]string{"--host", endpoint}, argv...), nil, nil
}
func (e *Engine) docker(ctx context.Context, c Config, name string, a map[string]any) (any, error) {
	as, err := asset(c, str(a["asset_ref"]))
	if err != nil {
		return nil, err
	}
	if name != "list_docker_containers" && !containerName.MatchString(str(a["container_name"])) {
		return nil, errors.New("invalid container name")
	}
	argv := []string{}
	switch name {
	case "list_docker_containers":
		argv = []string{"ps", "-a", "--format", "{{json .}}"}
	case "docker_container_logs":
		argv = []string{"logs", "--tail", fmt.Sprint(bounded(num(a["tail_lines"], 200), 1, 1000))}
		if a["timestamps"] == true {
			argv = append(argv, "--timestamps")
		}
		argv = append(argv, "--", str(a["container_name"]))
	case "docker_container_action":
		argv = []string{str(a["action"]), "--", str(a["container_name"])}
	}
	dockerArgs, host, err := dockerCommand(c, as, argv)
	if err != nil {
		return nil, err
	}
	runtimeArgs := map[string]any{"runtime": "local"}
	exe := []string{"docker"}
	if host != nil {
		runtimeArgs["runtime"] = "ssh"
		runtimeArgs["asset_ref"] = str(as.Settings["ssh_asset_ref"])
	}
	exe = append(exe, dockerArgs...)
	result, err := e.execRuntime(ctx, c, runtimeArgs, exe, "")
	if err != nil {
		return nil, err
	}
	if num(result["exitCode"], 0) != 0 {
		return nil, errors.New("Docker command failed; inspect daemon/connection")
	}
	output := str(result["output"])
	if name == "docker_container_logs" {
		if a["show_stdout"] == false {
			output = str(result["stderr"])
		}
		if a["show_stderr"] == false {
			if a["show_stdout"] == false {
				output = ""
			} else {
				output = str(result["stdout"])
			}
		}
	}
	pattern := str(a["pattern"])
	if name == "docker_container_logs" {
		pattern = str(a["filter"])
	}
	re, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return nil, errors.New("invalid Docker filter")
	}
	lines := []string{}
	for _, line := range strings.Split(output, "\n") {
		if line != "" && re.MatchString(line) {
			lines = append(lines, line)
		}
	}
	return map[string]any{"lines": lines, "exitCode": 0}, nil
}
func safeFile(path string) error {
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") {
		return errors.New("file path must be absolute")
	}
	lower := strings.ToLower(filepath.ToSlash(filepath.Clean(path)))
	for _, part := range []string{"/.lake/secrets", "/.ssh/", "/keychains/"} {
		if strings.Contains(lower, part) {
			return errors.New("credential files cannot be accessed by model tools")
		}
	}
	return nil
}
func runtimeFile(ctx context.Context, e *Engine, c Config, a map[string]any, path string) (string, bool, error) {
	if err := safeFile(path); err != nil {
		return "", false, err
	}
	r, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", "if [ -f " + quote(path) + " ]; then cat -- " + quote(path) + "; else exit 44; fi"}, "")
	if err != nil {
		return "", false, err
	}
	code := num(r["exitCode"], 0)
	if code == 44 {
		return "", false, nil
	}
	if code != 0 {
		return "", false, errors.New("file could not be read")
	}
	if r["truncated"] == true {
		return "", false, errors.New("file exceeds editing limit")
	}
	return runtimeStdout(r), true, nil
}
func fileMutation(name string) bool {
	switch name {
	case "write", "edit", "multi_edit", "append", "delete":
		return true
	}
	return false
}
func (e *Engine) file(ctx context.Context, s *session, c Config, name string, a map[string]any) (result any, err error) {
	mutationStarted := false
	defer func() {
		if err != nil && fileMutation(name) && !mutationStarted {
			err = &ToolNotExecutedError{Err: err}
		}
	}()
	path := str(a["path"])
	if err := safeFile(path); err != nil {
		return nil, err
	}
	if err := safeConfiguredFile(c, path); err != nil {
		return nil, err
	}
	if str(a["runtime"]) == "local" || str(a["runtime"]) == "" && c.Runtime == "local" {
		real, err := filepath.EvalSymlinks(path)
		if err == nil {
			if err = safeFile(real); err != nil {
				return nil, err
			}
			if err = safeConfiguredFile(c, real); err != nil {
				return nil, err
			}
		}
	}
	if name == "read" {
		result, err := e.readFilePage(ctx, c, a)
		if err == nil && str(obj(result)["content_hash"]) != "" {
			s.mu.Lock()
			if s.state.FileReads == nil {
				s.state.FileReads = map[string]string{}
			}
			s.state.FileReads[fileReadKey(c, a)] = str(obj(result)["content_hash"])
			err = e.save(s)
			s.mu.Unlock()
		}
		return result, err
	}
	if name == "glob" || name == "grep" {
		return e.searchFiles(ctx, c, name, a)
	}
	switch name {
	case "ls":
		return e.execRuntime(ctx, c, a, []string{"ls", "-la", "--", path}, "")

	}
	before, exists, err := runtimeFile(ctx, e, c, a, path)
	if err != nil {
		return nil, err
	}

	if expected, ok := a["expected_hash"].(string); ok && expected != hash(before) {
		return nil, errors.New("file changed since read; expected_hash mismatch")
	}
	if expected, ok := a["__expected_hash"].(string); ok && (hash(before) != expected || exists != a["__expected_exists"]) {
		return nil, errors.New("file changed after preview; approval expired")
	}
	next, err := fileNext(name, before, exists, a, c)
	if err != nil {
		return nil, err
	}
	if len(next) > 100000 {
		return nil, errors.New("file exceeds editing limit")
	}
	command := ""
	if name == "delete" {
		command = "rm -- " + quote(path)
	} else {
		temp := path + ".lake-" + uid()
		command = "umask 077; mode=600; if [ -f " + quote(path) + " ]; then mode=$(stat -c '%a' -- " + quote(path) + " 2>/dev/null || stat -f '%Lp' " + quote(path) + ") || exit 1; fi; cat > " + quote(temp) + " && chmod \"$mode\" " + quote(temp) + " && mv -- " + quote(temp) + " " + quote(path)

	}
	mutationStarted = true
	out, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", command}, next)
	if err != nil {
		return nil, err
	}
	if num(out["exitCode"], 0) != 0 {
		return nil, errors.New("file update failed")
	}
	target := str(a["runtime"])
	if target == "" {
		target = c.Runtime
	}
	ref := str(a["asset_ref"])
	if ref == "" {
		ref = c.AssetRef
	}
	targetHash := "local"
	if ref != "" {
		as, err := asset(c, ref)
		if err == nil {
			targetHash = hash(js(as))
		}
	}
	undo := FileUndo{TargetHash: targetHash, Path: path, Before: before, AfterHash: hash(next), Existed: exists, Runtime: target, AssetRef: ref, Container: str(a["container_id"])}
	s.mu.Lock()
	if s.state.FileReads == nil {
		s.state.FileReads = map[string]string{}
	}
	s.state.FileReads[fileReadKey(c, a)] = hash(next)
	s.state.Undo = append(s.state.Undo, undo)
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "diff", Title: path, Data: map[string]any{"before": before, "after": next, "deleted": name == "delete", "existed": exists, "runtime": target, "assetRef": ref, "containerId": str(a["container_id"])}, Status: "completed", At: timestamp()})
	err = e.save(s)
	s.mu.Unlock()
	return map[string]any{"path": path, "before": before, "after": next, "deleted": name == "delete"}, err
}
func fileMode(path string) string {
	st, err := os.Stat(path)
	if err != nil {
		return "600"
	}
	return fmt.Sprintf("%o", st.Mode().Perm())
}
func (e *Engine) UndoFile(ctx context.Context, id string) (any, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return nil, errors.New("session busy")
	}
	if len(s.state.Undo) == 0 {
		s.mu.Unlock()
		return nil, errors.New("no file change to restore")
	}
	u := s.state.Undo[len(s.state.Undo)-1]
	c := s.state.Config
	s.mu.Unlock()
	if u.AssetRef != "" {
		as, err := asset(c, u.AssetRef)
		if err != nil || u.TargetHash != "" && hash(js(as)) != u.TargetHash {
			return nil, errors.New("file runtime target changed; restore refused")
		}
	}
	a := map[string]any{"runtime": u.Runtime, "asset_ref": u.AssetRef, "container_id": u.Container}
	current, exists, err := runtimeFile(ctx, e, c, a, u.Path)
	if err != nil {
		return nil, err
	}
	if exists && hash(current) != u.AfterHash || !exists && u.AfterHash != hash("") {
		return nil, errors.New("file changed externally; restore refused")
	}
	cmd := "rm -f -- " + quote(u.Path)
	if u.Existed {
		cmd = "cat > " + quote(u.Path)
	}
	r, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", cmd}, u.Before)
	if err != nil || num(r["exitCode"], 0) != 0 {
		return nil, errors.New("file restore failed")
	}
	s.mu.Lock()
	s.state.Undo = s.state.Undo[:len(s.state.Undo)-1]
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "diff", Title: u.Path, Data: map[string]any{"before": current, "after": u.Before, "deleted": !u.Existed, "existed": exists, "runtime": u.Runtime, "assetRef": u.AssetRef, "containerId": u.Container}, Status: "completed", At: timestamp()})
	err = e.save(s)
	s.mu.Unlock()
	return map[string]any{"restored": u.Path}, err
}

var _ io.Writer = (*limitBuffer)(nil)

func safeLocalFile(path string) error {
	if err := safeFile(path); err != nil {
		return err
	}
	candidate := path
	for {
		real, err := filepath.EvalSymlinks(candidate)
		if err == nil {
			return safeFile(filepath.Join(real, strings.TrimPrefix(path, candidate)))
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return nil
		}
		candidate = parent
	}
}

func fileNext(name, before string, exists bool, a map[string]any, c Config) (string, error) {
	if redact(before, c) != before {
		return "", errors.New("file contains credentials; generic file edits are refused")
	}
	next := str(a["content"])
	if redact(next, c) != next {
		return "", errors.New("file content cannot contain credentials")
	}
	switch name {
	case "edit":
		if !exists || str(a["old_string"]) == "" || strings.Count(before, str(a["old_string"])) != 1 {
			return "", errors.New("edit requires one exact old_string match")
		}
		next = strings.Replace(before, str(a["old_string"]), str(a["new_string"]), 1)
	case "multi_edit":
		next = before
		for _, v := range arr(a["edits"]) {
			edit := obj(v)
			old := str(edit["old_string"])
			if old == "" || strings.Count(next, old) != 1 {
				return "", errors.New("multi_edit requires unique exact matches")
			}
			next = strings.Replace(next, old, str(edit["new_string"]), 1)
		}
	case "append":
		next = before + next
	case "delete":
		next = ""
	}
	return next, nil
}
func (e *Engine) filePreview(ctx context.Context, c Config, name string, a map[string]any) (map[string]any, error) {
	path := str(a["path"])
	runtime := str(a["runtime"])
	if runtime == "" {
		runtime = c.Runtime
	}
	if runtime == "local" {
		if err := safeLocalFile(path); err != nil {
			return nil, err
		}
	}
	before, exists, err := runtimeFile(ctx, e, c, a, path)
	if err != nil {
		return nil, err
	}
	after, err := fileNext(name, before, exists, a, c)
	if err != nil {
		return nil, err
	}
	return map[string]any{"before": before, "after": after, "existed": exists}, nil
}

var containerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$`)

func safeConfiguredFile(c Config, path string) error {
	if c.CredentialDir == "" {
		return nil
	}
	root := c.CredentialDir
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	rel, err := filepath.Rel(root, path)
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("credential files cannot be accessed by model tools")
	}
	return nil
}
