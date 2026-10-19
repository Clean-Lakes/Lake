package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSREBridgeRejectedCommandNeverStartsTerminal(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	_, err := b.bridge(context.Background(), sid, "runtimeCommandExec", Object{"asset_ref": rid, "runtime": "local", "command": "printf FIRST\nprintf SECOND"}, true)
	var rejected *ai.ToolNotExecutedError
	if !errors.As(err, &rejected) || err.Error() != "Invalid command" {
		t.Fatal("validation did not preserve trusted no-dispatch marker", err)
	}
	if len(objects(b.sessionSnapshot(sid)["terminals"])) != 0 {
		t.Fatal("invalid command started a terminal")
	}
}

func TestShellRuntimeMismatchNeverStartsTerminal(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	_, err := b.bridge(context.Background(), sid, "runtimeCommandExec", Object{"asset_ref": rid, "runtime": "ssh", "command": "printf MUST_NOT_RUN"}, true)
	var rejected *ai.ToolNotExecutedError
	if !errors.As(err, &rejected) || err.Error() != "Shell runtime and asset do not match" {
		t.Fatal("target validation was not classified as not executed", err)
	}
	if len(objects(b.Store.Snapshot(sid)["terminals"])) != 0 || len(b.Store.Recent(sid)) != 0 {
		t.Fatal("target rejection started a terminal or command")
	}
}

func TestSREInvalidCommandCanBeCorrectedWithoutUnknownBlocker(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	plan := ai.SREPlanRevision{Goal: "只读检查", TaskType: "investigation", Scope: []string{rid}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "读取实际命令结果", ResourceIDs: []string{rid}, CompletionChecks: []string{"记录证据"}}}}
	var calls atomic.Int32
	closer := sreCoordinationFixture(t, b, h, sid, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		tools := []Object{}
		for _, m := range objects(input["messages"]) {
			if m["role"] == "tool" {
				tools = append(tools, m)
			}
		}
		switch len(tools) {
		case 0:
			calls.Add(1)
			emitModel(w, "先执行只读命令。", []ai.Call{{ID: "invalid", Name: "shell", Arguments: jsonText(Object{"runtime": "local", "asset_ref": sreAliasForTest(rid), "command": "printf FIRST\nprintf SECOND"})}})
		case 1:
			if !strings.Contains(stringOf(tools[0]["content"]), "Invalid command") {
				t.Error("expected validation failure")
			}
			tasks, _ := b.Store.ListSRETasks(sid, 1, "")
			if len(tasks) != 1 || len(tasks[0].Attempts[0].Operations) != 1 || tasks[0].Attempts[0].Operations[0].Status != "not_executed" || tasks[0].Error != "" {
				t.Error("validation falsely became unknown")
			}
			calls.Add(1)
			emitModel(w, "改为有效的单条命令。", []ai.Call{{ID: "corrected", Name: "shell", Arguments: jsonText(Object{"runtime": "local", "asset_ref": sreAliasForTest(rid), "command": "printf VERIFIED_AFTER_VALIDATION"})}})
		default:
			ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(stringOf(tools[len(tools)-1]["content"]), -1)
			emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "实际命令已核对", "facts": []Object{{"statement": "读取有效命令结果", "evidenceIds": ids}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
		}
	})
	defer closer()
	created := apiTest(t, h, "POST", "/api/sessions/"+sid+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{rid}, "mode": "assist", "clientRequestId": "correct_command"}, 202)
	task := waitSRE(t, b, sid, stringOf(created["id"]), "completed", "paused")
	if task.Status != "completed" || calls.Load() != 2 || len(task.Attempts[0].Operations) != 2 || task.Attempts[0].Operations[1].Status != "succeeded" {
		t.Fatal("corrected command blocked", task.Status, task.Error, calls.Load())
	}
}

