package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestPilotGuidedAndAutomaticRunThroughRealRoleAndEvidence(t *testing.T) {
	for _, scenario := range []struct {
		name                string
		automatic, adaptive bool
	}{{name: "guided"}, {name: "automatic", automatic: true}, {name: "delegated_direction", adaptive: true}} {
		t.Run(scenario.name, func(t *testing.T) {
			automatic, adaptive := scenario.automatic, scenario.adaptive
			b, h := fixture(t)
			session, resource := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			dir, _ := filepath.EvalSymlinks(t.TempDir())
			logPath := filepath.Join(dir, "service.log")
			if err := os.WriteFile(logPath, []byte("PILOT_REAL_SOURCE connection refused\n"), 0600); err != nil {
				t.Fatal(err)
			}
			alternativePath := filepath.Join(dir, "alternative.log")
			if err := os.WriteFile(alternativePath, []byte("PILOT_ALTERNATIVE_SOURCE\n"), 0600); err != nil {
				t.Fatal(err)
			}
			plan := ai.SREPlanRevision{Goal: "核对日志", TaskType: "investigation", Scope: []string{resource}, Steps: []ai.SREPlanStep{{ID: "logs", Role: ai.SREInvestigator, Kind: "observe", Capability: "application", Description: "收集日志证据", ResourceIDs: []string{resource}, CompletionChecks: []string{"取得真实日志"}}, {ID: "summary", Role: ai.SRECoordinator, Kind: "summarize", Description: "归纳事实和缺口", ResourceIDs: []string{resource}, DependsOn: []string{"logs"}, CompletionChecks: []string{"引用证据"}}}}
			refPattern := regexp.MustCompile(`a_[a-f0-9]{16}`)
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					reply(w, 200, Object{"data": []Object{{"id": "pilot-fixture"}}})
					return
				}
				var input Object
				_ = json.NewDecoder(r.Body).Decode(&input)
				messages := objects(input["messages"])
				content := jsonText(messages)
				system := ""
				if len(messages) > 0 {
					system = stringOf(messages[0]["content"])
				}
				if strings.Contains(content, "Return only a JSON plan object") {
					emitModel(w, jsonText(plan), nil)
					return
				}
				if strings.Contains(system, "Lake's investigator") {
					chosen, collected, reselected, alternativeCollected := false, false, false, false
					for _, message := range messages {
						if message["role"] == "tool" {
							chosen = chosen || message["tool_call_id"] == "choose_path"
							collected = collected || message["tool_call_id"] == "collect_logs"
							reselected = reselected || message["tool_call_id"] == "choose_replacement"
							alternativeCollected = alternativeCollected || message["tool_call_id"] == "collect_alternative"
						}
					}
					arguments := Object{"asset_ref": refPattern.FindString(content), "path": logPath}
					if !automatic && !chosen {
						emitModel(w, "", []ai.Call{{ID: "choose_path", Name: "pilot_offer_directions", Arguments: jsonText(Object{"directions": []Object{{"id": "logs", "title": "查看启动日志", "reason": "先收集故障时间的实际记录", "recommended": true, "operations": []Object{{"id": "read_logs", "title": "读取服务日志", "tool": "observe_logs", "arguments": arguments}}}}})}})
						return
					}
					if !collected {
						emitModel(w, "", []ai.Call{{ID: "collect_logs", Name: "observe_logs", Arguments: jsonText(arguments)}})
						return
					}
					if adaptive && !reselected {
						emitModel(w, "", []ai.Call{{ID: "choose_replacement", Name: "pilot_offer_directions", Arguments: jsonText(Object{"directions": []Object{{"id": "logs", "title": "查看启动日志", "reason": "先收集故障时间的实际记录", "operations": []Object{{"id": "read_alternative", "title": "读取替代日志", "tool": "observe_logs", "arguments": Object{"asset_ref": arguments["asset_ref"], "path": alternativePath}}}}}})}})
						return
					}
					if adaptive && !alternativeCollected {
						emitModel(w, "", []ai.Call{{ID: "collect_alternative", Name: "observe_logs", Arguments: jsonText(Object{"asset_ref": arguments["asset_ref"], "path": alternativePath})}})
						return
					}
					ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)
					emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "已取得真实日志，根因仍待确认。", "facts": []Object{{"statement": "日志出现连接被拒绝", "evidenceIds": ids}}, "hypotheses": []string{}, "unknowns": []string{"尚未验证恢复"}, "nextChecks": []string{}}), nil)
					return
				}
				emitModel(w, "日志检查已完成，根因与业务恢复仍待核实。", nil)
			}))
			defer provider.Close()
			apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "pilot-fixture", "protocol": "openai"}, 200)
			allowFixtureHost(b, session)
			apiTest(t, h, "PUT", "/api/projects/"+project+"/pilot", Object{"enabled": true, "autoAdvance": automatic, "expectedRevision": 0}, 200)
			created := apiTest(t, h, "POST", "/api/sessions/"+session+"/sre/tasks", Object{"goal": "核对日志", "resourceIds": []string{resource}, "mode": "assist", "clientRequestId": "pilot_run"}, 202)
			id := stringOf(created["id"])
			if !automatic {
				var pending ai.AgentRun
				deadline := time.Now().Add(sreSettleTimeout)
				for time.Now().Before(deadline) {
					view, err := b.Engine.Snapshot(session)
					if err != nil {
						t.Fatal(err)
					}
					for _, run := range view.AgentRuns {
						if run.Question != nil && run.Question.Pilot != nil {
							pending = run
							break
						}
					}
					if pending.Question != nil {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if pending.Question == nil {
					task, _ := b.Store.LoadSRETask(session, id)
					t.Fatalf("no real Pilot wait: %s %s", task.Status, task.Error)
				}
				before, _ := b.Store.LoadSRETask(session, id)
				for _, attempt := range before.Attempts {
					if len(attempt.Operations) > 0 || len(attempt.Evidence) > 0 {
						t.Fatal("resource work happened before choice")
					}
				}
				answer := jsonText(Object{"level": "command", "directionId": "logs", "operationIds": []string{"read_logs"}})
				if adaptive {
					answer = jsonText(Object{"level": "direction", "directionId": "logs"})
				}
				apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/agentQuestionReply", Object{"runId": pending.ID, "id": pending.Question.ID, "answers": Object{pending.Question.Questions[0].ID: []string{answer}}}, 200)
			}
			task := waitSRE(t, b, session, id, "completed", "paused")
			if task.Status != "completed" {
				t.Fatalf("Pilot did not complete actual evidence work: %s", task.Error)
			}
			if task.Pilot == nil || task.Pilot.AutoAdvance != automatic {
				t.Fatal("task did not freeze its strategy")
			}
			if !automatic && len(task.Pilot.Decisions) != 1 {
				t.Fatal("choice was not persisted exactly once")
			}
			for _, attempt := range task.Attempts {
				for _, op := range attempt.Operations {
					if op.Status == "succeeded" && op.Call.Name == "observe_logs" && len(op.EvidenceIDs) == 0 {
						t.Fatal("real operation lost its evidence linkage")
					}
				}
			}
			if adaptive && len(task.Pilot.DirectionBatches) != 1 {
				t.Fatal("replacement batch did not reuse the original direction decision")
			}
			found, alternativeFound := false, false
			for _, attempt := range task.Attempts {
				for _, evidence := range attempt.Evidence {
					page := apiTest(t, h, "GET", "/api/sessions/"+session+"/sre/tasks/"+id+"/evidence/"+evidence.ID, nil, 200)
					found = found || strings.Contains(stringOf(page["source"]), "PILOT_REAL_SOURCE")
					alternativeFound = alternativeFound || strings.Contains(stringOf(page["source"]), "PILOT_ALTERNATIVE_SOURCE")
				}
			}
			if adaptive && !alternativeFound {
				t.Fatal("new direction batch did not collect real alternative evidence")
			}
			if !found {
				t.Fatal("no actual source evidence")
			}
		})
	}
}
