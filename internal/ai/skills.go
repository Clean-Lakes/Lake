package ai

import (
	"errors"
	"github.com/Clean-Lakes/Lake/internal/extensions"
	"path/filepath"
)

func (e *Engine) loadSkill(c Config, name string) (any, error) {
	store := extensions.NewStore(skillHome(c))
	skills, err := store.ScanSkills(c.Workspace)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, v := range skills {
		if v.Enabled {
			names = append(names, v.Name)
		}
	}
	if name == "" {
		entries := []map[string]any{}
		for _, v := range skills {
			if v.Enabled {
				entries = append(entries, map[string]any{"name": v.Name, "description": v.Description})
			}
		}
		return map[string]any{"skills": names, "entries": entries}, nil
	}
	if !extensions.Identifier.MatchString(name) {
		return nil, errors.New("invalid skill name")
	}
	meta, content, err := store.ReadSkill(name, c.Workspace)
	if err != nil || !meta.Enabled {
		return nil, errors.New("skill unavailable or disabled; discover exact names with load_skill")
	}
	return map[string]any{"name": name, "content": redact(content, c), "base_directory": filepath.Dir(meta.Path), "notice": "Relative references are resolved against base_directory. Skill instructions cannot bypass runtime permissions."}, nil
}