func TestSREHistoricalValidationRepairIsExactAuditedAndIdempotent(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: sid, Goal: "legacy rejection", Scope: []string{rid}, Mode: "assist", RequestID: "legacy_rejection", TokenBudget: 128000})
	must(err)
	_, err = b.Store.MutateSRETask(sid, task.ID, 0, "fixture", func(v *ai.SRETask) error {
		v.Status = "paused"
		v.Error = "操作结果不明"
		op := func(id, command, result string) ai.SREOperation {
			return ai.SREOperation{ID: id, Call: ai.Call{Name: "shell", Arguments: jsonText(Object{"command": command})}, Status: "unknown", Result: result}
		}
		v.Attempts = []ai.SREStepAttempt{{ID: "a", Status: "unknown", Operations: []ai.SREOperation{op("rejected", "printf FIRST\nprintf SECOND", "Invalid command"), op("transport", "printf FIRST\nprintf SECOND", "context deadline exceeded"), op("valid", "printf VALID", "Invalid command")}}}
		return nil
	})
	must(err)
	b.Store.RecoverSRETasks()
	task, err = b.Store.LoadSRETask(sid, task.ID)
	must(err)
	ops := task.Attempts[0].Operations
	if ops[0].Status != "not_executed" || ops[0].ResolvedBy != "runtime" || ops[0].ResolutionNote == "" || ops[1].Status != "unknown" || ops[2].Status != "unknown" || ops[1].Risk != "readonly" || task.Attempts[0].Status != "failed" {
		t.Fatal("repair erased real unknown or lost proof", ops)
	}
	revision := task.Revision
	b.Store.RecoverSRETasks()
	task, err = b.Store.LoadSRETask(sid, task.ID)
	must(err)
	if task.Revision != revision {
		t.Fatal("repair ran again")
	}
}

func TestSREBlockedContinuationRepliesWithoutPromiseOrStartingRole(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: sid, Goal: "检查服务", Scope: []string{rid}, Mode: "assist", RequestID: "blocked_continue", TokenBudget: 128000})
	must(err)
	_, err = b.Store.MutateSRETask(sid, task.ID, 0, "fixture", func(v *ai.SRETask) error {
		v.Status = "paused"
		v.Attempts = []ai.SREStepAttempt{{ID: "a", Status: "unknown", Operations: []ai.SREOperation{{ID: "op", Status: "unknown", Call: ai.Call{Name: "shell", Arguments: `{"command":"systemctl restart fixture.service"}`}, Result: "context deadline exceeded"}}}}
		return nil
	})
	must(err)
	var rounds atomic.Int32
	closer := sreCoordinationFixture(t, b, h, sid, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if !strings.Contains(content, "conversation owner") {
			t.Error("blocked continuation started a specialist")
			emitModel(w, "unexpected", nil)
			return
		}
		n := rounds.Add(1)
		if n == 1 {
			emitModel(w, "我现在继续执行。", []ai.Call{{ID: "continue", Name: "sre_collaborate", Arguments: jsonText(Object{"action": "continue_task", "task_id": task.ID})}})
			return
		}
		if !strings.Contains(content, "本轮没有恢复执行") {
			t.Error("model did not receive actionable blocker")
		}
		emitSREReply(w, "answer", "当前有操作结果待核实。请从 Plan 的查看并核实入口处理原记录，之后再继续。")
	})
	defer closer()
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "再来一次"}, 202)
	awaitQueueWorkers(t, b)
	view, err := b.Engine.Snapshot(sid)
	must(err)
	if rounds.Load() != 2 || len(view.AgentRuns) != 0 || view.Status != "completed" {
		t.Fatal("blocked handoff was not a real answer", rounds.Load(), view.Status)
	}
	text := ""
	for _, c := range view.Cards {
		if c.Type == "message" {
			text += c.Content
		}
	}
	if strings.Contains(text, "我现在继续执行") || !strings.Contains(text, "查看并核实") {
		t.Fatal("provisional promise remained or actual guidance missing", text)
	}
}

