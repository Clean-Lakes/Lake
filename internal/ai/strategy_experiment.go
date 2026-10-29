package ai

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Historical host input shape. All fields are ignored by the retired entry;
// callbacks never execute and this type cannot restore experiment authority.
type StrategyVariantInput struct {
	RunID, Home    string
	Fixture        strategy.Fixture
	Model          Model
	Asset          *strategy.AssetRevision
	Strategies     StrategyProvider `json:"-"`
	SharedContext  string
	LiveRead       func(context.Context) ([]byte, error) `json:"-"`
	LiveResetProof string                                `json:"-"`
	Reserve        func(int64) error
	Settle         func(int64, Usage) error
	Guard          func() error
	Safe           func(string) bool
}
type StrategyVariantResult struct {
	Mode       string                     `json:"mode"`
	Status     string                     `json:"status"`
	Answer     string                     `json:"answer"`
	RuntimeID  string                     `json:"runtimeId"`
	ResetHash  string                     `json:"resetHash"`
	ResetNonce string                     `json:"resetNonce"`
	Observed   int                        `json:"observed"`
	Violations int                        `json:"violations"`
	Requests   int                        `json:"requests"`
	Usage      Usage                      `json:"usage"`
	DurationMs int64                      `json:"durationMs"`
	Manifests  []strategy.PromptManifest  `json:"manifests"`
	Evaluation strategy.FixtureEvaluation `json:"evaluation"`
	ErrorCode  string                     `json:"errorCode,omitempty"`
}

// RunStrategyVariant is a retired compatibility entry. Never invokes callbacks,
// creates a Home or dispatches a provider. Historical reports remain readable.
func (e *Engine) RunStrategyVariant(context.Context, StrategyVariantInput) StrategyVariantResult {
	return StrategyVariantResult{Status: "retired", ErrorCode: "strategy_execution_retired"}
}
