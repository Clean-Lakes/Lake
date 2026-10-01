// Package skills discovers local Skills without granting them tool permissions.
package skills

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

const maxSkillBytes = 16 * 1024

var ErrNotFound = errors.New("Skill 不存在")

var validName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
	Path        string `json:"path"`
	Body        string `json:"body,omitempty"`
	SHA256      string `json:"sha256"`
}

type frontMatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

func skillDir(userRoot, projectRoot, scope string) string {
	if scope == "project" {
		return filepath.Join(projectRoot, ".lake", "skills")
	}
	return filepath.Join(userRoot, "skills")
}

func readSkill(dir, scope, name string) (Skill, error) {
	if !validName.MatchString(name) {
		return Skill{}, errors.New("Skill 名称只能使用小写字母、数字、- 或 _")
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Skill{}, errors.New("Skill 根目录无效")
	}
	folder := filepath.Join(dir, name)
	info, err = os.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Skill{}, errors.New("Skill 目录无效")
	}
	path := filepath.Join(folder, "SKILL.md")
	info, err = os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxSkillBytes {
		return Skill{}, errors.New("Skill 文件不存在、类型无效或超过 16 KiB")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return Skill{}, err
	}
	defer root.Close()
	f, err := root.Open(filepath.Join(name, "SKILL.md"))
	if err != nil {
		return Skill{}, errors.New("Skill 文件不在允许目录内")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxSkillBytes+1))
	if err != nil || len(data) > maxSkillBytes {
		return Skill{}, errors.New("Skill 文件读取失败或超过 16 KiB")
	}
	content := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(content, "---\n") {
		return Skill{}, errors.New("Skill 缺少 YAML front matter")
	}
	parts := strings.SplitN(strings.TrimPrefix(content, "---\n"), "\n---\n", 2)
	if len(parts) != 2 {
		return Skill{}, errors.New("Skill front matter 未结束")
	}
	var meta frontMatter
	if err := yaml.Unmarshal([]byte(parts[0]), &meta); err != nil {
		return Skill{}, errors.New("Skill front matter 格式无效")
	}
	body := strings.TrimSpace(parts[1])
	if meta.Name != name || strings.TrimSpace(meta.Description) == "" || len(meta.Description) > 500 || body == "" {
		return Skill{}, errors.New("Skill 名称、说明或正文无效")
	}
	digest := sha256.Sum256(data)
	return Skill{Name: name, Description: strings.TrimSpace(meta.Description), Scope: scope, Path: path, Body: body, SHA256: hex.EncodeToString(digest[:])}, nil
}

func scan(dir, scope string) ([]Skill, error) {
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Skill 根目录无效")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	if len(entries) > 100 {
		return nil, errors.New("Skill 数量超过 100")
	}
	var result []Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			if entry.Type()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("Skill 目录不能是符号链接: %s", entry.Name())
			}
			continue
		}
		skill, err := readSkill(dir, scope, entry.Name())
		if err != nil {
			return nil, fmt.Errorf("Skill %s: %w", entry.Name(), err)
		}
		result = append(result, skill)
	}
	return result, nil
}

// Discover lists both scopes. A project Skill shadows a user Skill when loaded.
func Discover(userRoot, projectRoot string) ([]Skill, error) {
	user, err := scan(skillDir(userRoot, "", "user"), "user")
	if err != nil {
		return nil, err
	}
	if projectRoot == "" {
		return user, nil
	}
	project, err := scan(skillDir("", projectRoot, "project"), "project")
	if err != nil {
		return nil, err
	}
	return append(project, user...), nil
}

// Load reads only the selected Skill, preferring the bound project's version.
func Load(userRoot, projectRoot, name string) (Skill, error) {
	if !validName.MatchString(name) {
		return Skill{}, errors.New("Skill 名称无效")
	}
	if projectRoot != "" {
		dir := skillDir("", projectRoot, "project")
		if _, err := os.Lstat(filepath.Join(dir, name)); err == nil {
			return readSkill(dir, "project", name)
		} else if !errors.Is(err, os.ErrNotExist) {
			return Skill{}, err
		}
	}
	dir := skillDir(userRoot, "", "user")
	if _, err := os.Lstat(filepath.Join(dir, name)); errors.Is(err, os.ErrNotExist) {
		return Skill{}, fmt.Errorf("%w: %q", ErrNotFound, name)
	} else if err != nil {
		return Skill{}, err
	}
	return readSkill(dir, "user", name)
}
