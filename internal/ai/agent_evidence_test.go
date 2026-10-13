package ai

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRecordedAgentEvidencePagesFullRedactedSourceAcrossRestart(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("unused") })
	defer close()
	e, _, _ := fixtureMultiEngine(t, model, true)
	s, _ := e.get("case")
	s.state.View.RootTurnID = "turn"
	s.state.View.AgentRuns = []AgentRun{{ID: "run", SessionID: "case", RootTurnID: "turn", Role: "data", Status: "completed"}}
	child := &Engine{worker: &agentWorker{parent: e, session: s, parentID: "case", runID: "run"}}
	c := s.state.Config
	c.Model.Key = "fictional-fixture-credential"
	output := strings.Repeat("节点事件：完整明文；\n", 2200) + "POD_AT_END redis-2\n" + c.Model.Key
	value, err := child.recordObservation(c, "fixture-host", "observe_cluster", map[string]any{"output": output, "exitCode": 0, "truncated": false}, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := str(obj(value)["evidence_id"])
	ev := s.state.View.AgentRuns[0].Evidence[0]
	if !ev.HasSource || ev.SourceTruncated || strings.Contains(ev.Excerpt, "POD_AT_END") {
		t.Fatal("preview and source were not separated")
	}
	path, _ := e.evidencePath(ev)
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("source file permissions are not private", err)
	}
	e2, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e2.Shutdown()
	s2, err := e2.get("case")
	if err != nil {
		t.Fatal(err)
	}
	assembled, offset := "", 0
	for {
		page, ids, err := e2.readAgentEvidence(s2, map[string]any{"mode": "evidence", "evidence_id": id, "offset": offset, "limit": 4096})
		if err != nil {
			t.Fatal(err)
		}
		p := obj(page)
		if len(ids) != 1 || ids[0] != id || !utf8.ValidString(str(p["page"])) || p["legacy_preview_only"] != false {
			t.Fatal("invalid page provenance")
		}
		assembled += str(p["page"])
		if p["next_offset"] == nil {
			break
		}
		if num(p["next_offset"], 0) <= offset {
			t.Fatal("paging did not advance")
		}
		offset = num(p["next_offset"], 0)
	}
	want := redact(js(map[string]any{"output": output, "exitCode": 0, "truncated": false}), c)
	if assembled != want || strings.Contains(assembled, c.Model.Key) || !strings.Contains(assembled, "POD_AT_END") {
		t.Fatal("source lost its tail or leaked fixture credential")
	}
	if s2.state.View.AgentRuns[0].BudgetSpent != 0 {
		t.Fatal("reading evidence charged delegation allocation")
	}
	if _, _, err := e2.readAgentEvidence(s2, map[string]any{"mode": "evidence", "evidence_id": id, "path": "/tmp/escape"}); err == nil {
		t.Fatal("caller file path accepted")
	}
	other, _ := e2.get("other")
	if _, _, err := e2.readAgentEvidence(other, map[string]any{"mode": "evidence", "evidence_id": id}); err == nil {
		t.Fatal("cross-session evidence exposed")
	}
	s2.state.View.RootTurnID = "next"
	if _, _, err := e2.readAgentEvidence(s2, map[string]any{"mode": "evidence", "evidence_id": id}); err == nil {
		t.Fatal("old-turn evidence exposed as current")
	}
}

