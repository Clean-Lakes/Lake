package ai

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestProviderToolSchemasNeverEncodeNullRequired(t *testing.T) {
	for _, profile := range []string{"core", "terminal2", "db-query-editor"} {
		tools := append(Catalog(profile), projectMemoryTools()...)
		tools = append(tools, delegationTools()...)
		for _, provider := range []string{"openai", "openai-response", "claude", "gemini", "ollama"} {
			t.Run(profile+"/"+provider, func(t *testing.T) {
				_, payload, err := modelPayload(Model{URL: "http://127.0.0.1:1", Name: "schema-fixture", Protocol: provider}, []Message{{Role: "user", Content: "schema validation"}}, tools)
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				var wire any
				if err = json.Unmarshal(encoded, &wire); err != nil {
					t.Fatal(err)
				}
				var inspect func(any, string)
				inspect = func(value any, path string) {
					switch v := value.(type) {
					case map[string]any:
						if required, exists := v["required"]; exists {
							if _, ok := required.([]any); !ok {
								t.Errorf("%s.required is not an array: %v", path, required)
							}
						}
						for key, child := range v {
							inspect(child, path+"."+key)
						}
					case []any:
						for i, child := range v {
							inspect(child, fmt.Sprintf("%s[%d]", path, i))
						}
					}
				}
				inspect(wire, "request")
			})
		}
	}
}
