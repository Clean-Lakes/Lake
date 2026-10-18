package ai

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

func (e *Engine) recordObservation(c Config, resourceID, title string, value any, toolErr error) (any, error) {
	w := e.worker
	if result := obj(value); result["output"] != nil {
		value = map[string]any{"output": result["output"], "exitCode": result["exitCode"], "truncated": result["truncated"]}
		for _, key := range []string{"identity", "metric", "namespace", "pod", "container", "disks", "disk_note"} {
			if result[key] != nil {
				obj(value)[key] = result[key]
			}
		}
	}
	if label := map[string]string{"observe_host": "主机指标快照", "observe_cluster": "Kubernetes 集群观察", "observe_cluster_logs": "Kubernetes Pod 日志", "observe_journal": "服务日志片段", "observe_logs": "应用日志片段", "observe_data": "数据服务指标"}[title]; label != "" {
		title = label
	}
	content := redact(js(value), c)
	if toolErr != nil {
		content = redact(js(map[string]any{"error": toolErr.Error(), "result": value}), c)
		title += " · 采集失败"
	}
	ev := AgentEvidence{ID: "ev_" + uid(), SessionID: w.parentID, RunID: w.runID, ResourceID: resourceID, Title: title, Excerpt: content, CollectedAt: timestamp(), Success: toolErr == nil}
	ev.SourceTruncated = obj(value)["truncated"] == true || len(content) > 256<<10
	content = utf8Prefix(content, 256<<10)
	ev.SourceBytes = len(content)
	if err := w.parent.storeAgentEvidence(ev, content); err != nil {
		return nil, fmt.Errorf("保存原始证据失败：%w", err)
	}
	ev.HasSource = true
	if len(ev.Excerpt) > 16384 {
		ev.Excerpt = utf8Prefix(ev.Excerpt, 16384) + " [TRUNCATED: page recorded source by evidence_id]"
	}
	if as, err := asset(c, resourceID); err == nil {
		ev.ResourceName, ev.AssetRef = as.Name, assetAlias(as.ID)
	}
	if obj(value)["exitCode"] != nil {
		code := num(obj(value)["exitCode"], 0)
		ev.ExitCode = &code
	}
	if err := w.parent.updateAgent(w, func(r *AgentRun) { r.Evidence = append(r.Evidence, ev); r.EvidenceIDs = append(r.EvidenceIDs, ev.ID) }); err != nil {
		return nil, err
	}
	if c.sre != nil && c.sre.AttemptID != "" && e.sreRepository != nil {
		if _, err := e.sreRepository.MutateSRETask(w.parentID, c.sre.TaskID, 0, "evidence_collected", func(t *SRETask) error {
			for i := range t.Attempts {
				if t.Attempts[i].ID == c.sre.AttemptID {
					t.Attempts[i].Evidence = append(t.Attempts[i].Evidence, ev)
					return nil
				}
			}
			return errors.New("证据没有绑定到运行中的步骤")
		}); err != nil {
			return nil, err
		}
	}
	modelExcerpt := content
	if len(modelExcerpt) > 4000 {
		if output, ok := obj(value)["output"].(string); ok && toolErr == nil {
			// JSON map ordering otherwise puts large parsed disk arrays before
			// the actual load/CPU/memory output and hides it from the model.
			for limit := 3000; limit > 0; limit /= 2 {
				modelExcerpt = redact(js(map[string]any{"output": utf8Prefix(output, limit), "exitCode": obj(value)["exitCode"], "preview_truncated": true}), c)
				if len(modelExcerpt) <= 4000 {
					break
				}
			}
		} else {
			modelExcerpt = utf8Prefix(modelExcerpt, 4000) + " [TRUNCATED: page recorded source by evidence_id]"
		}
	}
	result := map[string]any{"evidence_id": ev.ID, "resource": ev.ResourceName, "asset_ref": ev.AssetRef, "collected_at": ev.CollectedAt, "success": ev.Success, "exit_code": ev.ExitCode, "source_bytes": ev.SourceBytes, "source_truncated": ev.SourceTruncated, "observation": modelExcerpt, "observation_truncated": len(modelExcerpt) < len(content)}
	if c.sre != nil && c.sre.Role == SREInvestigator {
		result["read_hint"] = "Reuse this observation. If needed, page the recorded source using read_evidence mode=evidence, evidence_id, offset=0, limit<=4096; do not recollect because a preview is clipped."
	}
	return result, toolErr
}

