package web

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSRELegacyResumeReplansParallelRolesWithoutRepeatingCompletedEvidence(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	path := filepath.Join(t.TempDir(), "sample.log")
	must(os.WriteFile(path, []byte("actual remaining check"), 0600))
	mk := func(id, description string) ai.SREPlanStep {
		return ai.SREPlanStep{ID: id, Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: description, ResourceIDs: []string{resource}, CompletionChecks: []string{"记录实际证据"}}
	}
	plan := ai.SREPlanRevision{ID: "old_plan", TaskID: "task", Version: 1, Goal: "只读检查服务与日志", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{mk("done", "已完成的负载采集"), mk("services", "核对服务状态"), mk("logs", "核对错误日志"), {ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "汇总服务与日志", ResourceIDs: []string{resource}, DependsOn: []string{"done", "services", "logs"}, CompletionChecks: []string{"核对事实与缺口"}}}}
	candidate := plan
	candidate.Steps = append([]ai.SREPlanStep(nil), plan.Steps...)
	candidate.Steps[1].Kind, candidate.Steps[1].Role = "verify", ai.SREVerifier
	var planning, arrived, reads atomic.Int32
	barrier := make(chan struct{})
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			planning.Add(1)
			if !strings.Contains(content, "Upgrade this legacy read-only investigation") || !strings.Contains(content, "recorded_old_evidence") {
				t.Error("upgrade planning lost continuation constraints or evidence")
			}
			emitModel(w, jsonText(candidate), nil)
			return
		}
		if strings.Contains(content, "Assigned deliverable: 已完成的负载采集") {
			t.Error("completed observation ran again")
		}
		if strings.Contains(content, "Assigned deliverable: 汇总服务与日志") {
			emitModel(w, "已结合沿用取证与两位专员的新采样汇总。", nil)
			return
		}
		tools := []Object{}
		for _, m := range objects(input["messages"]) {
			if m["role"] == "tool" {
				tools = append(tools, m)
			}
		}
		if len(tools) == 0 {
			if arrived.Add(1) == 2 {
				close(barrier)
			}
			select {
			case <-barrier:
			case <-time.After(5 * time.Second):
				t.Error("legacy upgrade still ran serially")
				reply(w, 500, Object{})
				return
			}
			reads.Add(1)
			emitModel(w, "执行本次独立核对。", []ai.Call{{ID: "sample", Name: "read", Arguments: jsonText(Object{"runtime": "local", "asset_ref": sreAliasForTest(resource), "path": path})}})
			return
		}
		if strings.Contains(content, "Lake's investigator") {
			id := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindString(stringOf(tools[0]["content"]))
			emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "日志已核对", "facts": []Object{{"statement": "本次读取实际日志", "evidenceIds": []string{id}}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
		} else {
			emitModel(w, "已独立读取本次样本，未执行变更。", nil)
		}
	})
	defer closeProvider()
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, Goal: plan.Goal, Scope: plan.Scope, Mode: "assist", RequestID: "legacy_parallel", TokenBudget: 12800000})
	must(err)
	_, err = b.Store.MutateSRETask(session, task.ID, 0, "legacy_fixture", func(v *ai.SRETask) error {
		v.Plans = []ai.SREPlanRevision{plan}
		v.Status = "paused"
		v.Runs = []ai.SREPlanRun{{ID: "old_run", TaskID: v.ID, PlanRevisionID: plan.ID, Status: "paused"}}
		v.Attempts = []ai.SREStepAttempt{{ID: "completed_observation", PlanRunID: "old_run", StepID: "done", Status: "succeeded", StartedAt: "2026-10-16T01:00:00Z", FinishedAt: "2026-10-16T01:01:00Z", Result: "已完成，不能重新采样", Evidence: []ai.AgentEvidence{{ID: "recorded_old_evidence", SessionID: session, ResourceID: resource, CollectedAt: "2026-10-16T01:00:00Z", Success: true}}}}
		return nil
	})
	must(err)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"contextWindow": 128000, "maxOutput": 8192}, 200)
	if err = b.Engine.ResumeSRETask(context.Background(), session, task.ID); err != nil {
		t.Fatal(err)
	}
	task, err = b.Store.LoadSRETask(session, task.ID)
	must(err)
	if task.Status != "completed" || planning.Load() != 1 || arrived.Load() != 2 || reads.Load() != 2 {
		t.Fatal("legacy upgrade did not complete", task.Status, planning.Load(), arrived.Load(), reads.Load())
	}
	if len(task.Plans) != 2 || task.LatestPlan().CollaborationVersion != 1 || task.Plans[0].Steps[1].Role != ai.SREInvestigator || task.Runs[0].Status != "superseded" {
		t.Fatal("immutable revision history lost")
	}
	count := 0
	for _, a := range task.Attempts {
		if a.StepID == "done" {
			count++
			if a.ID != "completed_observation" {
				if a.ReusedFromAttemptID != "completed_observation" || len(a.Evidence) != 1 || a.Evidence[0].CollectedAt != "2026-10-16T01:00:00Z" || a.FinishedAt != "2026-10-16T01:01:00Z" {
					t.Error("original evidence provenance/time lost")
				}
			}
		}
	}
	if count != 2 {
		t.Fatal("completed observation not carried exactly once", count)
	}
	raw, _ := json.Marshal(task.Messages)
	if !strings.Contains(string(raw), "重新安排剩余专员") || !strings.Contains(string(raw), "按新分工协作") {
		t.Error("upgrade not visible in conversation")
	}
	cancelled, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, Goal: plan.Goal, Scope: plan.Scope, Mode: "assist", RequestID: "cancelled_upgrade", TokenBudget: 12800000})
	must(err)
	_, err = b.Store.MutateSRETask(session, cancelled.ID, 0, "cancel_fixture", func(v *ai.SRETask) error {
		v.Plans, v.Status = []ai.SREPlanRevision{plan}, "paused"
		v.Runs = []ai.SREPlanRun{{ID: "cancelled_old", TaskID: v.ID, PlanRevisionID: plan.ID, Status: "paused"}}
		v.Attempts = []ai.SREStepAttempt{{ID: "cancelled_completed", PlanRunID: "cancelled_old", StepID: "done", Status: "succeeded"}}
		return nil
	})
	must(err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = b.Engine.ResumeSRETask(ctx, session, cancelled.ID); err == nil {
		t.Fatal("cancelled upgrade did not stop")
	}
	cancelled, err = b.Store.LoadSRETask(session, cancelled.ID)
	must(err)
	if len(cancelled.Plans) != 1 || len(cancelled.Attempts) != 1 || planning.Load() != 1 || reads.Load() != 2 {
		t.Fatal("cancellation changed the plan or performed more work")
	}
}
