package ai

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func sreObservationFixture(t *testing.T, model Model) (*Engine, *Engine, *session, Config, string) {
	t.Helper()
	parent, logPath, _ := fixtureMultiEngine(t, model, true)
	s, _ := parent.get("case")
	s.state.View.RootTurnID = "turn"
	s.state.ReferencedAssetIDs = []string{"fixture-host"}
	s.state.View.AgentRuns = []AgentRun{{ID: "own", SessionID: "case", RootTurnID: "turn", Role: "host", Status: "running"}, {ID: "sibling", SessionID: "case", RootTurnID: "turn", Role: "host", Status: "completed"}}
	c := s.state.Config
	c.sre = &sreRoleContext{Role: SREInvestigator, Step: SREPlanStep{Role: SREInvestigator}}
	c.agentRole = string(SREInvestigator)
	c.MultiAgentMode = "off"
	c.MaxSteps = 6
	c.Model.MaxOutput = 1024
	c.Model.ContextWindow = 16000
	child, err := New(filepath.Join(parent.Dir, "test-child"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(child.Shutdown)
	child.worker = &agentWorker{parent: parent, session: s, parentID: "case", runID: "own", turnID: "turn", role: "host", assets: []string{"fixture-host"}, reads: map[string]int{}}
	if err := child.Configure("own", c); err != nil {
		t.Fatal(err)
	}
	return parent, child, s, c, logPath
}

func TestHostObservationPreviewKeepsCPUAndMemoryBeforeLargeDiskMetadata(t *testing.T) {
	parent, child, s, c, _ := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	disks := []map[string]any{}
	for i := 0; i < 200; i++ {
		disks = append(disks, map[string]any{"mount": "/var/lib/containers/storage/overlay/" + strings.Repeat("a", 64), "available_percent": 79.6})
	}
	c.Model.Key = "fixture-secret-must-not-appear"
	output := "load average: 0.10, 0.08, 0.09\nCPU idle 98%\nMem available 2751 MiB\n" + c.Model.Key + strings.Repeat("overlay filesystem\n", 400)
	value, err := child.recordObservation(c, "fixture-host", "observe_host", map[string]any{"disks": disks, "output": output, "exitCode": 0}, nil)
	if err != nil {
		t.Fatal(err)
	}
	preview := str(obj(value)["observation"])
	for _, metric := range []string{"load average: 0.10", "CPU idle 98%", "Mem available 2751"} {
		if !strings.Contains(preview, metric) {
			t.Fatal("important output hidden behind disk arrays", metric)
		}
	}
	if len(preview) > 4000 || !json.Valid([]byte(preview)) || strings.Contains(preview, c.Model.Key) || obj(value)["observation_truncated"] != true || obj(value)["source_truncated"] != false {
		t.Fatal("invalid bounded preview or lost provenance")
	}
	id := str(obj(value)["evidence_id"])
	page, _, err := parent.readAgentEvidence(s, map[string]any{"mode": "evidence", "evidence_id": id, "limit": 4096}, "own")
	if err != nil || !strings.Contains(str(obj(page)["page"]), "/var/lib/containers") {
		t.Fatal("full parsed source was lost", err)
	}
}

func TestSREInvestigatorReusesSamplesAndCanPageOnlyItsOwnEvidence(t *testing.T) {
	_, child, s, c, logPath := sreObservationFixture(t, Model{URL: "http://localhost:1", Name: "fixture"})
	call := Call{ID: "first", Name: "observe_logs", Arguments: js(map[string]any{"asset_ref": assetAlias("fixture-host"), "path": logPath})}
	cs, _ := child.get("own")
	first, err := child.invoke(context.Background(), cs, c, call)
	if err != nil {
		t.Fatal(err)
	}
	call.ID = "second"
	second, err := child.invoke(context.Background(), cs, c, call)
	if err != nil || obj(second)["evidence_id"] != obj(first)["evidence_id"] || obj(second)["collected_at"] != obj(first)["collected_at"] || obj(second)["reused"] != true || len(s.state.View.AgentRuns[0].Evidence) != 1 {
		t.Fatal("identical probe reran or acquired a fresh timestamp", err)
	}
	page, err := child.invoke(context.Background(), cs, c, Call{ID: "page", Name: "read_evidence", Arguments: js(map[string]any{"mode": "evidence", "evidence_id": obj(first)["evidence_id"], "limit": 4096})})
	if err != nil || !strings.Contains(str(obj(page)["page"]), "FIXTURE_RAW_EVIDENCE") {
		t.Fatal("investigator cannot recover its actual source", err)
	}
	s.state.View.AgentRuns[1].Evidence = []AgentEvidence{{ID: "ev_" + strings.Repeat("b", 32), RunID: "sibling", Excerpt: "SIBLING_SECRET_FACT", Success: true}}
	_, err = child.invoke(context.Background(), cs, c, Call{ID: "foreign", Name: "read_evidence", Arguments: js(map[string]any{"mode": "evidence", "evidence_id": s.state.View.AgentRuns[1].Evidence[0].ID})})
	if err == nil {
		t.Fatal("sibling evidence was exposed as investigator-owned evidence")
	}
}

func TestSREInvestigatorCollectionDeadlineLeavesTimeForReport(t *testing.T) {
	var calls atomic.Int32
	model, close := fakeModel(t, func(_ int, body map[string]any) any {
		if calls.Add(1) == 1 {
			time.Sleep(2 * time.Second)
			return response("late provisional answer")
		}
		if len(arr(body["tools"])) != 0 {
			t.Error("resource tools remained available during report reserve")
		}
		return response("bounded final report")
	})
	defer close()
	_, child, _, _, _ := sreObservationFixture(t, model)
	// Measure collection/report behavior after durable SDK schema setup, rather
	// than making a busy race-enabled CI runner finish that setup in 250ms.
	if _, err := child.adkStore(); err != nil {
		t.Fatal(err)
	}
	child.worker.sreReportAt = time.Now().Add(time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	if err := child.Chat(ctx, "own", "finish the assigned report", nil); err != nil {
		t.Fatal("collection deadline cancelled the report reserve", err)
	}
	view, _ := child.Snapshot("own")
	if calls.Load() != 2 || view.Status != "completed" {
		t.Fatal("missing bounded report retry", calls.Load(), view.Status)
	}
}

func TestSREInvestigatorCompactsWithoutAnotherModelRequest(t *testing.T) {
	var calls atomic.Int32
	model, close := fakeModel(t, func(_ int, _ map[string]any) any {
		calls.Add(1)
		return response("unexpected compaction request")
	})
	defer close()
	_, child, _, c, _ := sreObservationFixture(t, model)
	cs, _ := child.get("own")
	id := "ev_" + strings.Repeat("c", 32)
	cs.state.History = []Message{{Role: "system", Content: "investigator"}, {Role: "user", Content: "check"}, {Role: "assistant", Calls: []Call{{ID: "probe", Name: "observe_host", Arguments: "{}"}}, Reasoning: strings.Repeat("old reasoning ", 4000)}, {Role: "tool", CallID: "probe", Content: js(map[string]any{"evidence_id": id, "observation": strings.Repeat("disk data ", 6000)})}}
	if err := child.compact(context.Background(), cs, c, false); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 || validHistory(cs.state.History) != nil || !strings.Contains(js(cs.state.History), id) {
		t.Fatal("compaction used model time or discarded source identity")
	}
}

func TestSREInvestigatorQuotaStopsRepeatCollectionAndProducesReport(t *testing.T) {
	var logPath string
	var calls atomic.Int32
	model, close := fakeModel(t, func(_ int, body map[string]any) any {
		calls.Add(1)
		if len(arr(body["tools"])) > 0 {
			return response("", Call{ID: uid(), Name: "observe_logs", Arguments: js(map[string]any{"asset_ref": assetAlias("fixture-host"), "path": logPath})})
		}
		ids := evidenceReference.FindAllString(js(body["messages"]), -1)
		if len(ids) == 0 {
			t.Error("report lost the recorded evidence ID")
		}
		return response(js(SRERoleReport{SchemaVersion: 1, Summary: "已记录事实，尚缺业务指标", Facts: []SREFact{{Statement: "读取到测试日志", EvidenceIDs: ids[:min(1, len(ids))]}}, Unknowns: []string{"业务指标尚未采集"}}))
	})
	defer close()
	_, child, parentSession, _, path := sreObservationFixture(t, model)
	logPath = path
	child.worker.sreReportAt = time.Now().Add(time.Minute)
	if err := child.Chat(context.Background(), "own", "只读取证并报告", nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != sreInvestigatorCallLimit+1 || len(parentSession.state.View.AgentRuns[0].Evidence) != 1 || !child.worker.finalizing {
		t.Fatal("repeated tool calls did not end in a bounded report", calls.Load())
	}
	view, _ := child.Snapshot("own")
	var report SRERoleReport
	for _, card := range view.Cards {
		if card.Type == "message" && card.Content != "" {
			_ = json.Unmarshal([]byte(card.Content), &report)
		}
	}
	if err := ValidateSRERoleReport(report, parentSession.state.View.AgentRuns[0].Evidence); err != nil {
		t.Fatal("quota caused an invalid or fabricated report", err)
	}
}
