package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

type strategyProposalCandidate struct {
	Title     string             `json:"title"`
	Kind      strategy.AssetKind `json:"kind"`
	Body      string             `json:"body"`
	Reason    string             `json:"reason"`
	SourceIDs []string           `json:"sourceIds"`
}

type strategyProposalResult struct {
	SchemaVersion int                        `json:"schemaVersion"`
	Candidate     *strategyProposalCandidate `json:"candidate"`
}

func parseStrategyProposal(text string, sources []string) (strategyProposalResult, error) {
	var result strategyProposalResult
	invalid := errors.New("invalid proposal output")
	if len(text) > 16384 || rejectDuplicateMemoryJSON([]byte(text)) != nil || !strategyExactKeys(json.RawMessage(text), reflect.TypeOf(strategyProposalResult{})) {
		return result, invalid
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal([]byte(text), &raw) != nil || len(raw) != 2 || raw["candidate"] == nil {
		return result, invalid
	}
	d := json.NewDecoder(strings.NewReader(text))
	d.DisallowUnknownFields()
	if d.Decode(&result) != nil || result.SchemaVersion != 1 {
		return result, invalid
	}
	if c := result.Candidate; c != nil {
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(raw["candidate"], &fields)
		if len(fields) != 5 || len(c.Body) > 4000 || len(c.Reason) > 1000 || strings.TrimSpace(c.Reason) == "" || len(c.SourceIDs) == 0 || len(c.SourceIDs) > 8 {
			return result, invalid
		}
		seen := map[string]bool{}
		for _, id := range sources {
			seen[id] = true
		}
		used := map[string]bool{}
		for _, id := range c.SourceIDs {
			if !seen[id] || used[id] {
				return result, invalid
			}
			used[id] = true
		}
		if code := strategyValidationCode(func() {
			validateStrategyInput(StrategyAssetInput{Title: c.Title, Kind: c.Kind, Body: c.Body, Applicability: strategy.Applicability{}})
		}); code != "" {
			return result, invalid
		}
	}
	return result, nil
}
