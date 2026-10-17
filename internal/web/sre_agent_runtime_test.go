package web

import (
	"encoding/json"
	"fmt"
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

func TestSREFullAgentContinuesBeyondOldUsageToolAndRoundLimits(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	dir := t.TempDir()
	for i := 0; i < 35; i++ {
		must(os.WriteFile(filepath.Join(dir, fmt.Sprintf("part-%d.log", i)), []byte(fmt.Sprintf("actual source %d\n", i)), 0600))
	}
	plan := ai.SREPlanRevision{Goal: "逐批核对完整日志", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "application", Description: "逐批核对 35 个独立日志文件", ResourceIDs: []string{resource}, CompletionChecks: []string{"各批次实际读取并形成报告"}}}}
	var rounds atomic.Int32
	closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		if integer(input["max_tokens"]) != 8192 {
			t.Error("specialist output ceiling still reduced below the parent's setting")
		}
		if !strings.Contains(content, "PARENT_RUNTIME_PREFERENCE") {
			t.Error("specialist lost parent session preferences")
		}
		n := rounds.Add(1)
		msg := Object{"content": ""}
		if n <= 35 {
			if len(objects(input["tools"])) == 0 {
				t.Error("specialist prematurely entered the old report-only phase")
			}
			msg["content"] = fmt.Sprintf("继续核对第 %d 批。", n)
			msg["tool_calls"] = []Object{{"id": fmt.Sprint(n), "type": "function", "function": Object{"name": "read", "arguments": jsonText(Object{"asset_ref": sreAliasForTest(resource), "path": filepath.Join(dir, fmt.Sprintf("part-%d.log", n-1)), "runtime": "local"})}}}
		} else {
			ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)
			if len(ids) == 0 {
				t.Error("actual evidence was lost")
				ids = []string{"missing"}
			}
			msg["content"] = jsonText(Object{"schemaVersion": 1, "summary": "35 个日志批次均已核对", "facts": []Object{{"statement": "最后一个批次返回实际内容", "evidenceIds": ids[len(ids)-1:]}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}})
		}
		reply(w, 200, Object{"choices": []Object{{"index": 0, "message": msg, "finish_reason": "stop"}}, "usage": Object{"prompt_tokens": 30000, "completion_tokens": 500, "total_tokens": 30500}})
	})
	defer closeProvider()
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"contextWindow": 128000, "maxOutput": 8192, "maxSteps": 40, "userPrompt": "PARENT_RUNTIME_PREFERENCE"}, 200)
	created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "plan_only", "clientRequestId": "full_runtime"}, 202)
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		current, err := b.Store.LoadSRETask(session, stringOf(created["id"]))
		must(err)
		if current.LatestPlan() != nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	b.workers.Wait()
	// Simulate a persisted old default allocation, already partly consumed.
	_, err := b.Store.MutateSRETask(session, stringOf(created["id"]), 0, "legacy_fixture", func(task *ai.SRETask) error {
		task.TokenBudget, task.BudgetPolicy, task.BudgetSpent = 256000, "", 50000
		task.Usage = ai.Usage{Input: 49000, Output: 1000, Total: 50000, Known: true}
		return nil
	})
	must(err)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks/"+stringOf(created["id"])+"/start", Object{"planVersion": 1, "clientRequestId": "continue_full_runtime"}, 202)
	task := waitSRE(t, b, session, stringOf(created["id"]), "completed", "paused")
	if task.Status != "completed" || rounds.Load() != 36 || len(task.Attempts) != 1 || len(task.Attempts[0].Evidence) != 35 || task.BudgetSpent != 1148000 || task.Usage.Total != 1148000 || task.TokenBudget != 5120000 || task.BudgetPolicy != ai.SREFullAgentBudgetPolicy {
		t.Fatal("full loop was truncated by old runtime limits", task.Status, task.Error, rounds.Load(), task.BudgetSpent, task.TokenBudget)
	}
	data, err := os.ReadFile(filepath.Join(b.Engine.Dir, "children", session, task.Attempts[0].RoleRunID+".json"))
	must(err)
	var state ai.State
	must(json.Unmarshal(data, &state))
	if state.Config.MaxSteps != 40 || state.Config.Model.ContextWindow != 128000 || state.Config.Model.MaxOutput != 8192 {
		t.Fatal("child model/loop settings differ from the parent's")
	}
}

