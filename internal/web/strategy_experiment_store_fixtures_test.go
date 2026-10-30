package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"
)

type strategyExperimentFrozen struct {
	Optimization    bool                     `json:"optimization,omitempty"`
	MemoryEpoch     int                      `json:"memoryEpoch"`
	Asset           strategy.AssetRevision   `json:"asset"`
	Cases           []legacystrategy.Fixture `json:"cases"`
	Repetitions     int                      `json:"repetitions"`
	SharedContext   string                   `json:"sharedContext"`
	ContextHash     string                   `json:"contextHash"`
	SkillHashes     map[string]string        `json:"skillHashes"`
	ModelRef        string                   `json:"modelRef"`
	ModelHash       string                   `json:"modelHash"`
	ContextWindow   int                      `json:"contextWindow"`
	MaxOutput       int                      `json:"maxOutput"`
	ReasoningEffort string                   `json:"reasoningEffort"`
	Budget          strategy.Budget          `json:"budget"`
}
