package ai

import "crypto/sha256"
import "fmt"

type ContextUsage struct {
	Window        int    `json:"window"`
	WindowSource  string `json:"windowSource,omitempty"`
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
		estimated = (historyCost(state.History) + len(js(Catalog(state.Config.Profile))) + 1) / 2
	}
	value := &ContextUsage{Window: state.Config.Model.ContextLimit, WindowSource: state.Config.Model.ContextLimitSource,
		Budget: state.Config.Model.ContextWindow, EstimatedUsed: estimated, ModelID: ModelIdentity(state.Config.Model),
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
