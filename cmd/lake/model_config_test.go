package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexStyleModelFlagsAndProfile(t *testing.T) {
	root := t.TempDir()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "base", ModelProvider: "mimo",
		ModelProviders: map[string]providerConfig{"mimo": {BaseURL: "https://example.com/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dev.config.toml"), []byte("model = 'profile-model'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	opts, err := parseChatOptions([]string{"-p", "dev", "-m", "cli-model", "-c", "model_reasoning_effort=high", "检查测试湖"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	config, err := loadModelConfig(root, opts)
	if err != nil {
		t.Fatal(err)
	}
	if config.Model != "cli-model" || config.ModelReasoningEffort != "high" || config.ModelProviders["mimo"].BaseURL != "https://example.com/anthropic" || opts.Prompt != "检查测试湖" {
		t.Fatalf("config=%+v opts=%+v", config, opts)
	}
}

func TestModelContextBudgetDefaultsAndOverrides(t *testing.T) {
	root := t.TempDir()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "test-model", ModelProvider: "test",
		ModelProviders: map[string]providerConfig{"test": {BaseURL: "https://example.com/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	config, err := loadModelConfig(root, chatOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if config.ContextWindow != 32000 || config.MaxOutputTokens != 4096 {
		t.Fatalf("legacy defaults: window=%d output=%d", config.ContextWindow, config.MaxOutputTokens)
	}
	config, err = loadModelConfig(root, chatOptions{Config: stringFlags{"context_window=16384", "max_output_tokens=2048"}})
	if err != nil {
		t.Fatal(err)
	}
	if config.ContextWindow != 16384 || config.MaxOutputTokens != 2048 {
		t.Fatalf("overrides: window=%d output=%d", config.ContextWindow, config.MaxOutputTokens)
	}
	if err := saveModelConfig(root, config); err != nil {
		t.Fatal(err)
	}
	reloaded, err := loadModelConfig(root, chatOptions{})
	if err != nil || reloaded.ContextWindow != 16384 || reloaded.MaxOutputTokens != 2048 {
		t.Fatalf("saved budget: %+v, err=%v", reloaded, err)
	}
}

func TestModelContextBudgetRejectsOutputLargerThanWindow(t *testing.T) {
	root := t.TempDir()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "test-model", ModelProvider: "test",
		ModelProviders: map[string]providerConfig{"test": {BaseURL: "https://example.com/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := loadModelConfig(root, chatOptions{Config: stringFlags{"context_window=4096", "max_output_tokens=4096"}}); err == nil {
		t.Fatal("accepted an input budget of zero")
	}
}

func TestModelAutoCompactionThresholdPersistsAndRejectsOversizedLimit(t *testing.T) {
	root := t.TempDir()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ContextWindow: 8192, MaxOutputTokens: 1024,
		ModelProviders: map[string]providerConfig{"test": {BaseURL: "https://example.invalid", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	config, err := loadModelConfig(root, chatOptions{Config: stringFlags{"model_auto_compact_token_limit=4096"}})
	if err != nil || config.AutoCompactTokenLimit != 4096 {
		t.Fatal("threshold not applied", err)
	}
	if err := saveModelConfig(root, config); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadModelConfig(root, chatOptions{})
	if err != nil || loaded.AutoCompactTokenLimit != 4096 {
		t.Fatal("threshold not persisted", err)
	}
	for _, value := range []string{"-1", "8192", "invalid"} {
		if _, err := loadModelConfig(root, chatOptions{Config: stringFlags{"model_auto_compact_token_limit=" + value}}); err == nil {
			t.Fatal("invalid threshold accepted")
		}
	}
}

func TestModelWireAPISelectionAndLegacyDefault(t *testing.T) {
	root := t.TempDir()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "provider", ModelProviders: map[string]providerConfig{"provider": {BaseURL: "https://example.com/v1"}}}); err != nil {
		t.Fatal(err)
	}
	config, err := loadModelConfig(root, chatOptions{})
	if err != nil || config.ModelProviders["provider"].WireAPI != "anthropic" {
		t.Fatalf("legacy wire API: %+v err=%v", config, err)
	}
	for _, wire := range []string{"openai_chat", "openai_responses"} {
		config, err = loadModelConfig(root, chatOptions{Config: stringFlags{"model_providers.provider.wire_api=" + wire}})
		if err != nil || config.ModelProviders["provider"].WireAPI != wire {
			t.Fatalf("wire %s: %+v err=%v", wire, config, err)
		}
	}
	if _, err := loadModelConfig(root, chatOptions{Config: stringFlags{"model_providers.provider.wire_api=unsupported"}}); err == nil {
		t.Fatal("unknown wire API accepted")
	}
}

func TestOptionalWebConfigurationRoundTrip(t *testing.T) {
	root := t.TempDir()
	config := lakeModelConfig{Model: "test", ModelProvider: "provider", ModelProviders: map[string]providerConfig{"provider": {BaseURL: "https://example.com/v1", WireAPI: "anthropic"}}, WebSearchEndpoint: "http://127.0.0.1:8080", WebAllowedDomains: []string{"docs.example.com"}}
	if err := saveModelConfig(root, config); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadModelConfig(root, chatOptions{})
	if err != nil || loaded.WebSearchEndpoint != config.WebSearchEndpoint || len(loaded.WebAllowedDomains) != 1 || loaded.WebAllowedDomains[0] != "docs.example.com" {
		t.Fatalf("web config=%+v err=%v", loaded, err)
	}
}

func TestModelCatalogAddListUseAndCLIOverride(t *testing.T) {
	root := t.TempDir()
	var out bytes.Buffer
	run := func(args ...string) {
		t.Helper()
		out.Reset()
		if err := modelCommand(args, root, strings.NewReader(""), &out, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	run("configure", "--provider", "mimo", "--model", "mimo-v2.6-pro", "--base-url", "https://mimo.example/anthropic")
	run("add", "--provider", "deepseek", "--model", "deepseek-v4-pro", "--base-url", "https://deepseek.example/anthropic")
	run("add", "--provider", "deepseek", "--model", "deepseek-flash")
	run("ls", "--json")
	var listed struct {
		Current string       `json:"current"`
		Models  []modelEntry `json:"models"`
	}
	if err := json.Unmarshal(out.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Current != "mimo-v2.6-pro" || len(listed.Models) != 3 {
		t.Fatalf("catalog: %+v", listed)
	}
	config, err := loadModelConfig(root, chatOptions{Model: "deepseek-flash"})
	if err != nil || config.ModelProvider != "deepseek" || config.ModelProviders["deepseek"].BaseURL != "https://deepseek.example/anthropic" {
		t.Fatalf("-m did not choose the registered provider: %+v, %v", config, err)
	}
	run("use", "deepseek-v4-pro")
	config, err = loadModelConfig(root, chatOptions{})
	if err != nil || config.Model != "deepseek-v4-pro" || config.ModelProvider != "deepseek" {
		t.Fatalf("model use did not persist: %+v, %v", config, err)
	}
}
