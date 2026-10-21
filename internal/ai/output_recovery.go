package ai

const outputRecoveryNotice = "The previous response reached the model's output limit and was discarded. Reply more concisely. Preserve completed work and cite only evidence already observed. Do not repeat completed tool calls."

// outputRecoveryHistory adds a bounded retry instruction to the request copy.
// The persisted history, including the user's message and completed tool
// results, is unchanged when a model response reaches its output limit.
func outputRecoveryHistory(history []Message) []Message {
	copy := append([]Message(nil), history...)
	if len(copy) > 0 && copy[0].Role == "system" {
		copy[0].Content += "\n" + outputRecoveryNotice
		return copy
	}
	return append([]Message{{Role: "system", Content: outputRecoveryNotice}}, copy...)
}

// outputRecoveryModel keeps the user's token ceiling and explicit thinking
// choice. Automatic thinking may use the model's lowest positive effort so
// that a retry has more room for the visible answer.
func outputRecoveryModel(model Model) Model {
	if model.ReasoningEffort != "" {
		return model
	}
	for _, effort := range reasoningLevels {
		if effort != "none" && ValidReasoningEffort(model, effort) {
			model.ReasoningEffort = effort
			break
		}
	}
	return model
}
