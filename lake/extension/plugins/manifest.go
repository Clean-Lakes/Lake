package plugins

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"

	"github.com/cloudwego/eino/lake/extension/skills"
)

const manifestFile = "lake-plugin.json"

var (
	pluginName    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	pluginVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
)

// Manifest contains declarations only. It cannot request Lake resource access.
type Manifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Description string   `json:"description,omitempty"`
	Skills      []string `json:"skills,omitempty"`
	MCP         []string `json:"mcp,omitempty"`
	Hooks       []string `json:"hooks,omitempty"`
	Assets      []string `json:"assets,omitempty"`
}

func parseManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if len(data) == 0 || len(data) > 64*1024 {
		return manifest, errors.New("插件清单过大或为空")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return manifest, errors.New("插件清单格式无效或包含不允许的字段")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return manifest, errors.New("插件清单只能包含一个 JSON 对象")
	}
	if !pluginName.MatchString(manifest.Name) || !pluginVersion.MatchString(manifest.Version) || len(manifest.Description) > 500 {
		return manifest, errors.New("插件名称、版本或说明无效")
	}
	seen := map[string]bool{manifestFile: true}
	for _, group := range []struct {
		kind  string
		paths []string
	}{
		{"skills", manifest.Skills}, {"mcp", manifest.MCP}, {"hooks", manifest.Hooks}, {"assets", manifest.Assets},
	} {
		for _, item := range group.paths {
			if strings.Contains(item, "\\") || path.IsAbs(item) || path.Clean(item) != item || strings.HasPrefix(item, "../") || item == ".." || !strings.HasPrefix(item, group.kind+"/") || seen[item] {
				return manifest, fmt.Errorf("插件 %s 声明路径无效", group.kind)
			}
			if group.kind == "skills" && (path.Base(item) != "SKILL.md" || !pluginName.MatchString(path.Base(path.Dir(item)))) {
				return manifest, errors.New("插件 Skill 路径无效")
			}
			if group.kind != "skills" && group.kind != "assets" && !strings.HasSuffix(item, ".json") {
				return manifest, fmt.Errorf("插件 %s 声明必须是 JSON", group.kind)
			}
			seen[item] = true
		}
	}
	return manifest, nil
}

func validateDeclaration(data []byte) error {
	if len(data) == 0 || len(data) > 64*1024 {
		return errors.New("扩展声明过大或为空")
	}
	var value any
	if json.Unmarshal(data, &value) != nil {
		return errors.New("扩展声明不是有效 JSON")
	}
	if _, ok := value.(map[string]any); !ok {
		return errors.New("扩展声明必须是 JSON 对象")
	}
	var check func(any) bool
	check = func(value any) bool {
		switch item := value.(type) {
		case map[string]any:
			for key, child := range item {
				lower := strings.ToLower(key)
				for _, forbidden := range []string{"secret", "credential", "password", "passphrase", "token", "api_key", "private_key", "authorization", "headers", "env"} {
					if strings.Contains(lower, forbidden) {
						return false
					}
				}
				if !check(child) {
					return false
				}
			}
		case []any:
			for _, child := range item {
				if !check(child) {
					return false
				}
			}
		}
		return true
	}
	if !check(value) {
		return errors.New("扩展声明不能包含凭据字段")
	}
	return nil
}

func validateSkillDeclarations(source string, manifest Manifest) error {
	for _, declared := range manifest.Skills {
		name := path.Base(path.Dir(declared))
		if declared != path.Join("skills", name, "SKILL.md") {
			return errors.New("插件 Skill 路径必须为 skills/<名称>/SKILL.md")
		}
		if _, err := skills.Load(source, "", name); err != nil {
			return fmt.Errorf("插件 Skill %s 无效: %w", name, err)
		}
	}
	return nil
}
