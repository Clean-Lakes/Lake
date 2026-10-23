package ai

import (
	"encoding/json"
	"errors"
	"time"
)

func memoryEvidenceEligible(value any, toolErr error) string {
	if toolErr != nil {
		var notExecuted *ToolNotExecutedError
		if errors.As(toolErr, &notExecuted) {
			return "not_executed"
		}
		return "unknown"
	}
	r := obj(value)
	status := str(r["status"])
	if status == "running" || r["running"] == true {
		return "running"
	}
	if status == "unknown" || status == "cancelled" || status == "not_executed" || r["effect_dispatched"] == false {
		return "unknown"
	}
	if status == "failed" || r["error"] != nil || r["success"] == false {
		return "completed_failure"
	}
	for _, field := range []string{"exitCode", "exit_code"} {
		if v, ok := r[field]; ok && v != nil {
			var n float64
			switch code := v.(type) {
			case int:
				n = float64(code)
			case float64:
				n = code
			case json.Number:
				var err error
				n, err = code.Float64()
				if err != nil {
					return "unknown"
				}
			default:
				return "unknown"
			}
			if n != 0 {
				return "completed_failure"
			}
		}
	}
	return "completed_success"
}

func (e *Engine) recordMemoryToolContext(s *session, c Config, call Call, resource string, started time.Time, value any, toolErr error) {
	if c.MemorySchemaVersion != 2 || !c.MemoryEnabled || resource == "" || c.MemoryResourceGenerations[resource] < 1 {
		return
	}
	// policyContext supplied this resource; validate against the effective catalog.
	resolved, err := asset(c, resource)
	if err != nil || resolved.ID != resource {
		return
	}
	if call.Name == "call_mcp_tool" {
		return
	}
	record := MemoryEvidenceContext{CallID: call.ID, ResourceBindings: []MemoryResourceBinding{{ResourceID: resource, Generation: c.MemoryResourceGenerations[resource]}}, StartedAt: started.UTC().Format(time.RFC3339Nano), FinishedAt: time.Now().UTC().Format(time.RFC3339Nano), Outcome: memoryEvidenceEligible(value, toolErr), ClaimSupport: "text_excerpt"}
	if code := obj(value)["exitCode"]; code != nil {
		v := num(code, 0)
		record.ExitCode = &v
	}
	record.Truncated = obj(value)["truncated"] == true
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.MemoryEvidenceContexts == nil {
		s.state.MemoryEvidenceContexts = map[string]MemoryEvidenceContext{}
	}
	if len(s.state.MemoryEvidenceContexts) < 64 {
		s.state.MemoryEvidenceContexts[call.ID] = record
	}
}
