package code

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	maxFileBytes    = 256 * 1024
	maxScannedFiles = 20000
	maxOutputBytes  = 64 * 1024
)

type Workspace struct{ Root string }

type SearchHit struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}
type ReadResult struct {
	Path      string   `json:"path"`
	StartLine int      `json:"start_line"`
	Lines     []string `json:"lines"`
	Truncated bool     `json:"truncated"`
}

func Open(path string) (*Workspace, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("代码项目路径不能为空")
	}
	root, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	if sensitivePath(root) {
		return nil, errors.New("不能把凭据或应用内部目录作为代码项目")
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("代码项目路径必须是目录")
	}
	return &Workspace{Root: root}, nil
}

func (w *Workspace) resolve(relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) {
		return "", errors.New("请提供项目内的相对路径")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("路径超出代码项目")
	}
	if sensitivePath(clean) {
		return "", errors.New("该文件属于凭据或项目内部数据，不能读取")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(w.Root, clean))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(w.Root, path)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("符号链接指向项目外部")
	}
	if sensitivePath(rel) {
		return "", errors.New("该文件属于凭据或项目内部数据，不能读取")
	}
	return path, nil
}

func sensitivePath(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		lower := strings.ToLower(part)
		if lower == ".git" || lower == ".lake" || lower == ".ssh" || lower == "secrets" || lower == "id_rsa" || lower == "id_ed25519" || lower == ".env" || strings.HasPrefix(lower, ".env.") && !strings.HasSuffix(lower, ".example") || strings.HasSuffix(lower, ".pem") || strings.HasSuffix(lower, ".key") {
			return true
		}
	}
	return false
}

func skipDefault(path string, isDir bool) bool {
	if sensitivePath(path) {
		return true
	}
	if !isDir {
		return false
	}
	base := strings.ToLower(filepath.Base(path))
	switch base {
	case ".git", "node_modules", ".next", ".venv", "vendor", "dist", "build", "coverage", ".cache":
		return true
	}
	return false
}

func (w *Workspace) walk(ctx context.Context, visit func(path, relative string, entry os.DirEntry) error) error {
	scanned := 0
	return filepath.WalkDir(w.Root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == w.Root {
			return nil
		}
		rel, err := filepath.Rel(w.Root, path)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if skipDefault(rel, entry.IsDir()) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		scanned++
		if scanned > maxScannedFiles {
			return errors.New("项目文件过多；请缩小查询范围")
		}
		return visit(path, filepath.ToSlash(rel), entry)
	})
}

func (w *Workspace) List(ctx context.Context, filter string, limit int) ([]string, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	filter = strings.ToLower(strings.TrimSpace(filter))
	out := make([]string, 0)
	errStop := errors.New("enough files")
	err := w.walk(ctx, func(_, rel string, _ os.DirEntry) error {
		if filter != "" && !strings.Contains(strings.ToLower(rel), filter) {
			return nil
		}
		out = append(out, rel)
		if len(out) >= limit {
			return errStop
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func (w *Workspace) Read(relative string, offset, limit int) (ReadResult, error) {
	path, err := w.resolve(relative)
	if err != nil {
		return ReadResult{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ReadResult{}, err
	}
	if !info.Mode().IsRegular() {
		return ReadResult{}, errors.New("只能读取普通文件")
	}
	if info.Size() > maxFileBytes {
		return ReadResult{}, fmt.Errorf("文件超过 %d KB，请缩小范围", maxFileBytes/1024)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ReadResult{}, err
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return ReadResult{}, errors.New("不能读取二进制文件")
	}
	if offset < 1 {
		offset = 1
	}
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	if offset > len(lines) {
		return ReadResult{Path: relative, StartLine: offset, Lines: []string{}}, nil
	}
	end := offset - 1 + limit
	if end > len(lines) {
		end = len(lines)
	}
	out := make([]string, 0, end-offset+1)
	for i := offset - 1; i < end; i++ {
		line := lines[i]
		if len(line) > 4096 {
			line = line[:4096] + "…"
		}
		out = append(out, fmt.Sprintf("%d: %s", i+1, line))
	}
	return ReadResult{Path: relative, StartLine: offset, Lines: out, Truncated: end < len(lines)}, nil
}

func (w *Workspace) Search(ctx context.Context, expression string, limit int) ([]SearchHit, error) {
	if len(expression) > 500 {
		return nil, errors.New("搜索表达式过长")
	}
	re, err := regexp.Compile(expression)
	if err != nil {
		return nil, fmt.Errorf("无效的正则表达式: %w", err)
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	hits := make([]SearchHit, 0)
	errStop := errors.New("enough matches")
	err = w.walk(ctx, func(path, rel string, entry os.DirEntry) error {
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > maxFileBytes {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		reader := bufio.NewReader(f)
		for lineNo := 1; ; lineNo++ {
			line, err := reader.ReadString('\n')
			if len(line) > 0 && len(line) <= 8192 && strings.IndexByte(line, 0) < 0 && re.MatchString(line) {
				text := strings.TrimRight(line, "\r\n")
				if len(text) > 500 {
					text = text[:500] + "…"
				}
				hits = append(hits, SearchHit{Path: rel, Line: lineNo, Text: text})
				if len(hits) >= limit {
					return errStop
				}
			}
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	return hits, nil
}

func (w *Workspace) GitStatus(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", "-C", w.Root, "status", "--short", "--untracked-files=normal")
	output, err := command.CombinedOutput()
	if len(output) > maxOutputBytes {
		output = append(output[:maxOutputBytes], []byte("\n…输出已截断")...)
	}
	if err != nil {
		return "", fmt.Errorf("读取 Git 状态: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
