package ai

import "crypto/sha256"
import "fmt"

// Anchor provider-reported input to the history before that response. Subsequent
// assistant/tool messages are additions, not part of the measured request.
type ContextMeasurement struct {
	ModelID     string `json:"modelId"`
	HistoryCost int    `json:"historyCost"`
	ToolsCost   int    `json:"toolsCost"`
}

func estimatedContextCost(state State, history []Message, toolsCost int) int {
	cost := historyCost(history)
	m := state.ContextMeasurement
	if m == nil || m.ModelID != ModelIdentity(state.Config.Model) || state.LastRequest == nil || !state.LastRequest.InputKnown || state.LastRequest.Input <= 0 {
		return cost + toolsCost
	}
	// Keep a 10% margin on the measured input and conservatively estimate only
	// new material. Cached input is still occupied context and is not deducted.
	return (state.LastRequest.Input*11+9)/10*2 + max(0, cost-m.HistoryCost) + max(0, toolsCost-m.ToolsCost)
}

type ContextUsage struct {
	Window        int    `json:"window"`
	WindowSource  string `json:"windowSource,omitempty"`
	InputBudget   int    `json:"inputBudget"`
	MaxOutput     int    `json:"maxOutput"`
	Budget        int    `json:"budget"`
	Used          int    `json:"used"`
	UsedKnown     bool   `json:"usedKnown"`
	Estimated     bool   `json:"estimated"`
	EstimatedUsed int    `json:"estimatedUsed"`
	ModelID       string `json:"modelId"`
	LastRequest   *Usage `json:"lastRequest,omitempty"`
	LastRequestAt string `json:"lastRequestAt,omitempty"`
}

func ModelIdentity(model Model) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(model.URL+"\x00"+model.Name+"\x00"+protocol(model))))
}
func contextUsage(state State) *ContextUsage {
	estimated := 0
	if len(state.History) > 0 {
		toolsCost := len(js(Catalog(state.Config.Profile)))
		if state.ContextMeasurement != nil {
			toolsCost = state.ContextMeasurement.ToolsCost
		}
		estimated = (estimatedContextCost(state, state.History, toolsCost) + 1) / 2
	}
	value := &ContextUsage{Window: state.Config.Model.ContextLimit, WindowSource: state.Config.Model.ContextLimitSource,
		Budget: state.Config.Model.ContextWindow, InputBudget: max(0, state.Config.Model.ContextWindow-state.Config.Model.MaxOutput), MaxOutput: state.Config.Model.MaxOutput, EstimatedUsed: estimated, ModelID: ModelIdentity(state.Config.Model),
		LastRequest: state.LastRequest, LastRequestAt: state.LastRequestAt}
	if state.LastRequest != nil && state.LastRequest.InputKnown {
		value.Used = state.LastRequest.Input
		value.UsedKnown = true
	}
	return value
}

func addUsage(total *Usage, usage Usage) {
	total.Input += usage.Input
	total.Output += usage.Output
	total.Total += usage.Total
	total.Known = total.Known || usage.Known
	total.InputKnown = total.InputKnown || usage.InputKnown
	total.OutputKnown = total.OutputKnown || usage.OutputKnown
	if usage.CachedInput != nil {
		n := *usage.CachedInput
		if total.CachedInput != nil {
			n += *total.CachedInput
		}
		total.CachedInput = &n
	}
}
