package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Reproduce the real Dev turn through HTTP, the official ADK, and the actual
// memory intent guard. A denied memory write must not turn into resource retry.
func TestStrategyMemoryDenialKeepsTurnAndCandidateLearningIndependent(t *testing.T) {
	for _, mode := range []string{"daily_denied", "experiment_denied", "daily_authorized"} {
		authorized := mode == "daily_authorized"
		name := mode
		if authorized {
			name = "explicit_memory_write_still_works"
		}
		t.Run(name, func(t *testing.T) {
			b, h := fixture(t)
			id, ref := newSession(t, h)
			project := stringOf(b.Store.Session(id)["projectId"])
			b.Store.SetMemorySettings(project, true, false, 0)
			_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "enable-all", 0, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: false, CorrectEnabled: false, OnlineCorrectEnabled: false, OnlineConsentVersion: strategy.OnlineConsentVersion, Budget: strategy.DefaultBudget()})
			if err != nil {
				t.Fatal(err)
			}
			var mainCalls, learningCalls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request Object
				if json.NewDecoder(r.Body).Decode(&request) != nil {
					t.Error("invalid request")
					emitModel(w, "停止。", nil)
					return
				}
				messages := objects(request["messages"])
				if len(messages) > 0 && strings.Contains(stringOf(messages[0]["content"]), "Extract at most one reusable") {
					learningCalls.Add(1)
					payload := object(strategyDecode[Object](stringOf(messages[1]["content"])))
					sources := objects(payload["sources"])
					if len(sources) != 1 || len(objects(request["tools"])) != 0 {
						t.Error("candidate extraction lost source/tool boundary")
						emitModel(w, `{"schemaVersion":1,"candidate":null}`, nil)
						return
					}
					emitModel(w, learningOutput(stringOf(sources[0]["sourceId"]), "Separate observed facts, hypotheses and the next readonly check."), nil)
					return
				}
				n := mainCalls.Add(1)
				if n == 1 {
					emitModel(w, "", []ai.Call{{ID: "save-preference", Name: "save_project_memory", Arguments: jsonText(Object{"key": "answer-format", "type": "feedback", "description": "排障答复格式", "body": "区分事实与假设。", "expectedRevision": 0})}})
					return
				}
				if n != 2 {
					t.Error("unexpected retry", n)
					emitModel(w, "停止。", nil)
					return
				}
				result := stringOf(messages[len(messages)-1]["content"])
				if authorized {
					if strings.Contains(result, "explicit_memory_intent_required") {
						t.Error("explicit memory save was rejected")
					}
				} else if !strings.Contains(result, "explicit_memory_intent_required") {
					t.Error("memory intent guard was bypassed")
				}
				emitModel(w, "已按纠正要求组织本次答复；候选需要另行审核采用。", nil)
			}))
			defer provider.Close()
			b.Models.Save(&ai.Model{URL: provider.URL, Name: "memory-strategy-boundary", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
			apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
			text := "纠正一下，以后请按已知事实、待验证假设、下一步只读检查组织排障答复。"
			if authorized {
				text = "请记住：区分事实与假设。"
			}
			apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": text}, 202)
			b.workers.Wait()
			view, _ := b.Engine.Snapshot(id)
			if view.Status != "completed" || mainCalls.Load() != 2 {
				t.Fatalf("memory operation interrupted ordinary turn: status=%s requests=%d", view.Status, mainCalls.Load())
			}
			for _, card := range view.Cards {
				if card.Type == "strategy_correction" {
					t.Fatal("memory operation created a readonly correction task")
				}
			}
			if authorized {
				got := b.Store.ReadProjectMemory(project, "answer-format", false)
				if stringOf(got["body"]) != "区分事实与假设。" {
					t.Fatal("authorized memory save missing")
				}
			} else if b.Store.row("SELECT key FROM projectMemories WHERE projectId=? AND key=?", project, "answer-format") != nil {
				t.Fatal("denied memory write changed durable memory")
			}
			b.processOneMemoryJob()
			if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyLearningTurns WHERE sessionId=?", id)["n"]) != 0 {
				t.Fatal("retired learning captured a source")
			}
			b.processOneMemoryJob()
			if learningCalls.Load() != 0 {
				t.Fatal("candidate extraction missing or repeated", learningCalls.Load())
			}
			if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyBindings")["n"]) != 0 {
				t.Fatal("candidate was automatically adopted")
			}
		})
	}
}
