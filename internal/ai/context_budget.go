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
