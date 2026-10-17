package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestNormalModeIgnoresLegacyAutoAndUsesMainAgentTools(t *testing.T) {
	for _, mode := range []string{"auto", "off"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			session, resource := newSession(t, h)
			options := b.Store.Options(session)
			options["multiAgentMode"] = mode
			b.Store.SaveOptions(session, options)
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					reply(w, 200, Object{"data": []Object{{"id": "fixture"}}})
					return
				}
				var input Object
				_ = json.NewDecoder(r.Body).Decode(&input)
				names := jsonText(input["tools"])
				if strings.Contains(names, "delegate_investigation") || strings.Contains(names, "sre_collaborate") {
					t.Error("normal mode exposed child scheduling")
				}
				switch calls.Add(1) {
				case 1:
					emitModel(w, "", []ai.Call{{ID: "obsolete", Name: "delegate_investigation", Arguments: `{"tasks":[{"role":"host","task":"should never run"}]}`}})
				case 2:
					if !strings.Contains(jsonText(input["messages"]), "tool unavailable") {
						t.Error("legacy call was not rejected")
					}
					emitModel(w, "", []ai.Call{{ID: "direct", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(resource), "command": "printf NORMAL_MODE_DIRECT", "runtime": "local"})}})
				default:
					emitModel(w, "主模型直接完成检查。", nil)
				}
			}))
			defer provider.Close()
			apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "fixture", "protocol": "openai"}, 200)
			apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "检查所选本机", "resourceIds": []string{resource}}, 202)
			awaitQueueWorkers(t, b)
			view, _ := b.Engine.Snapshot(session)
			tasks, _ := b.Store.ListSRETasks(session, 20, "")
			if len(view.AgentRuns) != 0 || len(tasks) != 0 || view.Status != "completed" || calls.Load() != 3 {
				t.Fatal("normal mode spawned agents or failed", view.Status, calls.Load())
			}
			if b.sessionOptions(session)["multiAgentMode"] != "off" {
				t.Fatal("legacy auto remained effective")
			}
			if !strings.Contains(jsonText(view.Cards), "NORMAL_MODE_DIRECT") {
				t.Fatal("main agent did not execute its normal tool")
			}
		})
	}
}
