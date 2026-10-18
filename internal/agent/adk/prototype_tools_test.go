package lakeadk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"

	lakeai "github.com/Clean-Lakes/Lake/internal/ai"
)

// Asset is the small, explicit projection of a Lake resource used by the
// Phase 0 spike. Phase 1 replaces it with Lake's full asset catalog.
type Asset struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// DefaultToolSpecs builds the three Phase 0 tools. Only shell can ever require
// approval; list_assets and inspect_host are strictly read-only.
func DefaultToolSpecs(assets []Asset) []ToolSpec {
	return []ToolSpec{
		{
			Name:        "list_assets",
			Description: "List Lake project resources available to this session. Read-only.",
			Parameters: map[string]any{
				"type":                 "object",
				"properties":           map[string]any{},
				"additionalProperties": false,
			},
			Target:   "project",
			ReadOnly: func(map[string]any) bool { return true },
			Execute: func(context.Context, map[string]any) (any, error) {
				return map[string]any{"assets": assets, "count": len(assets)}, nil
			},
		},
		{
			Name:        "inspect_host",
			Description: "Collect fresh read-only host identity, uptime and filesystem information from the local runtime. Read-only.",
			Parameters: map[string]any{
				"type":                 "object",
				"properties":           map[string]any{},
				"additionalProperties": false,
			},
			Target:   "local",
			ReadOnly: func(map[string]any) bool { return true },
			Execute:  inspectHost,
		},
		{
			Name:        "shell",
			Description: "Run a shell command on the local runtime. Read-only commands execute directly; anything that can change state requires explicit Lake approval.",
			Parameters: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]any{"type": "string", "description": "Shell command to execute."},
				},
				"required":             []string{"command"},
				"additionalProperties": false,
			},
			Target:   "local",
			ReadOnly: func(args map[string]any) bool { return readOnlyShell(stringArg(args, "command")) },
			Execute:  runShell,
		},
	}
}

// BuildTools converts Lake tool specs into ADK function tools. Every handler
// goes through the gate; the executor is never exposed to the model.
func BuildTools(specs []ToolSpec, gate *Gate) ([]tool.Tool, error) {
	if gate == nil {
		return nil, errors.New("gate is required")
	}
	out := make([]tool.Tool, 0, len(specs))
	for _, spec := range specs {
		spec := spec
		schema := &jsonschema.Schema{}
		params := spec.Parameters
		if len(params) == 0 {
			params = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		b, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("tool %s schema: %w", spec.Name, err)
		}
		if err := json.Unmarshal(b, schema); err != nil {
			return nil, fmt.Errorf("tool %s schema: %w", spec.Name, err)
		}
		handler := func(ctx agent.Context, args map[string]any) (map[string]any, error) {
			return gate.Run(ctx, spec, args)
		}
		t, err := functiontool.New(functiontool.Config{
			Name:        spec.Name,
			Description: spec.Description,
			InputSchema: schema,
		}, handler)
		if err != nil {
			return nil, fmt.Errorf("tool %s: %w", spec.Name, err)
		}
		out = append(out, t)
	}
	return out, nil
}

func inspectHost(ctx context.Context, _ map[string]any) (any, error) {
	checks := []struct {
		name    string
		command []string
	}{
		{"uname", []string{"uname", "-a"}},
		{"uptime", []string{"uptime"}},
		{"disk", []string{"df", "-h"}},
	}
	out := map[string]any{}
	for _, check := range checks {
		value, err := runReadOnly(ctx, check.command)
		out[check.name] = map[string]any{"output": value, "error": errorString(err)}
	}
	return out, nil
}

func runReadOnly(ctx context.Context, command []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	b, err := cmd.CombinedOutput()
	text := string(b)
	if len(text) > 100_000 {
		text = text[:100_000] + "\n[TRUNCATED]"
	}
	if err != nil {
		return text, err
	}
	return text, nil
}

func runShell(ctx context.Context, args map[string]any) (any, error) {
	command := strings.TrimSpace(stringArg(args, "command"))
	if command == "" {
		return nil, errors.New("command is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	b, err := cmd.CombinedOutput()
	text := string(b)
	if len(text) > 100_000 {
		text = text[:100_000] + "\n[TRUNCATED]"
	}
	result := map[string]any{"command": command, "output": text}
	if err != nil {
		result["error"] = err.Error()
		return result, err
	}
	return result, nil
}

// readOnlyShell is deliberately narrow. It is a Phase 0 guard, not a
// replacement for Lake's full command policy.
func readOnlyShell(command string) bool {
	command = strings.TrimSpace(command)
	if command == "" || lakeai.CatastrophicCommand(command) {
		return false
	}
	for _, token := range []string{";", "|", "&", ">", "<", "`", "$(", "\n", "\r"} {
		if strings.Contains(command, token) {
			return false
		}
	}
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return false
	}
	switch fields[0] {
	case "uptime", "w", "who", "df", "free", "uname", "ps":
		return true
	default:
		return false
	}
}

func stringArg(args map[string]any, key string) string {
	s, _ := args[key].(string)
	return s
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
