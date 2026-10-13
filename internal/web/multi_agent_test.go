package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMultiAgentHTTPApprovalCancelAndDetailsScope(t *testing.T) {
	b, h := fixture(t)
	id, resourceID := newSession(t, h)
	other, _ := newSession(t, h)
	allowFixtureHost(b, id)
	options := b.Store.Options(id)
	options["silentReadFiles"] = false
	options["multiAgentMode"] = "auto"
	b.Store.SaveOptions(id, options)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "app.log")
	if err = os.WriteFile(logPath, []byte("HTTP_FIXTURE_EVIDENCE timeout waiting for connection\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	calls := map[string]int{}
	refPattern := regexp.MustCompile(`a_[a-f0-9]{16}`)
	evidencePattern := regexp.MustCompile(`ev_[a-f0-9]{32}`)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			reply(w, 200, Object{"data": []Object{{"id": "fixture"}}})
			return
		}
		var body Object
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid model fixture body")
		}
		role := "Lake"
		for _, m := range objects(body["messages"]) {
			if m["role"] == "system" {
				for _, name := range []string{"Trace", "Beacon"} {
					if strings.Contains(stringOf(m["content"]), "You are "+name+", an independent") {
						role = name
					}
				}
			}
		}
		mu.Lock()
		calls[role]++
		step := calls[role]
		mu.Unlock()
		content := jsonText(body["messages"])
		if role == "Lake" {
			switch step {
			case 1:
				emitModel(w, "", []ai.Call{{ID: "assets", Name: "list_assets", Arguments: `{"pattern":""}`}})
			case 2:
				ref := refPattern.FindString(content)
				emitModel(w, "", []ai.Call{{ID: "delegate", Name: "delegate_investigation", Arguments: jsonText(Object{"tasks": []Object{{"role": "application", "task": "Read fixture log", "asset_refs": []string{ref}, "context": "Log path: " + logPath}}})}})
			case 3:
				emitModel(w, "", []ai.Call{{ID: "verify", Name: "delegate_investigation", Arguments: jsonText(Object{"tasks": []Object{{"role": "verify", "task": "Review collected evidence"}}})}})
			default:
				emitModel(w, "Parent result", nil)
			}
			return
		}
		if step == 1 {
			if role == "Beacon" {
				emitModel(w, "", []ai.Call{{ID: "raw", Name: "read_evidence", Arguments: `{}`}})
			} else {
				emitModel(w, "", []ai.Call{{ID: "logs", Name: "observe_logs", Arguments: jsonText(Object{"asset_ref": refPattern.FindString(content), "path": logPath})}})
			}
			return
		}
		emitModel(w, "Result supported by "+strings.Join(evidencePattern.FindAllString(content, -1), ", "), nil)
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "fixture", "protocol": "openai"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "Investigate fixture log", "resourceIds": []string{resourceID}}, 202)
	var run ai.AgentRun
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		v, _ := b.Engine.Snapshot(id)
		for _, candidate := range v.AgentRuns {
			if candidate.Pending != nil {
				run = candidate
			}
		}
		if run.Pending != nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if run.Pending == nil {
		_ = b.Engine.Abort(id)
		t.Fatal("HTTP snapshot did not expose the child's approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+other+"/ai/cancelAgent", Object{"runId": run.ID}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+other+"/ai/agentDetails", Object{"runId": run.ID}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+other+"/ai/agentDecision", Object{"runId": run.ID, "id": run.Pending.ID, "accept": true}, 409)
	details := apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/agentDetails", Object{"runId": run.ID}, 200)
	if details["session"] != run.ID {
		t.Fatal("wrong child history returned")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/agentDecision", Object{"runId": run.ID, "id": run.Pending.ID, "accept": true}, 200)
	v := waitAI(t, b, id, "completed")
	if len(v.AgentRuns) != 2 || v.AgentRuns[0].Status != "completed" || v.AgentRuns[1].Name != "Beacon" || v.AgentRuns[1].Status != "completed" {
		t.Fatal("HTTP turn did not finish with independent review")
	}
	snapshot := apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
	if len(objects(object(snapshot["ai"])["agentRuns"])) != 2 {
		t.Fatal("child journals missing from HTTP snapshot")
	}
}