func TestSREVerifierKeepsFullLoopAndExactAcceptanceEvidence(t *testing.T) {
	for _, mode := range []string{"passed", "failed", "no-probe"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			session, resource := newSession(t, h)
			dir := t.TempDir()
			path := filepath.Join(dir, "verify.log")
			must(os.WriteFile(path, []byte("INDEPENDENT_VERIFIER_SOURCE"), 0600))
			plan := ai.SREPlanRevision{Goal: "独立复核实际状态", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "verify", Role: ai.SREVerifier, Kind: "verify", Description: "自主补充主机和日志验证", ResourceIDs: []string{resource}, CompletionChecks: []string{"收集自己的实际证据"}}}}
			if mode != "no-probe" {
				expected := 0.0
				if mode == "failed" {
					expected = 1000000
				}
				plan.Acceptance = []ai.SRECheck{{ID: "space", Kind: "number_threshold", Description: "固定磁盘阈值", ResourceID: resource, Probe: &ai.SREAction{Tool: "observe_host", Arguments: map[string]any{"asset_ref": sreAliasForTest(resource), "metric": "overview"}}, Path: "disks.0.available_percent_of_total", Operator: "gte", Expected: expected, MinSamples: 1}}
			}
			var rounds atomic.Int32
			closeProvider := sreCoordinationFixture(t, b, h, session, func(w http.ResponseWriter, input Object) {
				content := jsonText(input["messages"])
				if strings.Contains(content, "Return only a JSON plan object") {
					emitModel(w, jsonText(plan), nil)
					return
				}
				if !strings.Contains(content, "independent verifier") || !strings.Contains(jsonText(input["tools"]), `"name":"read"`) {
					t.Error("verifier was reduced to a tool-free summarizer")
				}
				if !strings.Contains(content, "Assigned deliverable: "+plan.Steps[0].Description) {
					t.Error("verifier lost original deliverable")
				}
				view, _ := b.Engine.Snapshot(session)
				for _, run := range view.AgentRuns {
					if run.SRERole == ai.SREVerifier && run.Status == "running" && (run.WorkflowStepID != plan.Steps[0].ID || run.ActivityPhase != "thinking") {
						t.Error("verifier live activity/step mapping mismatch", run.WorkflowStepID, run.ActivityPhase)
					}
				}
				switch rounds.Add(1) {
				case 1:
					emitModel(w, "先补充自己的主机状态检查。", []ai.Call{{ID: "extra-status", Name: "observe_host", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "metric": "status"})}})
				case 2:
					emitModel(w, "再核对日志内容。", []ai.Call{{ID: "extra-read", Name: "read", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "runtime": "local", "path": path})}})
				default:
					emitModel(w, "已收集独立证据；模型文字不能替代验收规则。", nil)
				}
			})
			defer closeProvider()
			apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"silentReadFiles": true, "silentCommands": true, "silentTerminalCreation": true}, 200)
			created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "full_verify"}, 202)
			task := waitSRE(t, b, session, stringOf(created["id"]), "completed", "paused")
			wantEvidence := 3
			if mode == "no-probe" {
				wantEvidence = 2
			}
			if task.Status != "completed" || rounds.Load() != 3 || len(task.Attempts) != 1 || len(task.Attempts[0].Evidence) != wantEvidence || len(task.Verifications) != 1 {
				t.Fatal("verifier did not run its own tool loop", task.Status, task.Error, rounds.Load())
			}
			v := task.Verifications[0]
			if mode == "no-probe" {
				if !strings.Contains(task.Attempts[0].Result, "已收集独立证据") || !strings.Contains(v.ReviewSummary, "已收集独立证据") {
					t.Error("verifier final reply was lost")
				}

				if v.Verdict != "inconclusive" || task.RecoveryStatus == "verified" {
					t.Fatal("extra observations invented automatic acceptance")
				}
			} else if v.Verdict != mode || len(v.Checks) != 1 || v.Checks[0].Samples != 1 || len(v.Checks[0].EvidenceIDs) != 1 || v.Checks[0].EvidenceIDs[0] != task.Attempts[0].Evidence[wantEvidence-1].ID {
				t.Fatal("extra evidence changed the frozen acceptance sample", v)
			}
		})
	}
}
