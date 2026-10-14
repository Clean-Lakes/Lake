package ai

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

type ReasoningCapability struct {
	Levels  []string `json:"levels"`
	Default string   `json:"default,omitempty"`
	Source  string   `json:"source,omitempty"`
}

var reasoningLevels = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
var modelSnapshotDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func cleanReasoning(c ReasoningCapability) ReasoningCapability {
	levels := []string{}
	for _, level := range c.Levels {
		if slices.Contains(reasoningLevels, level) && !slices.Contains(levels, level) {
			levels = append(levels, level)
		}
	}
	c.Levels = levels
	if !slices.Contains(levels, c.Default) {
		c.Default = ""
	}
	return c
}

func modelSlug(m Model) string {
	parts := strings.Split(strings.ToLower(m.Name), "/")
	return parts[len(parts)-1]
}

// Match complete model slugs or dated snapshots, never similarly named models.
func modelVersion(name, base string) bool {
	return name == base || strings.HasPrefix(name, base+"-") && modelSnapshotDate.MatchString(strings.TrimPrefix(name, base+"-"))
}

// Provider metadata takes precedence. Unknown models keep their default request.
// Fallbacks checked against the official docs on 2026-10-11:
// https://api-docs.deepseek.com/guides/thinking_mode/
// https://developers.openai.com/api/docs/models (individual model effort lists)
// https://platform.claude.com/docs/en/build-with-claude/effort
// https://ai.google.dev/gemini-api/docs/generate-content/thinking
func ReasoningSupport(m Model) ReasoningCapability {
	if m.Reasoning != nil {
		return cleanReasoning(*m.Reasoning)
	}
	name, p := modelSlug(m), protocol(m)
	c := ReasoningCapability{Levels: []string{}, Source: "model"}
	if p == "openai" || p == "azure-gpt" || p == "openai-response" {
		switch {
		case modelVersion(name, "deepseek-flash"), modelVersion(name, "deepseek-pro"), modelVersion(name, "deepseek-v4-flash"), modelVersion(name, "deepseek-v4-pro"):
			c.Levels, c.Default = []string{"none", "low", "high", "max"}, "high"
		case modelVersion(name, "gpt-5"), modelVersion(name, "gpt-5-mini"), modelVersion(name, "gpt-5-nano"):
			c.Levels = []string{"minimal", "low", "medium", "high"}
		case modelVersion(name, "gpt-5.1"):
			c.Levels, c.Default = []string{"none", "low", "medium", "high"}, "none"
		case modelVersion(name, "gpt-5.2"), modelVersion(name, "gpt-5.4"), modelVersion(name, "gpt-5.5"):
			c.Levels = []string{"none", "low", "medium", "high", "xhigh"}
			if modelVersion(name, "gpt-5.5") {
				c.Default = "medium"
			} else {
				c.Default = "none"
			}
		case p == "openai-response" && (modelVersion(name, "gpt-6-astra") || modelVersion(name, "gpt-6.1-sol")):
			c.Levels, c.Default = []string{"low", "medium", "high", "xhigh", "max", "ultra"}, "medium"
		}
	}
	if p == "claude" {
		switch {
		case modelVersion(name, "deepseek-flash"), modelVersion(name, "deepseek-pro"), modelVersion(name, "deepseek-v4-flash"), modelVersion(name, "deepseek-v4-pro"):
			c.Levels, c.Default = []string{"none", "low", "high", "max"}, "high"
		case modelVersion(name, "claude-opus-4-5"):
			c.Levels, c.Default = []string{"low", "medium", "high"}, "high"
		case modelVersion(name, "claude-opus-4-6"), modelVersion(name, "claude-sonnet-4-6"):
			c.Levels, c.Default = []string{"low", "medium", "high", "max"}, "high"
		case modelVersion(name, "claude-opus-4-7"), modelVersion(name, "claude-opus-4-8"), modelVersion(name, "claude-opus-5"), modelVersion(name, "claude-sonnet-5"), modelVersion(name, "claude-opus-5-5"), modelVersion(name, "claude-sonnet-5-5"), modelVersion(name, "claude-haiku-5-5"):
			c.Levels, c.Default = []string{"low", "medium", "high", "xhigh", "max"}, "high"
			if name == "claude-opus-5-5" || name == "claude-haiku-5-5" {
				c.Default = "medium"
			}
		}
	}
	if p == "gemini" {
		switch name {
		case "gemini-3-pro-preview":
			c.Levels, c.Default = []string{"low", "high"}, "high"
		case "gemini-3.1-pro-preview", "gemini-3.8-flash":
			c.Levels = []string{"low", "medium", "high"}
		case "gemini-3-flash-preview", "gemini-3.6-flash", "gemini-3.5-flash-lite":
			c.Levels = []string{"minimal", "low", "medium", "high"}
		case "gemini-3.1-flash-lite-image":
			c.Levels = []string{"minimal", "high"}
		}
	}
	return c
}

func ValidReasoningEffort(m Model, effort string) bool {
	return effort == "" || slices.Contains(ReasoningSupport(m).Levels, effort)
}

func reasoningMetadata(item map[string]any) *ReasoningCapability {
	effort := obj(item["effort"])
	raw, present := effort["supported_levels"]
	if !present {
		raw, present = item["supported_reasoning_efforts"]
	}
	if !present {
		raw, present = item["supported_reasoning_levels"]
	}
	if !present {
		return nil
	}
	c := ReasoningCapability{Source: "provider", Default: str(effort["default_level"])}
	for _, v := range arr(raw) {
		level := str(v)
		if entry, ok := v.(map[string]any); ok {
			level = str(entry["effort"])
		}
		c.Levels = append(c.Levels, level)
	}
	c = cleanReasoning(c)
	return &c
}

func applyReasoning(m Model, body map[string]any) error {
	effort := m.ReasoningEffort
	if effort == "" {
		return nil
	}
	if !ValidReasoningEffort(m, effort) {
		return fmt.Errorf("model does not support reasoning effort %q", effort)
	}
	deepseek := strings.HasPrefix(modelSlug(m), "deepseek-")
	switch protocol(m) {
	case "openai", "azure-gpt":
		if deepseek {
			mode := "enabled"
			if effort == "none" {
				mode = "disabled"
			} else {
				body["reasoning_effort"] = effort
			}
			body["thinking"] = map[string]any{"type": mode}
		} else {
			body["reasoning_effort"] = effort
		}
	case "openai-response":
		body["reasoning"] = map[string]any{"effort": effort}
	case "claude":
		if deepseek {
			if effort == "none" {
				body["thinking"] = map[string]any{"type": "disabled"}
			} else {
				body["thinking"] = map[string]any{"type": "enabled"}
				body["output_config"] = map[string]any{"effort": effort}
			}
		} else {
			body["output_config"] = map[string]any{"effort": effort}
			if !modelVersion(modelSlug(m), "claude-opus-4-5") {
				body["thinking"] = map[string]any{"type": "adaptive"}
			}
		}
	case "gemini":
		obj(body["generationConfig"])["thinkingConfig"] = map[string]any{"thinkingLevel": effort}
	default:
		return fmt.Errorf("reasoning effort is not supported by this protocol")
	}
	return nil
}
