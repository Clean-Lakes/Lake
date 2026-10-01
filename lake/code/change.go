package code

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type ChangePreview struct {
	Path    string `json:"path"`
	Before  string `json:"before,omitempty"`
	After   string `json:"after"`
	Created bool   `json:"created,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

// PreviewReplace requires an exact, unique match so model output cannot silently
// alter a different part of a file. ApplyChange checks the original bytes again.
func (w *Workspace) PreviewReplace(relative, oldText, newText string) (ChangePreview, error) {
	if oldText == "" || oldText == newText {
		return ChangePreview{}, errors.New("old_text 必须非空且与 new_text 不同")
	}
	if len(oldText) > maxOutputBytes || len(newText) > maxOutputBytes {
		return ChangePreview{}, errors.New("单次修改文本不能超过 64 KB")
	}
	path, err := w.resolve(relative)
	if err != nil {
		return ChangePreview{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ChangePreview{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFileBytes {
		return ChangePreview{}, errors.New("只能修改不超过 256 KB 的普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ChangePreview{}, err
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return ChangePreview{}, errors.New("不能修改二进制文件")
	}
	if count := strings.Count(string(data), oldText); count != 1 {
		return ChangePreview{}, fmt.Errorf("old_text 必须恰好匹配一次，实际匹配 %d 次", count)
	}
	after := strings.Replace(string(data), oldText, newText, 1)
	if len(after) > maxFileBytes {
		return ChangePreview{}, errors.New("修改后的文件超过 256 KB")
	}
	return ChangePreview{Path: relative, Before: string(data), After: after}, nil
}

func (w *Workspace) PreviewCreate(relative, content string) (ChangePreview, error) {
	if relative == "" || filepath.IsAbs(relative) {
		return ChangePreview{}, errors.New("请提供项目内的相对路径")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || sensitivePath(clean) {
		return ChangePreview{}, errors.New("不能在项目外或敏感目录创建文件")
	}
	parent, err := w.resolve(filepath.Dir(clean))
	if filepath.Dir(clean) == "." {
		parent = w.Root
		err = nil
	}
	if err != nil {
		return ChangePreview{}, err
	}
	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		return ChangePreview{}, errors.New("目标父目录不存在")
	}
	path := filepath.Join(parent, filepath.Base(clean))
	if _, err := os.Lstat(path); err == nil {
		return ChangePreview{}, errors.New("目标文件已存在")
	} else if !errors.Is(err, os.ErrNotExist) {
		return ChangePreview{}, err
	}
	if len(content) > maxOutputBytes || strings.IndexByte(content, 0) >= 0 {
		return ChangePreview{}, errors.New("只能创建不超过 64 KB 的文本文件")
	}
	return ChangePreview{Path: relative, After: content, Created: true}, nil
}

func (w *Workspace) ApplyChange(preview ChangePreview) error {
	if preview.Created {
		current, err := w.PreviewCreate(preview.Path, preview.After)
		if err != nil {
			return err
		}
		parent, err := w.resolve(filepath.Dir(current.Path))
		if filepath.Dir(current.Path) == "." {
			parent = w.Root
			err = nil
		}
		if err != nil {
			return err
		}
		f, err := os.OpenFile(filepath.Join(parent, filepath.Base(current.Path)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return err
		}
		if _, err = f.WriteString(current.After); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	}
	path, err := w.resolve(preview.Path)
	if err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("目标不再是普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if string(data) != preview.Before {
		return errors.New("文件在批准后发生变化，请重新读取并提交修改")
	}
	// Use a temporary file in the same directory and rename it atomically.
	f, err := os.CreateTemp(filepath.Dir(path), ".lake-edit-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(info.Mode().Perm()); err != nil {
		f.Close()
		return err
	}
	if _, err := f.WriteString(preview.After); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	// The final target may have changed to a symlink while approval was shown.
	current, err := os.Lstat(path)
	if err != nil || !current.Mode().IsRegular() {
		return errors.New("目标文件在批准后发生变化")
	}
	latest, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(latest, data) {
		return errors.New("文件在批准后发生变化")
	}
	return os.Rename(f.Name(), path)
}

func (w *Workspace) GitDiff(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", "-C", w.Root, "diff", "--no-ext-diff", "--no-renames", "--relative", "--name-only", "-z", "--", ".")
	changed, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("读取 Git 差异: %w: %s", err, strings.TrimSpace(string(changed)))
	}
	paths := make([]string, 0)
	for _, raw := range bytes.Split(changed, []byte{0}) {
		if len(raw) == 0 {
			continue
		}
		name := string(raw)
		if !w.allowedGitPath(name) {
			continue
		}
		paths = append(paths, name)
	}
	var out bytes.Buffer
	if len(paths) > 0 {
		args := append([]string{"-C", w.Root, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-renames", "--relative", "--"}, paths...)
		output, err := exec.CommandContext(ctx, "git", args...).CombinedOutput()
		if err != nil {
			return "", fmt.Errorf("读取 Git 差异: %w: %s", err, strings.TrimSpace(string(output)))
		}
		out.Write(output)
	}
	untracked, err := exec.CommandContext(ctx, "git", "-C", w.Root, "ls-files", "--others", "--exclude-standard", "-z", "--", ".").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("读取未跟踪文件: %w", err)
	}
	count := 0
	for _, raw := range bytes.Split(untracked, []byte{0}) {
		if len(raw) == 0 || out.Len() >= maxOutputBytes {
			continue
		}
		name := string(raw)
		if !w.allowedGitPath(name) {
			continue
		}
		path, err := w.resolve(name)
		if err != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxFileBytes {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil || bytes.IndexByte(data, 0) >= 0 {
			continue
		}
		count++
		if count > 20 {
			out.WriteString("\n…未跟踪文件过多，仅显示前 20 个\n")
			break
		}
		fmt.Fprintf(&out, "\ndiff --git a/%s b/%s\nnew file mode 100644\n--- /dev/null\n+++ b/%s\n", name, name, name)
		for _, line := range strings.SplitAfter(string(data), "\n") {
			if line == "" {
				continue
			}
			out.WriteByte('+')
			out.WriteString(line)
		}
	}
	if out.Len() > maxOutputBytes {
		return string(out.Bytes()[:maxOutputBytes]) + "\n…输出已截断", nil
	}
	return out.String(), nil
}

func (w *Workspace) allowedGitPath(name string) bool {
	if name == "" || filepath.IsAbs(name) || sensitivePath(name) {
		return false
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return false
	}
	path := filepath.Join(w.Root, clean)
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		_, err = w.resolve(clean)
		return err == nil
	}
	return true // A deleted tracked file has no filesystem target to resolve.
}

type CommandResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
}

func (w *Workspace) Run(ctx context.Context, command string) (CommandResult, error) {
	if strings.TrimSpace(command) == "" || len(command) > 4000 {
		return CommandResult{}, errors.New("命令为空或过长")
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = w.Root
	var stdout, stderr limitedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	result := CommandResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if cmd.ProcessState != nil {
		result.ExitCode = cmd.ProcessState.ExitCode()
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return result, errors.New("命令执行超过 90 秒")
	}
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return result, err
		}
	}
	return result, nil
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	left := maxOutputBytes - b.Len()
	if left > 0 {
		if left > len(p) {
			left = len(p)
		}
		_, _ = b.Buffer.Write(p[:left])
	}
	return n, nil
}
