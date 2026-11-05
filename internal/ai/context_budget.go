package ai

// AutomaticContextWindow leaves room for provider accounting differences while
// adapting to the selected model. An unknown capacity is never invented.
func AutomaticContextWindow(limit int) int {
	if limit < 2048 {
		return 64000
	}
	return max(2048, min(2000000, limit*9/10))
}

func applyContextBudget(model *Model) {
	if model.ContextWindow == 0 {
		model.ContextWindow = AutomaticContextWindow(model.ContextLimit)
	}
	if model.ContextLimit >= 2048 {
		model.ContextWindow = min(model.ContextWindow, model.ContextLimit)
	}
	if model.MaxOutput <= 0 {
		model.MaxOutput = 8192
	}
	if model.MaxOutput >= model.ContextWindow {
		model.MaxOutput = model.ContextWindow / 4
	}
}

// ContextBudgetViewV1 discloses the established compatibility estimate, not an
// exact tokenizer or a new cumulative task allowance.
type ContextBudgetViewV1 struct {
	Version              int    `json:"version"`
	SerializedBytes      int    `json:"serializedBytes"`
	EstimatedInputTokens int    `json:"estimatedInputTokens"`
	EstimateMethod       string `json:"estimateMethod"`
	WindowTokens         int    `json:"windowTokens"`
	MaxOutputTokens      int    `json:"maxOutputTokens"`
	OverBudget           bool   `json:"overBudget"`
}

func BuildContextBudgetView(m Model, history []Message, tools []Tool) ContextBudgetViewV1 {
	cost := historyCost(history) + len(js(tools))
	input := max(0, m.ContextWindow-m.MaxOutput)
	return ContextBudgetViewV1{Version: ContextProtocolV1, SerializedBytes: cost, EstimatedInputTokens: (cost + 1) / 2, EstimateMethod: "legacy_json_bytes_div2_with_image_estimate", WindowTokens: m.ContextWindow, MaxOutputTokens: m.MaxOutput, OverBudget: input == 0 || cost > input*2}
}
