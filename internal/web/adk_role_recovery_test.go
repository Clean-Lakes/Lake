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
func TestPilotChoiceSurvivesProcessCrash(t *testing.T)        { testADKRoleCrash(t, true, false, true) }
func TestADKSRERoleQuestionRecoversBeforeBusinessWaitProjection(t *testing.T) {
	testADKRoleCrash(t, true, true)
}
func TestADKSRERoleApprovalRecoversBeforeBusinessWaitProjection(t *testing.T) {
	testADKRoleCrash(t, false, true)
}
func testADKRoleCrash(t *testing.T, question bool, projectionWindow ...bool) {
	pilot := len(projectionWindow) > 1 && projectionWindow[1]
	home := t.TempDir()
	b, err := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(b)
	session, resource := newSession(t, h)
	target := filepath.Join(home, "effect.txt")
	if pilot {
		if err := os.WriteFile(target, []byte("PILOT_CRASH_SOURCE"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	plan := ai.SREPlanRevision{Goal: "append fixture once", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SRECoordinator, Kind: "analyze", Description: "append exact fixture", CompletionChecks: []string{"record actual append result"}, ResourceIDs: []string{resource}}}}
	providerClose := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		seen := false
		pilotChosen, pilotRead := false, false
		for _, m := range objects(input["messages"]) {
			seen = seen || m["role"] == "tool" && (m["name"] == "append" || m["name"] == "ask_user_question")
			pilotChosen = pilotChosen || m["role"] == "tool" && m["name"] == "pilot_offer_directions"
			pilotRead = pilotRead || m["role"] == "tool" && m["name"] == "read"
		}
		if pilot {
			args := Object{"asset_ref": sreAliasForTest(resource), "path": target}
			if !pilotChosen {
				emitModel(w, "", []ai.Call{{ID: "pilot-choice", Name: "pilot_offer_directions", Arguments: jsonText(Object{"single_direction_reason": "此恢复夹具要求只读取指定的唯一文件，不允许检查其他来源", "directions": []Object{{"id": "inspect", "title": "核对隔离文件", "reason": "取得恢复后的实际证据", "operations": []Object{{"id": "read_source", "title": "读取原文件", "tool": "read", "arguments": args}}}, {"id": "directory-first", "title": "先核对目录再读取", "reason": "核对目标文件的目录元数据后取得完整内容", "operations": []Object{{"id": "list_parent", "title": "核对父目录", "tool": "ls", "arguments": Object{"asset_ref": sreAliasForTest(resource), "path": filepath.Dir(target)}}, {"id": "read_after_list", "title": "读取原文件", "tool": "read", "arguments": args, "dependsOn": []string{"list_parent"}}}}}})}})
				return
			}
			if !pilotRead {
				emitModel(w, "", []ai.Call{{ID: "pilot-read", Name: "read", Arguments: jsonText(args)}})
				return
			}
			emitModel(w, "已读取隔离文件并保存结果。", nil)
			return
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
	if pilot {
		project := stringOf(b.Store.Session(session)["projectId"])
		settings := b.Store.PilotSettings(project)
		apiTest(t, h, "PUT", "/api/projects/"+project+"/pilot", Object{"enabled": true, "expectedRevision": settings["revision"]}, 200)
	}
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
	child := exec.Command(binary, "-test.run=^TestADKSRERoleCrashHelper$", "-test.timeout=60s")
	child.Env = append(os.Environ(), "LAKE_ADK_ROLE_HELPER=1", "LAKE_ADK_ROLE_HOME="+home, "LAKE_ADK_ROLE_SESSION="+session, "LAKE_ADK_ROLE_TASK="+taskID)
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	var pending ai.AgentRun
	// Cold native SQLite setup in a Windows subprocess can exceed 15 seconds.
	// Wait for the same durable parent/child state before deliberately crashing.
	for deadline := time.Now().Add(45 * time.Second); time.Now().Before(deadline); {
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
		answers := Object{"scope": []string{"fixture only"}}
		if pilot {
			answers = Object{pending.Question.Questions[0].ID: []string{jsonText(Object{"level": "command", "directionId": "inspect", "operationIds": []string{"read_source"}})}}
		}
		apiTest(t, rh, "POST", "/api/sessions/"+session+"/ai/agentQuestionReply", Object{"runId": pending.ID, "id": pending.Question.ID, "answers": answers}, 200)
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
	if question && !pilot && !os.IsNotExist(err) {
		t.Fatal("question recovery executed an unrequested resource write")
	}
	if pilot && (err != nil || string(data) != "PILOT_CRASH_SOURCE" || task.Pilot == nil || len(task.Pilot.Decisions) != 1 || len(task.Attempts[0].Operations) != 1 || task.Attempts[0].Operations[0].Status != "succeeded") {
		t.Fatal("Pilot crash recovery lost identity or repeated/omitted its effect", err)
	}
	if len(task.Attempts) != 1 || task.Attempts[0].RoleRunID != pending.ID {
		t.Fatal("recovery created a replacement attempt")
	}
	if !question {
		apiTest(t, rh, "POST", "/api/sessions/"+session+"/ai/agentDecision", Object{"runId": pending.ID, "id": pending.Pending.ID, "accept": true}, 409)
	}
}
