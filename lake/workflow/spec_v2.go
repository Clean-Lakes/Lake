package workflow

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefinitionV2 is a typed, bounded workflow graph. Conditions use dependency
// statuses; ordinary dependencies also serve as deterministic join points.
type DefinitionV2 struct {
	Version     int      `json:"version" yaml:"version"`
	Name        string   `json:"name" yaml:"name"`
	Description string   `json:"description,omitempty" yaml:"description,omitempty"`
	MaxParallel int      `json:"max_parallel,omitempty" yaml:"max_parallel,omitempty"`
	Nodes       []NodeV2 `json:"nodes" yaml:"nodes"`
}

type ValueV2 struct {
	Type    string       `json:"type" yaml:"type"`
	Literal any          `json:"literal,omitempty" yaml:"literal,omitempty"`
	Ref     *ResultRefV2 `json:"ref,omitempty" yaml:"ref,omitempty"`
	Item    bool         `json:"item,omitempty" yaml:"item,omitempty"`
}

type ResultRefV2 struct {
	Node string `json:"node" yaml:"node"`
	Path string `json:"path,omitempty" yaml:"path,omitempty"` // JSON Pointer; empty means whole result
	Type string `json:"type" yaml:"type"`
}

type ForEachV2 struct {
	Ref         ResultRefV2 `json:"ref" yaml:"ref"`
	MaxItems    int         `json:"max_items" yaml:"max_items"`
	ElementType string      `json:"element_type,omitempty" yaml:"element_type,omitempty"`
}

type NodeV2 struct {
	ID         string             `json:"id" yaml:"id"`
	Name       string             `json:"name,omitempty" yaml:"name,omitempty"`
	Kind       string             `json:"kind" yaml:"kind"`
	DependsOn  []string           `json:"depends_on,omitempty" yaml:"depends_on,omitempty"`
	When       string             `json:"when,omitempty" yaml:"when,omitempty"`
	Target     *ValueV2           `json:"target,omitempty" yaml:"target,omitempty"`
	Check      string             `json:"check,omitempty" yaml:"check,omitempty"`
	Command    *ValueV2           `json:"command,omitempty" yaml:"command,omitempty"`
	Request    *ValueV2           `json:"request,omitempty" yaml:"request,omitempty"`
	Specialist string             `json:"specialist,omitempty" yaml:"specialist,omitempty"`
	Tool       string             `json:"tool,omitempty" yaml:"tool,omitempty"`
	Inputs     map[string]ValueV2 `json:"inputs,omitempty" yaml:"inputs,omitempty"`
	OutputType string             `json:"output_type,omitempty" yaml:"output_type,omitempty"`
	ForEach    *ForEachV2         `json:"for_each,omitempty" yaml:"for_each,omitempty"`
}

func ParseV2(data []byte) (DefinitionV2, error) {
	if len(data) == 0 || len(data) > 256*1024 {
		return DefinitionV2{}, errors.New("工作流 v2 文件为空或超过 256 KiB")
	}
	var def DefinitionV2
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&def); err != nil {
			return DefinitionV2{}, err
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			return DefinitionV2{}, errors.New("工作流 v2 JSON 包含额外内容")
		}
	} else {
		var tree yaml.Node
		if err := yaml.Unmarshal(trimmed, &tree); err != nil {
			return DefinitionV2{}, err
		}
		if hasYAMLAlias(&tree) {
			return DefinitionV2{}, errors.New("工作流 v2 不允许 YAML 别名")
		}
		decoder := yaml.NewDecoder(bytes.NewReader(trimmed))
		decoder.KnownFields(true)
		if err := decoder.Decode(&def); err != nil {
			return DefinitionV2{}, err
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			return DefinitionV2{}, errors.New("工作流 v2 YAML 包含额外文档")
		}
	}
	if def.Version != 2 {
		return DefinitionV2{}, errors.New("工作流版本必须为 2")
	}
	return def, nil
}

func hasYAMLAlias(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	if node.Kind == yaml.AliasNode || node.Anchor != "" {
		return true
	}
	for _, child := range node.Content {
		if hasYAMLAlias(child) {
			return true
		}
	}
	return false
}

func validValueType(kind string) bool {
	switch kind {
	case "string", "number", "boolean", "object", "array":
		return true
	default:
		return false
	}
}

func literalMatches(kind string, value any) bool {
	switch kind {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		switch value.(type) {
		case int, int64, float64, float32, uint64:
			return true
		}
		return false
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		switch value.(type) {
		case map[string]any, map[interface{}]interface{}:
			return true
		}
		return false
	case "array":
		switch value.(type) {
		case []any:
			return true
		}
		return false
	default:
		return false
	}
}

func validJSONPointer(path string) bool {
	if path == "" {
		return true
	}
	if !strings.HasPrefix(path, "/") {
		return false
	}
	for i := 0; i < len(path); i++ {
		if path[i] == '~' {
			if i+1 >= len(path) || path[i+1] != '0' && path[i+1] != '1' {
				return false
			}
			i++
		}
	}
	return true
}
