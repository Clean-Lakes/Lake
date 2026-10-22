package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyHostInspectionUsesPolicyResolvedTarget(t *testing.T) {
	for _, mode := range []string{"silent_creation", "approved_creation", "reuse_terminal", "bound_host"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			id, ref := newSession(t, h)
			// Ordinary inspection must work with every strategy feature disabled.
			boundRef := ""
			if mode == "bound_host" {
				project := stringOf(b.Store.Session(id)["projectId"])
				b.Store.CreateResource(project, "other SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture"})
				boundRef = ref
			}
			var expectedTerminal string
			if mode == "reuse_terminal" {
				term := b.openAgentTerminal(context.Background(), id, ref)
				expectedTerminal = stringOf(term["id"])
				b.Terminals.Control(id, expectedTerminal, "agent")
			}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request Object
				if json.NewDecoder(r.Body).Decode(&request) != nil {
					t.Error("invalid model request")
				}
				if calls.Add(1) == 1 {
					// Reproduce the actual model call: no explicit asset_ref and no
					// retained binding. Policy resolves the unique project host.
					emitModel(w, "", []ai.Call{{ID: "inspect-unique-host", Name: "inspect_host", Arguments: `{"runtime":"local"}`}})
					return
				}
				messages := objects(request["messages"])
				last := messages[len(messages)-1]
				var result Object
				if last["role"] != "tool" || json.Unmarshal([]byte(stringOf(last["content"])), &result) != nil || result["runtime"] != "local" || stringOf(result["terminal_id"]) == "" || len(objects(result["checks"])) == 0 || result["error"] != nil {
					t.Error("model did not receive actual host inspection evidence")
				}
				if expectedTerminal != "" && result["terminal_id"] != expectedTerminal {
					t.Error("inspection switched terminals")
				}
				emitModel(w, "已取得本机检查结果。", nil)
			}))
			defer provider.Close()
			b.Models.Save(&ai.Model{URL: provider.URL, Name: "host-target-fixture", Protocol: "openai"})
			apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": boundRef, "terminal_id": "", "silentCommands": false, "silentTerminalCreation": mode != "approved_creation"}, 200)
			apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查一下本机的状态"}, 202)
			if mode == "approved_creation" {
				view := waitAI(t, b, id, "waiting_approval")
				if view.Pending == nil || view.Pending.Kind != "terminal_open" || view.Pending.ResourceID != ref || len(b.Store.ResourceTerminals(ref)) != 0 {
					t.Fatal("target resolution bypassed terminal consent")
				}
				apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": true}, 200)
			}
			b.workers.Wait()
			view, _ := b.Engine.Snapshot(id)
			if view.Status != "completed" || calls.Load() != 2 || len(view.OperationOutcomes) != 0 {
				t.Fatalf("inspection failed or left unknown effects: status=%s requests=%d", view.Status, calls.Load())
			}
			if len(b.Store.ResourceTerminals(ref)) != 1 {
				t.Fatal("inspection did not use exactly one target terminal")
			}
			for _, card := range view.Cards {
				if card.Type == "strategy_correction" {
					t.Fatal("successful inspection created a correction task")
				}
			}
		})
	}
}

func TestStrategyHostInspectionDoesNotGuessOrBypassLocalDenial(t *testing.T) {
	for _, mode := range []string{"ambiguous_hosts", "deny_local"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			id, ref := newSession(t, h)
			if mode == "ambiguous_hosts" {
				project := stringOf(b.Store.Session(id)["projectId"])
				b.Store.CreateResource(project, "unselected SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture"})
			}
			_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "host-denial", 0, StrategySettingsInput{MasterEnabled: true, CorrectEnabled: true, OnlineCorrectEnabled: true, Budget: strategy.DefaultBudget()})
			if err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				emitModel(w, "", []ai.Call{{ID: "inspect-denied", Name: "inspect_host", Arguments: `{"runtime":"local"}`}})
			}))
			defer provider.Close()
			b.Models.Save(&ai.Model{URL: provider.URL, Name: "host-denial-fixture", Protocol: "openai"})
			apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": "", "terminal_id": "", "denyLocalExecution": mode == "deny_local"}, 200)
			apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查主机状态"}, 202)
			b.workers.Wait()
			view, _ := b.Engine.Snapshot(id)
			if view.Status != "failed" || calls.Load() != 1 || len(b.Store.ResourceTerminals(ref)) != 0 {
				t.Fatal("denied inspection executed or retried", mode, view.Status, calls.Load())
			}
			want := strategy.TargetAmbiguous
			if mode == "deny_local" {
				want = strategy.PermissionBlocked
			}
			found := false
			for _, card := range view.Cards {
				if card.Type == "operation" {
					t.Fatal("denied inspection reached dispatch")
				}
				if card.Type == "strategy_correction" {
					var report strategy.OnlineReport
					if json.Unmarshal([]byte(jsonText(card.Data)), &report) != nil {
						t.Fatal("invalid correction report")
					}
					found = report.StopReason == want
				}
			}
			if !found {
				t.Fatal("denial reason lost", mode)
			}
		})
	}
}
