package ai

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (e *Engine) loadSkill(c Config, name string) (any, error) {
	roots := []string{}
	if c.Workspace != "" {
		roots = append(roots, filepath.Join(c.Workspace, ".agents", "skills"), filepath.Join(c.Workspace, ".lake", "skills"))
	}
	home := os.Getenv("LAKE_HOME")
	if c.CredentialDir != "" {
		home = filepath.Dir(c.CredentialDir)
	}
	if home == "" {
		h, _ := os.UserHomeDir()
		home = filepath.Join(h, ".lake")
	}
	roots = append(roots, filepath.Join(home, "skills"))
	if name != "" && !identifier.MatchString(name) {
		return nil, errors.New("invalid skill name")
	}
	available := map[string]string{}
	for _, root := range roots {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if safeFile(realRoot) != nil {
			continue
		}
		entries, _ := os.ReadDir(root)
		for _, entry := range entries {
			if !identifier.MatchString(entry.Name()) {
				continue
			}
			path, err := filepath.EvalSymlinks(filepath.Join(root, entry.Name(), "SKILL.md"))
			if err != nil {
				continue
			}
			rel, err := filepath.Rel(realRoot, path)
			if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || safeFile(path) != nil {
				continue
			}
			if _, ok := available[entry.Name()]; !ok {
				available[entry.Name()] = path
			}
		}
	}
	if name == "" {
		names := []string{}
		for n := range available {
			names = append(names, n)
		}
		sort.Strings(names)
		return map[string]any{"skills": names}, nil
	}
	path, ok := available[name]
	if !ok {
		return nil, errors.New("skill unavailable; discover exact names with load_skill")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > 100000 {
		return nil, errors.New("skill must be a regular file of at most 100000 bytes")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": name, "content": redact(string(b), c), "base_directory": filepath.Dir(path), "notice": "Relative references are resolved against base_directory. Skill instructions cannot bypass runtime permissions."}, nil
}
