package ai

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func budgetWorkers(roles ...string) (*session, []*agentWorker) {
	s := &session{}
	workers := []*agentWorker{}
	for i, role := range roles {
		id := fmt.Sprint(i)
		s.state.View.AgentRuns = append(s.state.View.AgentRuns, AgentRun{ID: id, RootTurnID: "turn", Role: role, Status: "running"})
		workers = append(workers, &agentWorker{session: s, runID: id, turnID: "turn", role: role})
	}
	return s, workers
}

func TestAgentCumulativeLimitsScaleWithConfiguredContextAndRemainBounded(t *testing.T) {
	for _, row := range []struct{ context, child, turn int }{{0, 32000, 128000}, {16000, 32000, 128000}, {64000, 64000, 256000}, {1000000, 64000, 256000}} {
		child, turn := agentUsageLimits(Config{Model: Model{ContextWindow: row.context}})
		if child != row.child || turn != row.turn {
			t.Fatalf("context %d: child=%d turn=%d", row.context, child, turn)
		}
	}
	s, workers := budgetWorkers("host")
	s.state.Config.Model.ContextWindow = 64000
	s.state.View.AgentRuns[0].BudgetSpent = 25641
	if err := reserveAgentBudget(context.Background(), workers[0], 10000); err != nil {
		t.Fatal("actual retest report request was still rejected", err)
	}
	settleAgentBudget(workers[0], 10000, Usage{Total: 6000, Known: true}, true)
}

func TestChildCatalogClosesAfterObservationQuotaOrFinalReport(t *testing.T) {
	e := &Engine{worker: &agentWorker{role: "host"}}
	c := Config{Assets: []Asset{{ID: "host", Kind: "local"}}}
	if len(e.sessionCatalog(context.Background(), "child", c)) == 0 {
		t.Fatal("available observation tools missing")
	}
	e.worker.calls = agentObservationCallLimit
	if len(e.sessionCatalog(context.Background(), "child", c)) != 0 {
		t.Fatal("model can request another observation after quota")
	}
	e.worker.calls = 0
	e.worker.finalizing = true
	if len(e.sessionCatalog(context.Background(), "child", c)) != 0 {
		t.Fatal("model can request tools during final report")
	}
}

