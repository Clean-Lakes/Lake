package zcode

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

var deniedTools = []string{"Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "TodoWrite", "TodoRead", "ReadSessionContext", "Skill", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskOutput", "TaskStop", "NotebookEdit", "MultiEdit", "NodeRepl", "js", "ListMcpResources", "ReadMcpResource", "CronCreate", "CronDelete", "CronList", "CronUpdate", "mcp__node_repl__js"}

func prepareConfig(dir string, opts Options, h *host) error {
	data, err := os.ReadFile(opts.BuiltinPath)
	if err != nil {
		return err
	}
	var builtin map[string]any
	if err := json.Unmarshal(data, &builtin); err != nil {
		return err
	}
	config, ok := builtin["config"].(map[string]any)
	if !ok {
		return errors.New("无效 ZCode builtin provider 配置")
	}
	apiType := map[string]string{"anthropic": "anthropic-messages", "openai_chat": "openai-chat-completions", "openai_responses": "openai-responses"}[opts.APIType]
	config["providerConfigRules"] = map[string]any{"templateRules": []any{}, "providerRules": []any{map[string]any{"providerId": "lake", "providerName": "LAKE model proxy", "config": map[string]any{"group": "zai-family", "access": map[string]any{"type": "api-key", "apiKey": h.Token}, "api": map[string]any{"type": apiType, "baseUrl": h.URL + "/model"}, "builtinModelIds": []string{opts.Model}}}}}
	if err := writeConfig(filepath.Join(dir, "builtin.json"), builtin); err != nil {
		return err
	}
	if err := writeConfig(filepath.Join(dir, "personal.json"), map[string]any{"schemaVersion": 1, "config": map[string]any{"providerConfigRules": map[string]any{"providerRules": []any{}}, "modelConfigRules": map[string]any{"providerModelRules": []any{lakeModelRule(opts)}, "manualProviderModelRules": []any{}}, "defaultModelSelection": modelSelection(opts)}}); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(dir, ".zcode"), 0700); err != nil {
		return err
	}
	return writeConfig(filepath.Join(dir, ".zcode", "config.json"), map[string]any{"features": map[string]bool{"memory": false, "subagent": false, "skill": false, "mcp": true}, "memory": map[string]bool{"use": false}, "permission": map[string]string{"mode": "build"}, "mcp": map[string]any{"servers": map[string]any{}}})
}

func modelSelection(opts Options) map[string]any {
	level := opts.ReasoningEffort
	if level == "" {
		level = "default"
	} else if level == "none" {
		level = "disabled"
	}
	return map[string]any{"providerId": "lake", "modelId": opts.Model, "options": map[string]string{"reasoningLevel": level}}
}

// Provider-specific rules override upstream guesses with the settings already
// selected in Lake. Option maps use ZCode's restricted CEL contract.
func lakeModelRule(opts Options) map[string]any {
	properties := map[string]any{"inputFormat": map[string]bool{"supportsImage": true}}
	if opts.ContextWindow > 0 {
		properties["contextWindow"] = opts.ContextWindow
	}
	reasoningMap := `reasoningLevel == "default" || reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}`
	limitMap := `{"max_completion_tokens": maxOutputTokens}`
	switch opts.APIType {
	case "anthropic":
		reasoningMap = `reasoningLevel == "default" ? {} : {"thinking": {"type": reasoningLevel == "disabled" ? "disabled" : "enabled"}}`
		limitMap = `{"max_tokens": maxOutputTokens}`
	case "openai_responses":
		reasoningMap = `reasoningLevel == "default" || reasoningLevel == "disabled" ? {} : {"reasoning": {"effort": reasoningLevel}}`
		limitMap = `{"max_output_tokens": maxOutputTokens}`
	}
	specs := map[string]any{"reasoningLevel": map[string]any{"values": []string{"default", "disabled", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}, "map": reasoningMap}}
	if opts.MaxOutputTokens > 0 {
		specs["maxOutputTokens"] = map[string]any{"max": opts.MaxOutputTokens, "map": limitMap}
	}
	return map[string]any{"providerId": "lake", "modelId": opts.Model, "config": map[string]any{"enabled": true, "properties": properties, "optionSpecs": specs}}
}

func writeConfig(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}
