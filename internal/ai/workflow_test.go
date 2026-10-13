package ai

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkflowExecutesSavedOrderBeforeRootModel(t *testing.T) {
	var alias, log string
	var mu sync.Mutex
	calls := map[string]int{}
	order := []string{}
	var rootCalls atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, b map[string]any) any {
		role := fixtureRole(b)
		content := js(b["messages"])
		if role == "parent" {
			rootCalls.Add(1)
			if len(arr(b["tools"])) != 0 {
				t.Error("workflow summarizer received execution tools")
			}
			mu.Lock()
			joined := strings.Join(order, ",")
			mu.Unlock()
			if joined != "first,second,verify" {
				t.Errorf("root model ran before workflow finished: %s", joined)
			}
			return response("WORKFLOW_FINAL_REPORT")
		}
		key := role
		if role == "application" {
			for _, message := range arr(b["messages"]) {
				if str(obj(message)["role"]) == "user" {
					goal := str(obj(message)["content"])
					if strings.Contains(goal, "Assigned goal:\nSTEP_TWO") {
						key = "second"
					} else {
						key = "first"
					}
					break
				}
			}
		}
		mu.Lock()
		calls[key]++
		n := calls[key]
		if n == 1 {
			order = append(order, key)
		}
		mu.Unlock()
		if n == 1 {
			if role == "verify" {
				return response("", Call{"raw", "read_evidence", `{}`})
			}
			return response("", Call{"log", "observe_logs", js(map[string]any{"asset_ref": alias, "path": log})})
		}
		if role == "verify" && strings.Contains(content, "STEP_ONE_PRIVATE_RESULT") {
			t.Error("verifier inherited investigator conclusion")
		}
		prefix := "Evidence result"
		if key == "first" {
			prefix = "STEP_ONE_PRIVATE_RESULT"
		}
		if key == "second" && !strings.Contains(content, "STEP_ONE_PRIVATE_RESULT") {
			t.Error("second step did not receive bounded handoff")
		}
		return response(prefix + ": " + strings.Join(evidenceReference.FindAllString(content, -1), ", "))
	})
	defer closeModel()
	engine, path, ref := fixtureMultiEngine(t, model, true)
	log, alias = path, ref
	steps := []WorkflowStep{{ID: "first", Role: "application", Task: "STEP_ONE", ResourceIDs: []string{"fixture-host"}}, {ID: "second", Role: "application", Task: "STEP_TWO", ResourceIDs: []string{"fixture-host"}}}
	if err := engine.ChatWorkflow(context.Background(), "case", "Investigate log errors", steps); err != nil {
		t.Fatal(err)
	}
	view, err := engine.Snapshot("case")
	if err != nil {
		t.Fatal(err)
	}
	if view.Status != "completed" || len(view.AgentRuns) != 3 || rootCalls.Load() != 1 {
		t.Fatalf("wrong completion status=%s runs=%d root=%d", view.Status, len(view.AgentRuns), rootCalls.Load())
	}
	for i, expected := range []string{"first", "second", "_verify"} {
		if run := view.AgentRuns[i]; run.WorkflowStepID != expected || run.Status != "completed" || len(run.EvidenceIDs) == 0 {
			t.Fatalf("wrong step: %+v", run)
		}
	}
	history, _ := engine.History("case")
	if err := validHistory(history); err != nil {
		t.Fatal(err)
	}
}
func TestWorkflowPrevalidatesEntirePlan(t *testing.T) {
	var requests atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { requests.Add(1); return response("unexpected") })
	defer closeModel()
	engine, _, _ := fixtureMultiEngine(t, model, true)
	for _, bad := range []WorkflowStep{{ID: "second", Role: "change", Task: "restart", ResourceIDs: []string{"fixture-host"}}, {ID: "second", Role: "data", Task: "health", ResourceIDs: []string{"fixture-host"}}, {ID: "second", Role: "host", Task: "health", ResourceIDs: []string{"outside"}}, {ID: "first", Role: "host", Task: "health", ResourceIDs: []string{"fixture-host"}}} {
		err := engine.ChatWorkflow(context.Background(), "case", "Investigation", []WorkflowStep{{ID: "first", Role: "host", Task: "valid", ResourceIDs: []string{"fixture-host"}}, bad})
		if err == nil {
			t.Error("invalid plan accepted")
		}
	}
	if requests.Load() != 0 {
		t.Fatal("model ran before plan validation")
	}
}
func TestWorkflowFailedStepStopsRemainingSteps(t *testing.T) {
	model, closeModel := fakeModel(t, func(_ int, b map[string]any) any { return response("No evidence was gathered") })
	defer closeModel()
	engine, _, _ := fixtureMultiEngine(t, model, true)
	err := engine.ChatWorkflow(context.Background(), "case", "Investigation", []WorkflowStep{{ID: "first", Role: "host", Task: "check", ResourceIDs: []string{"fixture-host"}}, {ID: "second", Role: "host", Task: "check again", ResourceIDs: []string{"fixture-host"}}})
	if err == nil {
		t.Fatal("unsupported conclusion counted as successful workflow")
	}
	view, _ := engine.Snapshot("case")
	if view.Status != "failed" || len(view.AgentRuns) != 1 || view.AgentRuns[0].Status != "failed" {
		t.Fatal("failed step did not stop remaining plan")
	}
}
func TestWorkflowAbortStopsApprovalAndRemainingSteps(t *testing.T) {
	for _, stop := range []string{"turn", "child"} {
		t.Run(stop, func(t *testing.T) {
			var alias, log string
			model, closeModel := fakeModel(t, func(_ int, b map[string]any) any {
				return response("", Call{"read", "observe_logs", js(map[string]any{"asset_ref": alias, "path": log})})
			})
			defer closeModel()
			engine, path, ref := fixtureMultiEngine(t, model, false)
			alias, log = ref, path
			done := make(chan error, 1)
			go func() {
				done <- engine.ChatWorkflow(context.Background(), "case", "Investigation", []WorkflowStep{{ID: "first", Role: "application", Task: "read log", ResourceIDs: []string{"fixture-host"}}, {ID: "second", Role: "application", Task: "read again", ResourceIDs: []string{"fixture-host"}}})
			}()
			deadline := time.Now().Add(5 * time.Second)
			for {
				view, _ := engine.Snapshot("case")
				if len(view.AgentRuns) > 0 && view.AgentRuns[0].Pending != nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("child did not reach approval")
				}
				time.Sleep(10 * time.Millisecond)
			}
			var stopErr error
			if stop == "turn" {
				stopErr = engine.Abort("case")
			} else {
				view, _ := engine.Snapshot("case")
				stopErr = engine.CancelAgent("case", view.AgentRuns[0].ID)
			}
			if stopErr != nil {
				t.Fatal(stopErr)
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("abort reported success")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("abort did not stop workflow")
			}
			view, _ := engine.Snapshot("case")
			if view.Status != "cancelled" || len(view.AgentRuns) != 1 {
				t.Fatalf("wrong cancelled workflow: %s, %d", view.Status, len(view.AgentRuns))
			}
		})
	}
}
