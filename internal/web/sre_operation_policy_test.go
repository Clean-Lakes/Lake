package web

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSRELegacyTimeoutClassificationAndRestartKeepAudit(t *testing.T) {
	readonly := `echo "== uptime/load =="; uptime; echo "== failed units =="; systemctl --failed --no-legend --plain; systemctl list-units --type=service --state=failed --no-legend | wc -l; ls -l /var/run/docker.sock /run/docker.sock 2>&1; podman ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' 2>&1 | head -30; podman ps -q | wc -l; podman ps -aq | wc -l`
	for _, tc := range []struct {
		name, command string
		allowed       bool
	}{{"real-read-batch", readonly, true}, {"write", "systemctl restart nginx", false}, {"mixed", "uptime; touch /tmp/changed", false}, {"dynamic", "eval \"$COMMAND\"", false}} {
		t.Run(tc.name, func(t *testing.T) {
			b, sid, _, task := sreStoreFixture(t)
			original := ai.SREOperation{ID: "original", Status: "unknown", Call: ai.Call{ID: "old-call", Name: "shell", Arguments: jsonText(Object{"command": tc.command, "readonly": true})}, Result: "context deadline exceeded"}
			_, err := b.Store.MutateSRETask(sid, task.ID, 0, "legacy_fixture", func(v *ai.SRETask) error {
				v.Status = "paused"
				v.Error = "操作结果不明，请核实实际状态"
				v.Attempts = []ai.SREStepAttempt{{ID: "old", Status: "unknown", Operations: []ai.SREOperation{original}}}
				return nil
			})
			must(err)
			got, err := b.Store.LoadSRETask(sid, task.ID)
			must(err)
			op := got.Attempts[0].Operations[0]
			if (op.Risk == "readonly") != tc.allowed || op.Result != original.Result || op.Status != "unknown" {
				t.Fatal("legacy classification or audit", op)
			}
			if _, err = b.Engine.ValidateSREHandoff(sid, ai.SREHandoff{Action: "continue_task", TaskID: task.ID}); (err == nil) != tc.allowed {
				t.Fatal("handoff barrier", err)
			}
			if tc.allowed {
				if got.Attempts[0].Status != "failed" || strings.Contains(got.Error, "核实") {
					t.Fatal("read requires verification", got)
				}
				if _, err = b.sreResolveOperation(sid, task.ID, got.Revision, "original", "succeeded", "fixture"); err == nil {
					t.Fatal("read timeout accepted human success")
				}
			}
			_, err = b.Store.RestartSREInvestigation(sid, task.ID, "restart-fixture", "plan_only", 128000)
			if (err == nil) != tc.allowed {
				t.Fatal("restart barrier", err)
			}
			old, err := b.Store.LoadSRETask(sid, task.ID)
			must(err)
			if old.Attempts[0].Operations[0].Result != original.Result || old.Attempts[0].Operations[0].Status != "unknown" {
				t.Fatal("restart rewrote original")
			}
		})
	}
}

func TestSREReadTimeoutCanRetryInOfficialRuntimeAndExecuteRealSample(t *testing.T) {
	for _, online := range []bool{false, true} {
		t.Run(map[bool]string{false: "baseline", true: "bounded_online"}[online], func(t *testing.T) { testSREReadTimeoutSample(t, online) })
	}
}