var evidenceReference = regexp.MustCompile(`\bev_[a-f0-9]{32}\b`)
var unparsedAgentToolMarkup = regexp.MustCompile(`(?:[<＜]\s*[|｜]+\s*DSML\b|<tool_call>)`)

func validateAgentReferences(summary string, ids []string) error {
	known := map[string]bool{}
	for _, id := range ids {
		known[id] = true
	}
	refs := evidenceReference.FindAllString(summary, -1)
	if len(refs) == 0 {
		return errors.New("结论未引用已登记的证据，尚未通过核验。")
	}
	for _, ref := range refs {
		if !known[ref] {
			return errors.New("结论包含未经登记的证据引用，尚未通过核验。")
		}
	}
	return nil
}

func (e *Engine) rawAgentEvidence(s *session) []AgentEvidence {
	evidence := []AgentEvidence{}
	for _, run := range e.currentInvestigations(s) {
		if run.Role != "verify" {
			evidence = append(evidence, run.Evidence...)
		}
	}
	// Metadata also occupies context. Bound the number of previews rather than
	// spreading 8K excerpt bytes over an unbounded, much larger metadata list.
	evidence = evidence[:min(len(evidence), 8)]
	limit := 2048
	if len(evidence) > 0 {
		limit = min(limit, 6000/len(evidence))
	}
	for i := range evidence {
		if len(evidence[i].Excerpt) > limit {
			evidence[i].Excerpt = utf8Prefix(evidence[i].Excerpt, limit) + " [TRUNCATED: inspect full evidence in the task details]"
		}
	}
	return evidence
}
func (e *Engine) investigationReports(s *session, details bool) []map[string]any {
	out := []map[string]any{}
	limit := 2000
	if details {
		limit = 4000
	}
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	reviewStatus := "not_requested"
	for _, run := range e.currentInvestigations(s) {
		if run.Role == "verify" {
			reviewStatus = run.Status
		} else {
			reviewStatus = "not_requested"
		}
		summary := run.Summary
		if len(summary) > limit {
			summary = strings.ToValidUTF8(summary[:limit], "") + " [TRUNCATED: use agent details for the full report]"
		}
		resources := []map[string]any{}
		for _, id := range run.ResourceIDs {
			if as, err := asset(c, id); err == nil {
				resources = append(resources, map[string]any{"name": as.Name, "asset_ref": assetAlias(id), "kind": as.Kind})
			}
		}
		observations := []map[string]any{}
		for _, ev := range run.Evidence {
			observations = append(observations, map[string]any{"evidence_id": ev.ID, "resource": ev.ResourceName, "asset_ref": ev.AssetRef, "collected_at": ev.CollectedAt, "success": ev.Success, "exit_code": ev.ExitCode})
		}
		out = append(out, map[string]any{"run_id": run.ID, "name": run.Name, "role": run.Role, "status": run.Status, "summary": summary, "resources": resources, "observations": observations, "evidence_ids": run.EvidenceIDs})
	}
	for _, report := range out {
		report["verification_status"] = reviewStatus
	}
	if details {
		for _, ev := range e.rawAgentEvidence(s) {
			excerpt := ev.Excerpt
			if len(excerpt) > 512 {
				excerpt = excerpt[:512] + " [TRUNCATED]"
			}
			out = append(out, map[string]any{"evidence_id": ev.ID, "title": ev.Title, "excerpt": excerpt, "exitCode": ev.ExitCode})
		}
	}
	return out
}

// All persisted child files use the normal private signed-binary runtime; no Keychain reads.
