package ai

import (
	"errors"
	"strings"
	"time"
)

func pilotReadRecoveryTool() Tool {
	return Tool{Name: "pilot_read_recovery", Description: "Inspect your own current step's operation ledger with {}. If a read failed, you may stop and report failure, or collect alternative real evidence within your delegation. After an actual successful replacement, submit failed_operation_id, replacement_operation_ids and reason to retain the failed audit record while covering that read gap. Only flexible direction/step/automatic delegation permits replacement. Exact selected commands, unknown changes, other steps/resources, unfinished or older samples cannot be resolved here. This never executes a command or changes resource permissions.", Parameters: objectSchema(map[string]any{"failed_operation_id": stringSchema(), "replacement_operation_ids": arraySchema(stringSchema()), "reason": stringSchema()})}
}

// Recovery is a reference to completed evidence, never a new outcome for the
// failed operation. Every consumer rechecks the referenced original ledger.
func pilotReadRecoveryValid(a SREStepAttempt, recovery PilotReadRecovery) bool {
	var failed *SREOperation
	for i := range a.Operations {
		if a.Operations[i].ID == recovery.FailedOperationID {
			failed = &a.Operations[i]
			break
		}
	}
	if failed == nil || failed.ResourceID == "" || failed.Risk != "readonly" || (failed.Status != "unknown" && failed.Status != "failed") || len(recovery.ReplacementOperationIDs) == 0 || len(recovery.ReplacementOperationIDs) > 12 || strings.TrimSpace(recovery.Reason) == "" {
		return false
	}
	ended, err := time.Parse(time.RFC3339Nano, failed.FinishedAt)
	if err != nil {
		return false
	}
	seen := map[string]bool{}
	for _, id := range recovery.ReplacementOperationIDs {
		if id == failed.ID || seen[id] {
			return false
		}
		seen[id] = true
		found := false
		for _, replacement := range a.Operations {
			if replacement.ID != id {
				continue
			}
			started, startErr := time.Parse(time.RFC3339Nano, replacement.DispatchedAt)
			finished, finishErr := time.Parse(time.RFC3339Nano, replacement.FinishedAt)
			found = replacement.Risk == "readonly" && replacement.Status == "succeeded" && replacement.ResourceID == failed.ResourceID && startErr == nil && finishErr == nil && !started.Before(ended) && !finished.Before(started)
			if found {
				proof := false
				for _, evidenceID := range replacement.EvidenceIDs {
					for _, ev := range a.Evidence {
						if ev.ID == evidenceID && ev.Success && ev.HasSource && !ev.SourceTruncated && ev.ResourceID == failed.ResourceID && !sreAfter(failed.FinishedAt, ev.CollectedAt) {
							proof = true
						}
					}
				}
				found = proof
			}
			break
		}
		if !found {
			return false
		}
	}
	return true
}

func pilotReadCovered(a SREStepAttempt, failed SREOperation) bool {
	for _, r := range a.ReadRecoveries {
		if r.FailedOperationID == failed.ID && pilotReadRecoveryValid(a, r) {
			return true
		}
	}
	return false
}

func pilotReadFailureOutstanding(a SREStepAttempt, failed SREOperation) bool {
	if failed.Risk != "readonly" || (failed.Status != "unknown" && failed.Status != "failed") || pilotReadCovered(a, failed) {
		return false
	}
	key := failed.Digest
	if key == "" {
		key = hash(failed.Call.Name + failed.Call.Arguments)
	}
	for _, later := range a.Operations {
		digest := later.Digest
		if digest == "" {
			digest = hash(later.Call.Name + later.Call.Arguments)
		}
		if digest == key && pilotReadRecoveryValid(a, PilotReadRecovery{FailedOperationID: failed.ID, ReplacementOperationIDs: []string{later.ID}, Reason: "同一检查取得新的完整采样"}) {
			return false
		}
	}
	return true
}

func (e *Engine) pilotReadRecovery(c Config, call Call) (any, error) {
	task, err := e.activePilotTask(c)
	if err != nil {
		return nil, err
	}
	var input struct {
		Failed       string   `json:"failed_operation_id"`
		Replacements []string `json:"replacement_operation_ids"`
		Reason       string   `json:"reason"`
	}
	if err = decodeSREJSON(call.Arguments, &input); err != nil {
		return nil, err
	}
	if input.Failed != "" || len(input.Replacements) > 0 || input.Reason != "" {
		if input.Failed == "" || len(input.Replacements) == 0 || strings.TrimSpace(input.Reason) == "" || len(input.Reason) > 2000 {
			return nil, errors.New("provide the failed read, actual replacement IDs and a bounded reason")
		}
		task, err = e.sreRepository.MutateSRETask(e.worker.parentID, c.sre.TaskID, 0, "pilot_read_recovery", func(t *SRETask) error {
			if t.Pilot == nil || t.LatestPlan() == nil || t.LatestPlan().ID != c.sre.PlanRevisionID || (t.Status != "active" && t.Status != "waiting_approval") {
				return errors.New("Pilot step no longer active")
			}
			mode := pilotExecutionMode(*t, c.sre.PlanRevisionID, c.sre.Step.ID, c.sre.AttemptID)
			if mode != "direction" && mode != "step" && mode != "automatic" {
				return errors.New("exact command selection cannot be replaced; report failure or obtain a new user choice")
			}
			for i := range t.Attempts {
				a := &t.Attempts[i]
				if a.ID != c.sre.AttemptID || a.StepID != c.sre.Step.ID {
					continue
				}
				recovery := PilotReadRecovery{FailedOperationID: input.Failed, ReplacementOperationIDs: input.Replacements, Reason: input.Reason, CreatedAt: timestamp()}
				if !pilotReadRecoveryValid(*a, recovery) {
					return errors.New("replacement must be a later successful read on the same resource and attempt; unknown changes remain blocked")
				}
				for _, old := range a.ReadRecoveries {
					if old.FailedOperationID == input.Failed && js(old.ReplacementOperationIDs) == js(input.Replacements) && old.Reason == input.Reason {
						return nil
					}
				}
				a.ReadRecoveries = append(a.ReadRecoveries, recovery)
				return nil
			}
			return errors.New("Pilot attempt expired")
		})
		if err != nil {
			return nil, err
		}
	}
	for _, a := range task.Attempts {
		if a.ID != c.sre.AttemptID {
			continue
		}
		ops := []map[string]any{}
		for _, op := range a.Operations {
			ops = append(ops, map[string]any{"operation_id": op.ID, "tool": op.Call.Name, "arguments": redact(op.Call.Arguments, c), "status": op.Status, "risk": op.Risk, "resource_id": op.ResourceID, "started_at": op.DispatchedAt, "finished_at": op.FinishedAt, "read_gap": pilotReadFailureOutstanding(a, op)})
		}
		return map[string]any{"mode": pilotExecutionMode(task, c.sre.PlanRevisionID, c.sre.Step.ID, c.sre.AttemptID), "operations": ops, "read_recoveries": a.ReadRecoveries, "notice": "Original failures remain in the audit. A linked replacement proves actual collection, not business recovery or approval for a change."}, nil
	}
	return nil, errors.New("Pilot attempt expired")
}