func TestAgentBudgetSettlesReportedUsageAndReleasesUnusedReservation(t *testing.T) {
	s, w := budgetWorkers("host")
	if err := reserveAgentBudget(context.Background(), w[0], 8000); err != nil {
		t.Fatal(err)
	}
	settleAgentBudget(w[0], 8000, Usage{Input: 1000, Output: 200, Total: 1200, Known: true}, true)
	if s.state.View.AgentRuns[0].BudgetSpent != 1200 || s.state.View.AgentRuns[0].budgetReserved != 0 {
		t.Fatal("unused output/input reservation retained")
	}
	if err := reserveAgentBudget(context.Background(), w[0], 8000); err != nil {
		t.Fatal(err)
	}
	settleAgentBudget(w[0], 8000, Usage{}, false)
	if s.state.View.AgentRuns[0].BudgetSpent != 1200 {
		t.Fatal("unsent request charged")
	}
	if err := reserveAgentBudget(context.Background(), w[0], 8000); err != nil {
		t.Fatal(err)
	}
	settleAgentBudget(w[0], 8000, Usage{}, true)
	if s.state.View.AgentRuns[0].BudgetSpent != 9200 {
		t.Fatal("missing provider usage not conservatively charged")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if reserveAgentBudget(ctx, w[0], 1000) == nil || s.state.View.AgentRuns[0].BudgetSpent != 9200 {
		t.Fatal("cancelled request charged")
	}
	s.state.View.AgentRuns[0].BudgetSpent = 31000
	if reserveAgentBudget(context.Background(), w[0], 2000) == nil {
		t.Fatal("per-child actual cap bypassed")
	}
}

func TestAgentBudgetWaitsForInFlightSettlementAndKeepsReviewAllocation(t *testing.T) {
	s, w := budgetWorkers("host", "host", "host", "host", "application", "verify")
	s.state.View.AgentRuns[0].BudgetSpent = 30000
	s.state.View.AgentRuns[0].budgetReserved = 10000
	for i := 1; i < 4; i++ {
		s.state.View.AgentRuns[i].BudgetSpent = 23000
	}
	done := make(chan error, 1)
	go func() { done <- reserveAgentBudget(context.Background(), w[4], 20000) }()
	select {
	case err := <-done:
		t.Fatalf("did not wait: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	settleAgentBudget(w[0], 10000, Usage{Input: 800, Output: 200, Total: 1000, Known: true}, true)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("did not wake after release")
	}
	settleAgentBudget(w[4], 20000, Usage{}, false)
	s.state.View.AgentRuns[4].BudgetSpent = 22000 // total actual = 112000
	if reserveAgentBudget(context.Background(), w[1], 1) == nil {
		t.Fatal("investigator consumed reserved review allocation")
	}
	if err := reserveAgentBudget(context.Background(), w[5], 12000); err != nil {
		t.Fatal("requested verifier was starved", err)
	}
	settleAgentBudget(w[5], 12000, Usage{Total: 10000, Known: true}, true)
}

func TestReportedFailedBatchBudgetReplayAdmitsAllSevenRequests(t *testing.T) {
	s, w := budgetWorkers("host", "host", "host", "host", "application", "data", "verify")
	oldEstimates := []int{21157, 27552, 26430, 17272, 20248, 13002}
	actual := []int{10513, 17322, 16163, 11203, 10360, 5671}
	for i, estimate := range oldEstimates {
		if err := reserveAgentBudget(context.Background(), w[i], estimate); err != nil {
			t.Fatalf("child %d: %v", i, err)
		}
		settleAgentBudget(w[i], estimate, Usage{Total: actual[i], Known: true}, true)
	}
	total := 0
	for _, r := range s.state.View.AgentRuns {
		total += r.BudgetSpent
	}
	if total != 71232 {
		t.Fatalf("charged %d instead of actual 71232", total)
	}
	if err := reserveAgentBudget(context.Background(), w[6], 10000); err != nil {
		t.Fatal("Beacon still starved", err)
	}
	settleAgentBudget(w[6], 10000, Usage{Total: 2000, Known: true}, true)
}

func TestSevenActualAgentsCompleteMultiRequestInvestigation(t *testing.T) {
	var mu sync.Mutex
	steps := map[string]int{}
	var path, alias string
	model, close := fakeModel(t, func(_ int, b map[string]any) any {
		if strings.Contains(str(obj(arr(b["messages"])[0])["content"]), "handoff summary") {
			return response("此前只读日志观察已完成，保留最新原始证据继续。")
		}
		role := fixtureRole(b)
		text := js(b["messages"])
		key := role
		if role == "application" {
			for i := 0; i < 6; i++ {
				if strings.Contains(text, fmt.Sprintf("JOB_%d", i)) {
					key = fmt.Sprintf("JOB_%d", i)
					break
				}
			}
		}
		mu.Lock()
		steps[key]++
		n := steps[key]
		mu.Unlock()
		var reply any
		if role == "parent" {
			if n == 1 {
				specs := []investigationSpec{}
				for i := 0; i < 6; i++ {
					specs = append(specs, investigationSpec{Role: "application", Task: fmt.Sprintf("JOB_%d: investigate raw logs", i), AssetRefs: []string{alias}})
				}
				specs = append(specs, investigationSpec{Role: "verify", Task: "Review original observations"})
				reply = response("", Call{"batch", "delegate_investigation", js(map[string]any{"tasks": specs})})
			} else {
				reply = response("七个子任务已完成。")
			}
		} else if role == "verify" && n == 1 {
			reply = response("", Call{"raw", "read_evidence", `{}`})
		} else if role == "application" && n <= 4 {
			log := path
			if n%2 == 0 {
				log = strings.TrimSuffix(path, ".log") + "-second.log"
			}
			reply = response("", Call{fmt.Sprint(n), "observe_logs", js(map[string]any{"asset_ref": alias, "path": log})})
		} else {
			ids := evidenceReference.FindAllString(text, -1)
			if len(ids) == 0 {
				t.Error("summary without raw evidence")
			}
			reply = response("观察结果与限制，依据 " + strings.Join(ids, " "))
		}
		reply.(map[string]any)["usage"] = map[string]any{"prompt_tokens": 1000, "completion_tokens": 50}
		return reply
	})
	defer close()
	e, log, ref := fixtureMultiEngine(t, model, true)
	path, alias = log, ref
	for _, file := range []string{path, strings.TrimSuffix(path, ".log") + "-second.log"} {
		if err := os.WriteFile(file, []byte(strings.Repeat("raw observed error details ", 300)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.Chat(context.Background(), "case", "并行调查并按证据复核", multiReferences()); err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("case")
	if len(view.AgentRuns) != 7 {
		t.Fatal("missing independent agents")
	}
	for _, run := range view.AgentRuns {
		if run.Status != "completed" || run.BudgetSpent != run.Usage.Total {
			t.Fatalf("%s %s: spent=%d usage=%d summary=%s", run.Name, run.Status, run.BudgetSpent, run.Usage.Total, run.Summary)
		}
	}
}

func TestSevenInvestigatorsAndOptionalVerifierFitInOneBatch(t *testing.T) {
	var path, alias string
	model, close := fakeModel(t, func(_ int, b map[string]any) any {
		hasResult := false
		for _, msg := range arr(b["messages"]) {
			hasResult = hasResult || str(obj(msg)["role"]) == "tool"
		}
		role := fixtureRole(b)
		if role == "parent" && !hasResult {
			specs := []investigationSpec{}
			for i := 0; i < 7; i++ {
				specs = append(specs, investigationSpec{Role: "application", Task: fmt.Sprintf("read service log %d", i), AssetRefs: []string{alias}})
			}
			specs = append(specs, investigationSpec{Role: "verify", Task: "review raw evidence"})
			return response("", Call{"batch", "delegate_investigation", js(map[string]any{"tasks": specs})})
		}
		if !hasResult && role == "application" {
			return response("", Call{"log", "observe_logs", js(map[string]any{"asset_ref": alias, "path": path})})
		}
		if !hasResult && role == "verify" {
			return response("", Call{"raw", "read_evidence", `{}`})
		}
		return response("已查阅原始证据 " + strings.Join(evidenceReference.FindAllString(js(b["messages"]), -1), " "))
	})
	defer close()
	e, log, ref := fixtureMultiEngine(t, model, true)
	path, alias = log, ref
	if err := e.Chat(context.Background(), "case", "并行调查并复核", multiReferences()); err != nil {
		t.Fatal(err)
	}
	view, _ := e.Snapshot("case")
	if len(view.AgentRuns) != 8 {
		t.Fatalf("valid eight-task batch rejected: %d runs", len(view.AgentRuns))
	}
	for _, run := range view.AgentRuns {
		if run.Status != "completed" {
			t.Fatalf("%s: %s %s", run.Name, run.Status, run.Summary)
		}
	}
}
