package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"
)

// Exact old JSON report shape for synthetic archive fixtures only.
type legacyVariantResult struct {
	Mode       string                           `json:"mode"`
	Status     string                           `json:"status"`
	Answer     string                           `json:"answer"`
	RuntimeID  string                           `json:"runtimeId"`
	ResetHash  string                           `json:"resetHash"`
	ResetNonce string                           `json:"resetNonce"`
	Observed   int                              `json:"observed"`
	Violations int                              `json:"violations"`
	Requests   int                              `json:"requests"`
	Usage      ai.Usage                         `json:"usage"`
	DurationMs int64                            `json:"durationMs"`
	Manifests  []strategy.PromptManifest        `json:"manifests"`
	Evaluation legacystrategy.FixtureEvaluation `json:"evaluation"`
	ErrorCode  string                           `json:"errorCode,omitempty"`
}
