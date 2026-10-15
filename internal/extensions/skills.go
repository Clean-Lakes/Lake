package extensions

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Source      string `json:"source"`
	Enabled     bool   `json:"enabled"`
	Managed     bool   `json:"managed"`
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func (s *Store) safePath(path string) bool {
	lower := strings.ToLower(filepath.ToSlash(path))
	for _, part := range []string{"/.ssh/", "/keychains/", "/.lake/secrets", "/.lake-dev/secrets"} {
		if strings.Contains(lower, part) {
			return false
		}
	}
	private, _ := filepath.EvalSymlinks(filepath.Join(s.Home, "secrets"))
	return private == "" || !within(private, path)
}
func (s *Store) ScanSkills(workspace string) ([]Skill, error) {
	c, err := s.Read()
	if err != nil {
		return nil, err
	}
	roots := []string{}
	if workspace != "" {
		roots = append(roots, filepath.Join(workspace, ".agents", "skills"), filepath.Join(workspace, ".lake", "skills"))
	}
	roots = append(roots, filepath.Join(s.Home, "skills"))
	roots = append(roots, c.SkillRoots...)
	disabled := map[string]bool{}
	for _, n := range c.DisabledSkills {
		disabled[n] = true
	}
	seen := map[string]bool{}
	result := []Skill{}
	for _, root := range roots {
		real, err := filepath.EvalSymlinks(root)
		if err != nil || !s.safePath(real) {
			continue
		}
		entries, err := os.ReadDir(real)
		if err != nil {
			continue
		}
		if len(entries) > 1000 {
			entries = entries[:1000]
		}
		// A registered directory may be either a skill root or one skill directory.
		candidates := []string{}
		if st, err := os.Stat(filepath.Join(real, "SKILL.md")); err == nil && st.Mode().IsRegular() {
			candidates = append(candidates, real)
		} else {
			for _, entry := range entries {
				if Identifier.MatchString(entry.Name()) {
					candidates = append(candidates, filepath.Join(real, entry.Name()))
				}
			}
		}
		for _, base := range candidates {
			name := filepath.Base(base)
			if !Identifier.MatchString(name) || seen[name] {
				continue
			}
			path, err := filepath.EvalSymlinks(filepath.Join(base, "SKILL.md"))
			if err != nil || !within(real, path) || !s.safePath(path) {
				continue
			}
			st, err := os.Stat(path)
			if err != nil || !st.Mode().IsRegular() || st.Size() > 100000 {
				continue
			}
			raw, err := os.ReadFile(path)
			if err != nil || !utf8.Valid(raw) {
				continue
			}
			description := ""
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "description:") {
					description = strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "description:")), "\"'")
					break
				}
			}
			if len([]rune(description)) > 180 {
				description = string([]rune(description)[:180])
			}
			managed := filepath.Clean(path) == filepath.Join(s.Home, "skills", name, "SKILL.md")
			source := "导入目录"
			if managed {
				source = "Lake"
			} else if workspace != "" && within(workspace, path) {
				source = "工作区"
			}
			result = append(result, Skill{Name: name, Description: description, Path: path, Source: source, Managed: managed, Enabled: !disabled[name]})
			seen[name] = true
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
func (s *Store) ReadSkill(name, workspace string) (Skill, string, error) {
	list, err := s.ScanSkills(workspace)
	if err != nil {
		return Skill{}, "", err
	}
	for _, v := range list {
		if v.Name == name {
			b, err := os.ReadFile(v.Path)
			if err != nil || len(b) > 100000 {
				return v, "", errors.New("无法读取 Skill")
			}
			return v, string(b), nil
		}
	}
	return Skill{}, "", errors.New("Skill 不存在")
}
func (s *Store) SaveSkill(name, content string, create bool) error {
	s.skillMu.Lock()
	defer s.skillMu.Unlock()
	if !Identifier.MatchString(name) || strings.TrimSpace(content) == "" || !utf8.ValidString(content) || len(content) > 100000 {
		return errors.New("Skill 名称仅支持字母、数字、点、横线和下划线；内容须为 1～100000 字节")
	}
	root := filepath.Join(s.Home, "skills")
	dir := filepath.Join(root, name)
	path := filepath.Join(dir, "SKILL.md")
	if create {
		list, err := s.ScanSkills("")
		if err != nil {
			return err
		}
		for _, v := range list {
			if strings.EqualFold(v.Name, name) {
				return errors.New("已存在同名 Skill")
			}
		}
	} else {
		v, _, err := s.ReadSkill(name, "")
		if err != nil || !v.Managed {
			return errors.New("只能在这里编辑 Lake 管理的 Skill")
		}
	}
	if err := platform.MkdirAll(root, 0700); err != nil {
		return errors.New("无法创建 Skill 根目录")
	}
	rootInfo, rootErr := os.Lstat(root)
	if rootErr != nil || !rootInfo.IsDir() || !platform.Owned(rootInfo) {
		return errors.New("Skill 根目录不能是符号链接或其他用户的目录")
	}
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return errors.New("无法创建 Skill 目录")
	}

	real, err := filepath.EvalSymlinks(dir)
	realRoot, rootErr := filepath.EvalSymlinks(root)
	if err != nil || rootErr != nil || realRoot != root || real != dir || !within(realRoot, real) || !s.safePath(real) {
		return errors.New("Skill 路径无效")
	}
	if st, err := os.Lstat(path); err == nil && !st.Mode().IsRegular() {
		return errors.New("Skill 文件不能是符号链接")
	}
	temp, err := os.CreateTemp(real, ".skill-*")
	if err != nil {
		return errors.New("无法保存 Skill")
	}
	defer os.Remove(temp.Name())
	err = platform.Chmod(temp.Name(), 0600)
	if err == nil {
		_, err = temp.WriteString(content)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = platform.ReplaceFile(temp.Name(), path)
	}
	if err != nil {
		return errors.New("无法保存 Skill")
	}
	return platform.SyncDirectory(real)
}
func (s *Store) SetSkillEnabled(name string, enabled bool) error {
	if !Identifier.MatchString(name) {
		return errors.New("Skill 名称无效")
	}
	return s.Update(func(c *Config) error {
		next := []string{}
		for _, n := range c.DisabledSkills {
			if n != name {
				next = append(next, n)
			}
		}
		if !enabled {
			next = append(next, name)
		}
		c.DisabledSkills = next
		return nil
	})
}
func (s *Store) AddSkillRoot(path string) error {
	if strings.HasPrefix(path, "~/") {
		h, _ := os.UserHomeDir()
		path = filepath.Join(h, path[2:])
	}
	if !filepath.IsAbs(path) {
		return errors.New("请输入 Skill 目录的绝对路径")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || !s.safePath(real) {
		return errors.New("Skill 目录不存在或不可访问")
	}
	st, err := os.Stat(real)
	if err != nil || !st.IsDir() {
		return errors.New("请选择目录")
	}
	return s.Update(func(c *Config) error {
		for _, v := range c.SkillRoots {
			if v == real {
				return nil
			}
		}
		if len(c.SkillRoots) >= 30 {
			return errors.New("最多导入 30 个 Skill 目录")
		}
		c.SkillRoots = append(c.SkillRoots, real)
		return nil
	})
}
func (s *Store) RemoveSkillRoot(path string) error {
	return s.Update(func(c *Config) error {
		next := []string{}
		for _, v := range c.SkillRoots {
			if v != path {
				next = append(next, v)
			}
		}
		c.SkillRoots = next
		return nil
	})
}
