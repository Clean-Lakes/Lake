package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func readSREEvidenceFile(path string) ([]byte, error) { return os.ReadFile(path) }
func jsonResultPath(v any, path string) (any, bool) {
	for _, part := range strings.Split(path, ".") {
		switch x := v.(type) {
		case map[string]any:
			var ok bool
			v, ok = x[part]
			if !ok {
				return nil, false
			}
		case []any:
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 || n >= len(x) {
				return nil, false
			}
			v = x[n]
		default:
			return nil, false
		}
	}
	return v, true
}
func checkSREValue(check SRECheck, value any) (bool, error) {
	if check.Kind == "boolean_probe" {
		v, ok := value.(bool)
		want, wok := check.Expected.(bool)
		if !ok || !wok {
			return false, errors.New("探针未返回布尔值")
		}
		return v == want, nil
	}
	val, ok := value.(float64)
	if !ok {
		return false, errors.New("探针未返回数值")
	}
	raw, _ := json.Marshal(check.Expected)
	var target float64
	if json.Unmarshal(raw, &target) != nil {
		return false, errors.New("无效数值阈值")
	}
	switch check.Operator {
	case "lt":
		return val < target, nil
	case "lte":
		return val <= target, nil
	case "eq":
		return val == target, nil
	case "gte":
		return val >= target, nil
	case "gt":
		return val > target, nil
	}
	return false, errors.New("未知比较符")
}
func (e *Engine) EvaluateVerification(ctx context.Context, sessionID string, task SRETask, runID, attemptID string, assigned SREPlanStep) (SREVerificationResult, error) {
	plan := task.LatestPlan()
	v := SREVerificationResult{ID: uid(), TaskID: task.ID, PlanRunID: runID, Checks: []SRECheckResult{}, Verdict: "inconclusive", CheckedAt: timestamp()}
	if plan == nil {
		return v, errors.New("没有验证计划")
	}
	after := ""
	for _, a := range task.Attempts {
		for _, op := range a.Operations {
			if op.Status == "succeeded" && (after == "" || sreAfter(op.FinishedAt, after)) {
				after = op.FinishedAt
			}
		}
	}
	evidence := []AgentEvidence{}
	roleRun := ""
	assignedPrompt := "Assigned deliverable: " + assigned.Description + "\nCompletion conditions: " + js(assigned.CompletionChecks) + "\n"
	for _, check := range plan.Acceptance {
		r := SRECheckResult{CheckID: check.ID, Status: "inconclusive", Reason: check.Description + "：尚无有效数据", EvidenceIDs: []string{}, CheckedAt: timestamp()}
		if check.ResourceID != "" {
			assignedResource := false
			for _, id := range assigned.ResourceIDs {
				assignedResource = assignedResource || id == check.ResourceID
			}
			if !assignedResource {
				r.Reason = "验收资源不在本次验证员分配范围"
				v.Checks = append(v.Checks, r)
				continue
			}
		}
		if check.Kind == "manual_attestation" {
			if err := e.recordSREInput(ctx, sessionID, task, "manual_attestation", runID+check.ID, nil); err != nil {
				return v, err
			}
			r.Reason = check.Description + "：等待用户人工确认"
			v.Checks = append(v.Checks, r)
			continue
		}
		start := time.Now()
		r.Status = "passed"
		for sample := 0; sample < check.MinSamples; sample++ {
			if sample > 0 && check.WindowSeconds > 0 {
				duration := time.Duration(check.WindowSeconds) * time.Second / time.Duration(max(1, check.MinSamples-1))
				timer := time.NewTimer(duration)
				select {
				case <-ctx.Done():
					timer.Stop()
					return v, ctx.Err()
				case <-timer.C:
				}
			}
			step := assigned
			step.Action = check.Probe
			step.Description = assigned.Description + "（" + check.Description + "）"
			step.ResourceIDs = []string{check.ResourceID}
			result, err := e.ExecuteSRERole(ctx, sessionID, task, step, runID, attemptID, assignedPrompt+"Independently inspect this acceptance criterion using normal tools. The runtime collects the exact frozen probe once after your checks; do not replay it or claim a result in advance. Runtime acceptance criterion: "+js(check), false)
			roleRun = result.RunID
			evidence = append(evidence, result.Evidence...)
			if err != nil {
				r.Status = "inconclusive"
				r.Reason = err.Error()
				break
			}
			probeSamples := []SRECheckSample{}
			acceptanceIDs := map[string]bool{}
			for _, id := range result.AcceptanceEvidenceIDs {
				acceptanceIDs[id] = true
			}
			for _, ev := range result.Evidence {
				if !acceptanceIDs[ev.ID] {
					continue
				}
				path, readErr := e.evidencePath(ev)
				if readErr != nil {
					continue
				}
				data, readErr := os.ReadFile(path)
				if readErr != nil {
					continue
				}
				probeSamples = append(probeSamples, SRECheckSample{Evidence: ev, Frozen: true, Source: data})
			}
			sampleCheck := check
			sampleCheck.MinSamples = 1
			sampleCheck.WindowSeconds = 0
			calculated := EvaluateSREChecks(sampleCheck, probeSamples, after, 0)
			valid := calculated.Samples > 0
			if valid {
				r.Samples += calculated.Samples
				r.Value = calculated.Value
				r.EvidenceIDs = append(r.EvidenceIDs, calculated.EvidenceIDs...)
				if calculated.Status == "failed" || r.Status != "failed" {
					r.Status = calculated.Status
					r.Reason = calculated.Reason
				}
			}

			if !valid {
				r.Status = "inconclusive"
				r.Reason = "探针缺少目标字段、数据过期或证据不完整"
				break
			}
		}
		if r.Samples < check.MinSamples && r.Status != "failed" {
			r.Status = "inconclusive"
		}
		if check.WindowSeconds > 0 && check.MinSamples > 1 && time.Since(start) < time.Duration(check.WindowSeconds)*time.Second {
			r.Status = "inconclusive"
			r.Reason = "观察时间窗不足"
		}
		r.CheckedAt = timestamp()
		v.Checks = append(v.Checks, r)
	}
	if len(v.Checks) > 0 {
		v.Verdict = "passed"
		for _, c := range v.Checks {
			if c.Status == "failed" {
				v.Verdict = "failed"
				break
			}
			if c.Status != "passed" {
				v.Verdict = "inconclusive"
			}
		}
	}
	if roleRun == "" {
		step := assigned
		step.Action = nil
		result, err := e.ExecuteSRERole(ctx, sessionID, task, step, runID, attemptID, assignedPrompt+"Independently review the assigned deliverable using the full normal toolset under inherited permissions. These are the server-calculated acceptance results. No frozen automatic probe is available, so additional checks may add evidence but cannot upgrade manual or missing criteria to automatic recovery:\n"+js(v.Checks), false)
		v.ReviewSummary = result.Summary
		if err != nil {
			return v, err
		}
		roleRun = result.RunID
		evidence = append(evidence, result.Evidence...)
	}
	_, err := e.sreRepository.MutateSRETask(sessionID, task.ID, 0, "verification_recorded", func(t *SRETask) error {
		t.Verifications = append(t.Verifications, v)
		for i := range t.Attempts {
			if t.Attempts[i].ID == attemptID {
				t.Attempts[i].Evidence = evidence
				t.Attempts[i].RoleRunID = roleRun
			}
		}
		return nil
	})
	if err != nil {
		return v, err
	}
	if v.Verdict != "passed" && (plan.TaskType == "recovery" || plan.TaskType == "change") {
		return v, fmt.Errorf("独立验证%s：%s", map[string]string{"failed": "未通过", "inconclusive": "无法确认"}[v.Verdict], sreVerificationSummary(v))
	}
	return v, nil
}

func sreAfter(a, b string) bool {
	left, e := time.Parse(time.RFC3339Nano, a)
	if e != nil {
		return false
	}
	right, e := time.Parse(time.RFC3339Nano, b)
	return e == nil && left.After(right)
}
