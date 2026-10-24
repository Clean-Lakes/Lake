package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func startStopFixture(t *testing.T, b *Server, id, resource, command string) (Object, Object) {
	t.Helper()
	value, err := b.bridge(context.Background(), id, "runtimeCommandExec", Object{"asset_ref": resource, "runtime": "local", "command": command, "run_in_background": true}, true)
	if err != nil {
		t.Fatal(err)
	}
	result := object(value)
	tid := stringOf(result["terminal_id"])
	return b.Store.Terminal(id, tid), b.Store.Entry(id, tid, stringOf(result["entry_id"]))
}

func TestMiniBoxAgentReceivesStopAndContinuesAnotherResource(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	peer := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "peer", "local", Object{})
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		switch calls.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "stop-me", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(ref), "runtime": "local", "command": "sleep 5; printf not-completed"})}})
		case 2:
			messages := objects(request["messages"])
			last := stringOf(messages[len(messages)-1]["content"])
			if !strings.Contains(last, `"userStopped":true`) || !strings.Contains(last, "不要自动重试") {
				t.Error("model did not receive scoped user stop", last)
			}
			emitModel(w, "", []ai.Call{{ID: "continue-peer", Name: "shell", Arguments: jsonText(Object{"asset_ref": sreAliasForTest(stringOf(peer["id"])), "runtime": "local", "command": "printf peer-after-stop"})}})
		default:
			emitModel(w, "该资源命令已按用户要求停止，其他资源检查已完成；被终止命令的结果需核查。", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查两个资源，分别报告结果"}, 202)
	selection := waitAI(t, b, id, "waiting_approval")
	if selection.Pending == nil || selection.Pending.Kind != "resource_select" {
		t.Fatal("expected normal resource-selection approval", selection.Pending)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": selection.Pending.ID, "accept": true}, 200)
	deadline := time.Now().Add(8 * time.Second)
	var term, entry Object
	for time.Now().Before(deadline) {
		for _, candidate := range objects(b.Store.Snapshot(id)["terminals"]) {
			if candidate["resourceId"] == ref && candidate["status"] == "busy" {
				term = candidate
				entries := objects(b.Store.History(id, stringOf(candidate["id"]))["entries"])
				if len(entries) > 0 {
					entry = entries[len(entries)-1]
				}
			}
		}
		if entry != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if entry == nil {
		view, _ := b.Engine.Snapshot(id)
		t.Fatalf("fixture command never dispatched (model calls=%d): %s", calls.Load(), jsonText(view))
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/terminals/"+stringOf(term["id"])+"/interrupt-command", Object{"generation": term["generation"], "entryId": entry["id"]}, 202)
	view := waitAI(t, b, id, "completed")
	if calls.Load() != 3 {
		t.Fatal("stopped whole turn or replayed command", calls.Load())
	}
	interrupted := false
	for _, card := range view.Cards {
		if card.Type == "operation" && card.Status == "interrupted" {
			interrupted = true
		}
	}
	if !interrupted {
		t.Fatal("missing interrupted operation card")
	}
	found := false
	for _, terminal := range objects(b.Store.Snapshot(id)["terminals"]) {
		if terminal["resourceId"] == peer["id"] {
			for _, row := range objects(b.Store.History(id, stringOf(terminal["id"]))["entries"]) {
				found = found || strings.Contains(stringOf(row["output"]), "peer-after-stop")
			}
		}
	}
	if !found {
		t.Fatal("peer resource did not finish")
	}
}

func TestMiniSSHStopIsBoundToOneResourceAndObservedByAgent(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	b.Store.AddMessage(id, "user", "检查两个资源", nil)
	other := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "second host", "local", Object{})
	term, entry := startStopFixture(t, b, id, ref, "sleep 5; printf should-not-complete")
	peer, peerEntry := startStopFixture(t, b, id, stringOf(other["id"]), "sleep 0.8; printf peer-finished")
	path := "/api/sessions/" + id + "/terminals/" + stringOf(term["id"]) + "/interrupt-command"
	apiTest(t, h, "POST", path, Object{"generation": term["generation"], "entryId": entry["id"]}, 202)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	stopped, err := b.waitTerminal(ctx, id, stringOf(term["id"]), stringOf(entry["id"]))
	if err != nil {
		t.Fatal(err)
	}
	observed := object(stopped)
	if observed["userStopped"] != true || stringOf(observed["stopRequestedAt"]) == "" || !strings.Contains(stringOf(observed["notice"]), "不要自动重试") || observed["status"] == "completed" && observed["exitCode"] == 0 {
		t.Fatal("stop lost its identity or claimed success", observed)
	}
	result := b.Terminals.Wait(ctx, id, stringOf(peer["id"]), stringOf(peerEntry["id"]))
	if result["status"] != "completed" || !strings.Contains(stringOf(result["output"]), "peer-finished") || stringOf(result["stopRequestedAt"]) != "" {
		t.Fatal("peer was interrupted", result)
	}
	notices := objects(b.sessionSnapshot(id)["commandStopNotices"])
	if len(notices) != 1 || notices[0]["resourceId"] != ref || notices[0]["entryId"] != entry["id"] {
		t.Fatal("missing per-resource completion notice", notices)
	}
	_, err = b.bridge(context.Background(), id, "terminal_execute_command", Object{"terminal_id": term["id"], "command": entry["command"]}, true)
	if err == nil || !strings.Contains(err.Error(), "用户终止") {
		t.Fatal("automatic retry ignored user stop", err)
	}
	// A new human instruction authorizes a fresh attempt through normal policy.
	b.Store.AddMessage(id, "user", "现在重新检查", nil)
	b.Store.assertCommandNotStopped(id, ref, stringOf(entry["command"]))
}

func TestMiniSSHStopRejectsStaleEntryGenerationAndForeignOrigin(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	term, entry := startStopFixture(t, b, id, ref, "sleep 1; printf original-finished")
	path := "/api/sessions/" + id + "/terminals/" + stringOf(term["id"]) + "/interrupt-command"
	for _, data := range []Object{{"generation": "wrong", "entryId": entry["id"]}, {"generation": term["generation"], "entryId": "old-entry"}} {
		apiTest(t, h, "POST", path, data, 409)
	}
	other := stringOf(b.Store.CreateSession(stringOf(b.Store.Session(id)["projectId"]), "foreign", nil)["id"])
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+stringOf(term["id"])+"/interrupt-command", Object{"generation": term["generation"], "entryId": entry["id"]}, 403)
	// Even an adopted terminal does not grant the right to stop another origin's job.
	b.adoptTerminal(other, stringOf(term["id"]), stringOf(term["generation"]))
	apiTest(t, h, "POST", "/api/sessions/"+other+"/terminals/"+stringOf(term["id"])+"/interrupt-command", Object{"generation": term["generation"], "entryId": entry["id"]}, 409)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := b.Terminals.Wait(ctx, id, stringOf(term["id"]), stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "original-finished") || stringOf(result["stopRequestedAt"]) != "" {
		t.Fatal("invalid stop reached process", result)
	}
	// An old button must not affect a replacement job in the same live shell.
	next, err := b.bridge(context.Background(), id, "terminal_execute_command", Object{"terminal_id": term["id"], "command": "sleep 0.5; printf replacement-finished", "run_in_background": true}, true)
	if err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", path, Object{"generation": term["generation"], "entryId": entry["id"]}, 409)
	completed := b.Terminals.Wait(ctx, id, stringOf(term["id"]), stringOf(object(next)["entry_id"]))
	if !strings.Contains(stringOf(completed["output"]), "replacement-finished") {
		t.Fatal("stale click stopped replacement", completed)
	}
}
