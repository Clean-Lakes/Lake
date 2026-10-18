package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestADKSRERoleCrashHelper(t *testing.T) {
	if os.Getenv("LAKE_ADK_ROLE_HELPER") != "1" {
		t.Skip("subprocess fixture")
	}
	b, err := New(context.Background(), Options{Home: os.Getenv("LAKE_ADK_ROLE_HOME"), Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	session, task := os.Getenv("LAKE_ADK_ROLE_SESSION"), os.Getenv("LAKE_ADK_ROLE_TASK")
	b.configure(session, nil)
	if err = b.Engine.StartSRETask(context.Background(), session, task, false, ""); err != nil {
		t.Fatal(err)
	}
}

func TestADKSRERoleApprovalSurvivesProcessCrash(t *testing.T) { testADKRoleCrash(t, false) }
func TestADKSRERoleQuestionSurvivesProcessCrash(t *testing.T) { testADKRoleCrash(t, true) }
func TestADKSRERoleQuestionRecoversBeforeBusinessWaitProjection(t *testing.T) {
	testADKRoleCrash(t, true, true)
}
func TestADKSRERoleApprovalRecoversBeforeBusinessWaitProjection(t *testing.T) {
	testADKRoleCrash(t, false, true)
}
func testADKRoleCrash(t *testing.T, question bool, projectionWindow ...bool) {
	home := t.TempDir()
	b, err := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(b)
	session, resource := newSession(t, h)
	target := filepath.Join(home, "effect.txt")
	plan := ai.SREPlanRevision{Goal: "append fixture once", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SRECoordinator, Kind: "analyze", Description: "append exact fixture", CompletionChecks: []string{"record actual append result"}, ResourceIDs: []string{resource}}}}
	providerClose := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		seen := false
		for _, m := range objects(input["messages"]) {
			seen = seen || m["role"] == "tool" && (m["name"] == "append" || m["name"] == "ask_user_question")
		}
		if !seen {
			if question {
				emitModel(w, "", []ai.Call{{ID: "role-question", Name: "ask_user_question", Arguments: jsonText(Object{"questions": []Object{{"id": "scope", "title": "Use the isolated fixture only?", "options": []Object{{"label": "fixture only"}}}}})}})
				return
			}
			emitModel(w, "", []ai.Call{{ID: "role-once", Name: "append", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "path": target, "content": "once\n", "runtime": "local"})}})
			return
		}
		emitModel(w, "recorded actual result", nil)
	})
	defer providerClose()
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "plan_only", "clientRequestId": "adk_role_crash"}, 202)
	taskID := stringOf(created["id"])
	for deadline := time.Now().Add(5 * time.Second); ; {
		task, _ := b.Store.LoadSRETask(session, taskID)
		view, _ := b.Engine.Snapshot(session)
		if len(task.Plans) > 0 && view.Status != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("plan did not settle: %s %s", task.Status, task.Error)
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.Close()
	b.Close()
	binary, _ := os.Executable()
	child := exec.Command(binary, "-test.run=^TestADKSRERoleCrashHelper$", "-test.timeout=30s")
	child.Env = append(os.Environ(), "LAKE_ADK_ROLE_HELPER=1", "LAKE_ADK_ROLE_HOME="+home, "LAKE_ADK_ROLE_SESSION="+session, "LAKE_ADK_ROLE_TASK="+taskID)
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	var pending ai.AgentRun
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		raw, _ := os.ReadFile(filepath.Join(home, "web-agent", "ai", session+".json"))
		var state ai.State
		_ = json.Unmarshal(raw, &state)
		for _, run := range state.View.AgentRuns {
			if run.Pending != nil || run.Question != nil {
				pending = run
			}
		}
		if pending.Pending != nil || pending.Question != nil {
			raw, _ = os.ReadFile(filepath.Join(home, "web-agent", "ai", "children", session, pending.ID+".json"))
			var childState ai.State
			_ = json.Unmarshal(raw, &childState)
			if childState.Runtime != nil && (question && childState.View.Question != nil || !question && childState.Runtime.PendingConfirmations[pending.Pending.ID] != "") {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pending.Pending == nil && pending.Question == nil {
		t.Fatal("no durable role confirmation")
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	if len(projectionWindow) > 0 && projectionWindow[0] {
		// Reproduce a crash after the role's durable wait/parent card but
		// before the separate business store projects waiting_input/approval.
		store, openErr := OpenStore(filepath.Join(home, "web-agent"))
		if openErr != nil {
			t.Fatal(openErr)
		}
		_, mutationErr := store.MutateSRETask(session, taskID, 0, "fixture_before_wait_projection", func(task *ai.SRETask) error {
			task.Status = "active"
			task.ActiveRun().Status = "running"
			for i := range task.Attempts {
				attempt := &task.Attempts[i]
				if attempt.RoleRunID == pending.ID {
					attempt.Status = "running"
					for j := range attempt.Operations {
						attempt.Operations[j].Status = "prepared"
						attempt.Operations[j].ApprovalID = ""
					}
				}
			}
			return nil
		})
		_ = store.Close()
		if mutationErr != nil {
			t.Fatal(mutationErr)
		}
	}
	recovered, err := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	rh := httptest.NewServer(recovered)
	defer rh.Close()
	defer recovered.Close()
	if question {
		apiTest(t, rh, "POST", "/api/sessions/"+session+"/ai/agentQuestionReply", Object{"runId": pending.ID, "id": pending.Question.ID, "answers": Object{"scope": []string{"fixture only"}}}, 200)
	} else {
		apiTest(t, rh, "POST", "/api/sessions/"+session+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": true, "confirmation": pending.Pending.Confirmation}, 200)
	}
	task := waitSRE(t, recovered, session, taskID, "completed", "paused")
	if task.Status != "completed" {
		t.Fatalf("role recovery failed: %s", task.Error)
	}
	data, err := os.ReadFile(target)
	if !question && (err != nil || string(data) != "once\n") {
		t.Fatalf("effect not exactly once: %q %v", data, err)
	}
	if question && !os.IsNotExist(err) {
		t.Fatal("question recovery executed an unrequested resource write")
	}
	if len(task.Attempts) != 1 || task.Attempts[0].RoleRunID != pending.ID {
		t.Fatal("recovery created a replacement attempt")
	}
	if !question {
		apiTest(t, rh, "POST", "/api/sessions/"+session+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": true}, 409)
	}
}
