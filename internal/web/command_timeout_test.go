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

func TestCommandWaitTimeoutContinuesThroughSameShellWithoutReplay(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		switch requests.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "slow-command", Name: "shell", Arguments: jsonText(Object{"command": "printf partial-evidence; sleep 0.4; printf completed-once", "runtime": "local", "timeout_ms": 100})}})
		case 2:
			messages := objects(req["messages"])
			var value Object
			if err := json.Unmarshal([]byte(stringOf(messages[len(messages)-1]["content"])), &value); err != nil {
				t.Error(err)
			}
			if value["timed_out"] != true || value["status"] != "running" || stringOf(value["shell_id"]) == "" || stringOf(value["entry_id"]) == "" || value["error"] != nil {
				t.Error("timeout lost the running command handle", value)
			}
			emitModel(w, "", []ai.Call{{ID: "wait-existing-command", Name: "wait_shell", Arguments: jsonText(Object{"shell_id": value["shell_id"], "timeout_ms": 2000})}})
		case 3:
			messages := objects(req["messages"])
			content := stringOf(messages[len(messages)-1]["content"])
			if !strings.Contains(content, "completed-once") || !strings.Contains(content, `"status":"completed"`) {
				t.Error("existing command did not finish", content)
			}
			emitModel(w, "已核查同一条命令的最终结果。", nil)
		default:
			t.Error("unexpected model retry")
			emitModel(w, "stop", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查测试命令状态"}, 202)
	waitAI(t, b, id, "completed")
	terms := objects(b.Store.Snapshot(id)["terminals"])
	if requests.Load() != 3 || len(terms) != 1 {
		t.Fatal("unexpected command lifecycle", requests.Load(), len(terms))
	}
	entries := objects(b.Store.History(id, stringOf(terms[0]["id"]))["entries"])
	if len(entries) != 1 || entries[0]["status"] != "completed" || !strings.Contains(stringOf(entries[0]["output"]), "partial-evidence") {
		t.Fatal("command was replayed or its evidence was lost", entries)
	}
}