func testSREReadTimeoutSample(t *testing.T, online bool) {
	b, h := fixture(t)
	sid, rid := newSession(t, h)
	if online {
		_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "online", 0, StrategySettingsInput{MasterEnabled: true, CorrectEnabled: true, OnlineCorrectEnabled: true, Budget: strategy.DefaultBudget()})
		if err != nil {
			t.Fatal(err)
		}
	}
	options := b.Store.Options(sid)
	options["silentCommands"] = true
	options["silentTerminalCreation"] = true
	b.Store.SaveOptions(sid, options)
	originalBridge := b.Engine.Bridge
	var executions atomic.Int32
	b.Engine.Bridge = func(ctx context.Context, id, name string, a map[string]any, approved bool) (any, error) {
		if name == "runtimeCommandExec" && executions.Add(1) == 1 {
			return nil, context.DeadlineExceeded
		}
		return originalBridge(ctx, id, name, a, approved)
	}
	plan := ai.SREPlanRevision{Goal: "超时后重新采样", TaskType: "investigation", Scope: []string{rid}, Steps: []ai.SREPlanStep{{ID: "sample", Role: ai.SREInvestigator, Kind: "observe", Capability: "host", Description: "取得实际采样", ResourceIDs: []string{rid}, CompletionChecks: []string{"实际命令返回真实证据"}}}}
	var rounds atomic.Int32
	closeProvider := sreCoordinationFixture(t, b, h, sid, func(w http.ResponseWriter, input Object) {
		content := jsonText(input["messages"])
		if strings.Contains(content, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		n := rounds.Add(1)
		if online && n == 2 {
			emitModel(w, "", []ai.Call{{ID: "bounded-proposal", Name: "revise_readonly_strategy", Arguments: jsonText(Object{"sourceId": "first", "refutedHypothesis": "原只读检查已完成", "changes": "以新调用重新采样；保留原未知记录", "expectedInformation": "真实主机返回固定只读命令结果", "stopCondition": "权限、目标、未知变更或额度触发即停", "tool": "shell", "arguments": jsonText(Object{"asset_ref": sreAliasForTest(rid), "runtime": "local", "command": "printf SRE_FRESH_READ_SAMPLE"})})}})
			return
		}
		if online && n > 2 {
			n--
		}
		if n <= 2 {
			if n == 2 && !strings.Contains(content, "可以用新的调用重新检查") {
				t.Error("read timeout still tells model never retry")
			}
			id := "first"
			if n == 2 {
				id = "fresh"
			}
			emitModel(w, "", []ai.Call{{ID: id, Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(rid), "runtime": "local", "command": "printf SRE_FRESH_READ_SAMPLE"})}})
			return
		}
		ids := regexp.MustCompile(`ev_[a-f0-9]{32}`).FindAllString(content, -1)
		if len(ids) == 0 {
			t.Error("actual evidence missing")
			emitModel(w, "missing", nil)
			return
		}
		emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "重新采样已取得真实结果", "facts": []Object{{"statement": "命令返回 SRE_FRESH_READ_SAMPLE", "evidenceIds": ids[len(ids)-1:]}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
	})
	defer closeProvider()
	created := apiTest(t, h, "POST", "/api/sessions/"+sid+"/sre/tasks", Object{"goal": plan.Goal, "resourceIds": []string{rid}, "mode": "assist", "clientRequestId": "read_retry"}, 202)
	task := waitSRE(t, b, sid, stringOf(created["id"]), "completed", "paused")
	if task.Status != "completed" || executions.Load() != 2 || len(task.Attempts) != 1 || len(task.Attempts[0].Operations) != 2 {
		t.Fatal("retry did not finish", task.Status, task.Error, executions.Load(), rounds.Load())
	}
	ops := task.Attempts[0].Operations
	if ops[0].Status != "unknown" || ops[0].Risk != "readonly" || ops[0].Result != "context deadline exceeded" || ops[1].Status != "succeeded" || !strings.Contains(ops[1].Result, "SRE_FRESH_READ_SAMPLE") {
		t.Fatal("retry audit or real output lost", ops)
	}
	if online {
		view, err := b.Engine.Snapshot(sid)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, card := range view.Cards {
			if card.Type == "strategy_correction" {
				r := object(card.Data)
				found = true
				if r["stopReason"] != "completed" || r["recovered"] != true || integer(r["requests"]) != 3 || len(objects(r["revisions"])) != 1 || len(objects(r["openChecks"])) != 0 {
					t.Fatal("SRE did not share/finalize online correction", r)
				}
			}
		}
		if !found {
			t.Fatal("SRE parent report missing")
		}
	}
}

func TestSREDoneCannotOverwritePausedTaskOrReplyTiming(t *testing.T) {
	b, sid, _, task := sreStoreFixture(t)
	_, err := b.Store.MutateSRETask(sid, task.ID, 0, "paused_fixture", func(v *ai.SRETask) error { v.Status = "paused"; return nil })
	must(err)
	b.Store.Begin(sid, "retry", nil)
	b.event(ai.Event{Session: sid, Type: "done", Data: Object{"status": "completed"}})
	b.finishReplyTiming(sid)
	if b.Store.Session(sid)["status"] != "failed" {
		t.Fatal("paused task became green completed")
	}
	times := objects(b.Store.Snapshot(sid)["replyTimings"])
	if len(times) != 1 || times[0]["status"] != "failed" {
		t.Fatal("reply timing fabricated task completion", times)
	}
}
