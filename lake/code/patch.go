package code

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pmezard/go-difflib/difflib"
)

const maxPatchFileBytes = 1024 * 1024
const maxPatchFiles = 8

type PatchFile struct {
	Path    string `json:"path"`
	Content string `json:"content,omitempty"`
	Delete  bool   `json:"delete,omitempty"`
}

type PatchPreview struct {
	ProjectRoot string          `json:"project_root"`
	Changes     []ChangePreview `json:"changes"`
	Diff        string          `json:"diff"`
}

func (w *Workspace) patchTarget(relative string) (string, []byte, os.FileMode, bool, error) {
	if relative == "" || filepath.IsAbs(relative) {
		return "", nil, 0, false, errors.New("请提供项目内的相对路径")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || sensitivePath(clean) {
		return "", nil, 0, false, errors.New("不能修改项目外或敏感路径")
	}
	parent := w.Root
	if filepath.Dir(clean) != "." {
		var err error
		parent, err = w.resolve(filepath.Dir(clean))
		if err != nil {
			return "", nil, 0, false, err
		}
	}
	info, err := os.Stat(parent)
	if err != nil || !info.IsDir() {
		return "", nil, 0, false, errors.New("目标父目录不存在")
	}
	path := filepath.Join(parent, filepath.Base(clean))
	info, err = os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return path, nil, 0600, false, nil
	}
	if err != nil {
		return "", nil, 0, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPatchFileBytes {
		return "", nil, 0, false, errors.New("只能修改不超过 1 MiB 的普通文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nil, 0, false, err
	}
	if len(data) > maxPatchFileBytes || bytes.IndexByte(data, 0) >= 0 {
		return "", nil, 0, false, errors.New("不能修改二进制或超过 1 MiB 的文件")
	}
	return path, data, info.Mode().Perm(), true, nil
}

func (w *Workspace) PreviewPatch(files []PatchFile) (PatchPreview, error) {
	if w == nil || len(files) == 0 || len(files) > maxPatchFiles {
		return PatchPreview{}, errors.New("一次只能修改 1 到 8 个文件")
	}
	preview := PatchPreview{ProjectRoot: w.Root, Changes: make([]ChangePreview, 0, len(files))}
	seen := make(map[string]bool)
	var diff strings.Builder
	for _, file := range files {
		clean := filepath.Clean(file.Path)
		if seen[clean] {
			return PatchPreview{}, errors.New("同一文件不能在一次修改中出现两次")
		}
		seen[clean] = true
		_, before, _, exists, err := w.patchTarget(clean)
		if err != nil {
			return PatchPreview{}, err
		}
		if file.Delete && !exists {
			return PatchPreview{}, fmt.Errorf("文件 %s 不存在，无法删除", clean)
		}
		if len(file.Content) > maxPatchFileBytes || strings.IndexByte(file.Content, 0) >= 0 {
			return PatchPreview{}, errors.New("修改后的文件必须是不超过 1 MiB 的文本")
		}
		if !file.Delete && exists && string(before) == file.Content {
			return PatchPreview{}, fmt.Errorf("文件 %s 内容没有变化", clean)
		}
		change := ChangePreview{Path: filepath.ToSlash(clean), Before: string(before), After: file.Content, Created: !exists, Deleted: file.Delete}
		from, to := "a/"+change.Path, "b/"+change.Path
		if change.Created {
			from = "/dev/null"
		}
		if change.Deleted {
			to = "/dev/null"
		}
		after := change.After
		if change.Deleted {
			after = ""
		}
		patch, err := difflib.GetUnifiedDiffString(difflib.UnifiedDiff{A: difflib.SplitLines(change.Before), B: difflib.SplitLines(after), FromFile: from, ToFile: to, Context: 3})
		if err != nil {
			return PatchPreview{}, err
		}
		diff.WriteString(patch)
		preview.Changes = append(preview.Changes, change)
	}
	preview.Diff = diff.String()
	return preview, nil
}
