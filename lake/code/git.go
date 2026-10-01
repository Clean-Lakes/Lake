package code

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type GitFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type GitCommit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
}

type GitOverview struct {
	Branch  string      `json:"branch"`
	Files   []GitFile   `json:"files"`
	Commits []GitCommit `json:"commits"`
	Graph   string      `json:"graph"`
}

func (w *Workspace) git(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", append([]string{"-C", w.Root, "--no-pager", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"}, args...)...)
	command.Env = []string{"PATH=/usr/bin:/bin:/usr/local/bin", "GIT_OPTIONAL_LOCKS=0", "GIT_CONFIG_NOSYSTEM=1"}
	output, err := command.CombinedOutput()
	if len(output) > maxOutputBytes {
		return nil, errors.New("Git 输出超过 64 KiB，请缩小范围")
	}
	if err != nil {
		return nil, fmt.Errorf("Git 命令失败: %w", err)
	}
	return output, nil
}

// GitOverview reads only metadata for paths inside the registered workspace.
func (w *Workspace) GitOverview(ctx context.Context) (GitOverview, error) {
	status, err := w.git(ctx, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".")
	if err != nil {
		return GitOverview{}, err
	}
	branch, err := w.git(ctx, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		branch = []byte("(detached)")
	}
	result := GitOverview{Branch: strings.TrimSpace(string(branch)), Files: []GitFile{}, Commits: []GitCommit{}}
	entries := bytes.Split(status, []byte{0})
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 || entry[2] != ' ' {
			continue
		}
		code, path := string(entry[:2]), string(entry[3:])
		if (code[0] == 'R' || code[0] == 'C' || code[1] == 'R' || code[1] == 'C') && i+1 < len(entries) {
			// Porcelain -z includes the second path after a rename/copy.
			i++
		}
		if w.allowedGitPath(path) {
			result.Files = append(result.Files, GitFile{Path: path, Status: code})
		}
		if len(result.Files) >= 200 {
			break
		}
	}
	log, err := w.git(ctx, "log", "-20", "-z", "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00", "--", ".")
	if err != nil {
		// An empty repository has no commits; status is still useful.
		return result, nil
	}
	fields := bytes.Split(log, []byte{0})
	for i := 0; i+4 < len(fields) && len(result.Commits) < 20; {
		hash := strings.TrimSpace(string(fields[i]))
		if hash == "" {
			i++
			continue
		}
		result.Commits = append(result.Commits, GitCommit{Hash: hash, Short: string(fields[i+1]), Subject: string(fields[i+2]), Author: string(fields[i+3]), Date: string(fields[i+4])})
		i += 5
	}
	graph, err := w.git(ctx, "log", "--graph", "--all", "--oneline", "--decorate=short", "--no-color", "-20", "--", ".")
	if err == nil {
		result.Graph = string(graph)
	}
	return result, nil
}

func (w *Workspace) GitDiffForPath(ctx context.Context, relative string) (string, error) {
	if !w.allowedGitPath(relative) {
		return "", errors.New("Git 路径超出项目或包含敏感文件")
	}
	output, err := w.git(ctx, "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--", relative)
	if err != nil {
		return "", err
	}
	staged, err := w.git(ctx, "--literal-pathspecs", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--", relative)
	if err != nil {
		return "", err
	}
	combined := append(output, staged...)
	if len(combined) > maxOutputBytes {
		return "", errors.New("Git 差异超过 64 KiB")
	}
	if len(combined) > 0 {
		return string(combined), nil
	}
	if _, err := w.git(ctx, "--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative); err == nil {
		return "", nil
	}
	path, err := w.resolve(relative)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > maxOutputBytes/2 {
		return "", errors.New("未跟踪文件不是有界文本文件")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return "", errors.New("不能展示二进制文件")
	}
	var diff strings.Builder
	fmt.Fprintf(&diff, "diff --git a/%s b/%s\nnew file mode 100644\n--- /dev/null\n+++ b/%s\n", relative, relative, relative)
	for _, line := range strings.SplitAfter(string(content), "\n") {
		if line != "" {
			diff.WriteByte('+')
			diff.WriteString(line)
		}
	}
	if diff.Len() > maxOutputBytes {
		return "", errors.New("Git 差异超过 64 KiB")
	}
	return diff.String(), nil
}