func TestAgentEvidenceIndexIsPagedAndLegacySourceLimitsAreExplicit(t *testing.T) {
	e := &Engine{}
	s, _ := budgetWorkers("data", "host")
	s.state.View.RootTurnID = "turn"
	s.state.Config.Model.ContextWindow = 64000
	s.state.View.AgentRuns[0].BudgetSpent = 195765
	for i := 0; i < 20; i++ {
		s.state.View.AgentRuns[0].Evidence = append(s.state.View.AgentRuns[0].Evidence, AgentEvidence{ID: "ev_" + uid(), RunID: "0", Excerpt: "legacy observation [TRUNCATED]"})
	}
	index, ids, err := e.readAgentEvidence(s, map[string]any{"mode": "index", "run_id": "0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(obj(index)["evidence_index"].([]map[string]any)) != 8 || num(obj(index)["next_offset"], 0) != 8 || num(obj(index)["agent_tokens_remaining"], 0) != 60235 || len(ids) != 0 {
		t.Fatal("index preview is unbounded or counted as original evidence")
	}
	previews, previewIDs, err := e.readAgentEvidence(s, map[string]any{})
	if err != nil || obj(previews)["coverage_limited"] != true || len(previewIDs) != 8 || len(js(previews)) > 12000 {
		t.Fatal("default evidence metadata can still overflow child context", err)
	}
	id := s.state.View.AgentRuns[0].Evidence[0].ID
	page, _, err := e.readAgentEvidence(s, map[string]any{"mode": "evidence", "evidence_id": id})
	if err != nil || obj(page)["legacy_preview_only"] != true || obj(page)["source_truncated"] != true {
		t.Fatal("legacy clipping presented as a complete source", err)
	}
	for _, params := range []map[string]any{{"mode": "index", "run_id": "other"}, {"mode": "index", "limit": 4096}, {"mode": "evidence", "evidence_id": "ev_" + uid()}, {"mode": "evidence", "evidence_id": id, "offset": -1}} {
		if _, _, err := e.readAgentEvidence(s, params); err == nil {
			t.Fatal("invalid range or ownership accepted")
		}
	}
	var preview map[string]any
	_ = json.Unmarshal([]byte(toolContextPreview(js(map[string]any{"evidence_id": id, "next_offset": 4096, "source_truncated": false, "resource": strings.Repeat("resource", 30), "page": strings.Repeat("中文日志", 10000)}), 512)), &preview)
	if str(preview["evidence_id"]) != id || num(preview["next_offset"], 0) != 4096 {
		t.Fatal("context preview lost recovery cursor")
	}
}

func TestCompletedEightTasksPermitFollowupWithinActualRemainingBudget(t *testing.T) {
	var logPath string
	model, close := fakeModel(t, func(_ int, b map[string]any) any {
		for _, msg := range arr(b["messages"]) {
			if str(obj(msg)["role"]) == "tool" {
				return response("依据 " + strings.Join(evidenceReference.FindAllString(js(b["messages"]), -1), " "))
			}
		}
		return response("", Call{"log", "observe_logs", js(map[string]any{"asset_ref": assetAlias("fixture-host"), "path": logPath})})
	})
	defer close()
	e, path, ref := fixtureMultiEngine(t, model, true)
	logPath = path
	s, _ := e.get("case")
	s.state.View.RootTurnID = "turn"
	s.state.RootQuestion = "继续调查"
	s.state.Config.Model.ContextWindow = 64000
	s.state.Config.ReferencedAssets = []string{"fixture-host"}
	for i := 0; i < 8; i++ {
		role := "host"
		if i == 7 {
			role = "verify"
		}
		s.state.View.AgentRuns = append(s.state.View.AgentRuns, AgentRun{ID: uid(), RootTurnID: "turn", Role: role, Status: "completed"})
	}
	s.state.View.AgentRuns[0].BudgetSpent = 195765
	if _, err := e.runInvestigations(context.Background(), s, s.state.Config, []investigationSpec{{Role: "application", Task: "补采特定日志", AssetRefs: []string{ref}}}); err != nil {
		t.Fatal("follow-up incorrectly refused", err)
	}
	if len(s.state.View.AgentRuns) != 9 || s.state.View.AgentRuns[8].Status != "completed" {
		t.Fatal("follow-up did not complete")
	}
	for len(s.state.View.AgentRuns) < turnAgentTaskLimit {
		s.state.View.AgentRuns = append(s.state.View.AgentRuns, AgentRun{ID: uid(), RootTurnID: "turn", Status: "completed"})
	}
	_, err := e.runInvestigations(context.Background(), s, s.state.Config, []investigationSpec{{Role: "application", Task: "limit", AssetRefs: []string{ref}}})
	if err == nil || !strings.Contains(err.Error(), "数量") || !strings.Contains(err.Error(), "不是用量预算耗尽") {
		t.Fatal("task-count error still conflates limits", err)
	}
	s.state.View.AgentRuns = s.state.View.AgentRuns[:8]
	s.state.View.AgentRuns[0].BudgetSpent = 256000
	_, err = e.runInvestigations(context.Background(), s, s.state.Config, []investigationSpec{{Role: "application", Task: "limit", AssetRefs: []string{ref}}})
	if err == nil || !strings.Contains(err.Error(), "已用 256000 / 256000") {
		t.Fatal("token error lacks actual allocation", err)
	}
}