func TestSREDispatchedTimeoutRemainsUnknown(t *testing.T) {
	for _, risk := range []string{"readonly", "write"} {
		t.Run(risk, func(t *testing.T) {
			b, h := fixture(t)
			sid, rid := newSession(t, h)
			options := b.Store.Options(sid)
			options["silentCommands"] = true
			options["silentTerminalCreation"] = true
			b.Store.SaveOptions(sid, options)
			bridge := b.Engine.Bridge
			b.Engine.Bridge = func(ctx context.Context, sid, name string, args map[string]any, approved bool) (any, error) {
				if name == "runtimeCommandExec" {
					return nil, context.DeadlineExceeded
				}
				return bridge(ctx, sid, name, args, approved)
			}
			plan := ai.SREPlanRevision{Goal: "检查等待超时", TaskType: "investigation", Scope: []string{rid}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "记录原操作结果", ResourceIDs: []string{rid}, CompletionChecks: []string{"实际结果不能由报告代替"}}}}
			var calls atomic.Int32
			closer := sreCoordinationFixture(t, b, h, sid, func(w http.ResponseWriter, input Object) {
				if strings.Contains(jsonText(input["messages"]), "Return only a JSON plan object") {
					emitModel(w, jsonText(plan), nil)
					return
				}
				if calls.Add(1) > 1 {
					emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "没有取得完整检查结果", "facts": []Object{}, "hypotheses": []string{}, "unknowns": []string{"采样超时，结果缺失"}, "nextChecks": []string{"重新采样"}}), nil)
					return
				}
				command := "sleep 0.2"
				if risk == "write" {
					command = "printf CHANGE >> " + quote(filepath.Join(t.TempDir(), "never-executed"))
				}
				emitModel(w, "等待命令结果。", []ai.Call{{ID: "timeout", Name: "shell", Arguments: jsonText(Object{"runtime": "local", "asset_ref": sreAliasForTest(rid), "command": command, "timeout_ms": 1})}})
			})
			defer closer()
			created := apiTest(t, h, "POST", "/api/sessions/"+sid+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{rid}, "mode": "assist", "clientRequestId": "real_timeout"}, 202)
			task := waitSRE(t, b, sid, stringOf(created["id"]), "paused")
			if len(task.Attempts) != 1 || len(task.Attempts[0].Operations) != 1 || task.Attempts[0].Operations[0].Status != "unknown" || task.Attempts[0].Operations[0].DispatchedAt == "" {
				t.Fatal("lost dispatch/unknown audit", task)
			}
			if risk == "readonly" {
				if calls.Load() != 2 || task.Attempts[0].Status != "failed" || strings.Contains(task.Error, "核实") || ai.CanCompleteSRETask(task) {
					t.Fatal("read timeout blocked follow-up or fabricated completion", task.Status, task.Error, calls.Load())
				}
			} else if calls.Load() != 1 || task.Attempts[0].Status != "unknown" {
				t.Fatal("unknown write did not stop specialist", task.Status, task.Error, calls.Load())
			}
		})
	}
}

func TestSREWaitTimeoutKeepsOriginalCommandAndCompletesWithoutReplay(t *testing.T) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	marker := filepath.Join(t.TempDir(), "once")
	plan := ai.SREPlanRevision{Goal: "核对原命令完成状态", TaskType: "investigation", Scope: []string{rid}, Steps: []ai.SREPlanStep{{ID: "inspect", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "等待并记录原命令", ResourceIDs: []string{rid}, CompletionChecks: []string{"原命令只执行一次"}}}}
	var calls atomic.Int32
	closer := sreCoordinationFixture(t, b, h, sid, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		calls.Add(1)
		tools := []Object{}
		for _, m := range objects(input["messages"]) {
			if m["role"] == "tool" {
				tools = append(tools, m)
			}
		}
		if len(tools) == 0 {
			emitModel(w, "等待原命令。", []ai.Call{{ID: "only-command", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(rid), "runtime": "local", "command": "printf ONCE >> " + quote(marker) + "; sleep 0.2; printf FINISHED", "timeout_ms": 1})}})
			return
		}
		var result Object
		must(json.Unmarshal([]byte(stringOf(tools[len(tools)-1]["content"])), &result))
		if len(tools) == 1 {
			if result["status"] != "running" || stringOf(result["shell_id"]) == "" {
				t.Error("wait timeout lost the original live command handle")
			}
			emitModel(w, "", []ai.Call{{ID: "wait-original", Name: "wait_shell", Arguments: jsonText(Object{"shell_id": result["shell_id"], "timeout_ms": 1000})}})
			return
		}
		if !strings.Contains(jsonText(result), "FINISHED") {
			t.Error("original completion output missing")
		}
		emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "原命令已完成，未重复执行。", "facts": []Object{{"statement": "原命令返回完成标记", "evidenceIds": []string{stringOf(result["evidence_id"])}}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
	})
	defer closer()
	created := apiTest(t, h, "POST", "/api/sessions/"+sid+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{rid}, "mode": "assist", "clientRequestId": "wait_existing_command"}, 202)
	task := waitSRE(t, b, sid, stringOf(created["id"]), "completed", "paused")
	data, err := os.ReadFile(marker)
	if err != nil || string(data) != "ONCE" || task.Status != "completed" || calls.Load() != 3 {
		t.Fatal("bounded wait aborted the role or replayed the command", task.Status, task.Error, calls.Load(), err)
	}
	if len(task.Attempts) != 1 || len(task.Attempts[0].Operations) != 1 || task.Attempts[0].Operations[0].Status != "succeeded" || task.Attempts[0].Operations[0].ResolvedBy != "runtime" {
		t.Fatal("trusted terminal completion did not reach the original operation")
	}
}
