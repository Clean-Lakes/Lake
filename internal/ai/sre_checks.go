package ai

import (
	"encoding/json"
	"time"
)

// SRECheckSample is populated by the trusted frozen-probe collector. A model
// cannot promote an ordinary observation into a frozen acceptance sample.
type SRECheckSample struct {
	Evidence AgentEvidence
	Frozen   bool
	Source   []byte
}

// EvaluateSREChecks is deterministic and performs no model or resource calls.
// Independent role review and collection happen before this business evaluator.
func EvaluateSREChecks(check SRECheck, samples []SRECheckSample, after string, elapsed time.Duration) SRECheckResult {
	result := SRECheckResult{CheckID: check.ID, Status: "inconclusive", Reason: "探针缺少目标字段、数据过期或证据不完整", CheckedAt: timestamp()}
	for _, sample := range samples {
		ev := sample.Evidence
		if !sample.Frozen || !ev.Success || ev.SourceTruncated || after != "" && !sreAfter(ev.CollectedAt, after) || ev.ResourceID != check.ResourceID {
			continue
		}
		var raw any
		if json.Unmarshal(sample.Source, &raw) != nil {
			continue
		}
		value, ok := jsonResultPath(raw, check.Path)
		if !ok {
			continue
		}
		passed, err := checkSREValue(check, value)
		if err != nil {
			result.Reason = err.Error()
			continue
		}
		result.Samples++
		result.Value = value
		result.EvidenceIDs = append(result.EvidenceIDs, ev.ID)
		if !passed {
			result.Status = "failed"
			result.Reason = check.Description + "：实际值未满足条件"
		} else if result.Status != "failed" {
			result.Status = "passed"
			result.Reason = check.Description + "：采样满足条件"
		}
	}
	if result.Samples < check.MinSamples && result.Status != "failed" {
		result.Status = "inconclusive"
	}
	if check.WindowSeconds > 0 && check.MinSamples > 1 && elapsed < time.Duration(check.WindowSeconds)*time.Second {
		result.Status = "inconclusive"
		result.Reason = "观察时间窗不足"
	}
	return result
}
