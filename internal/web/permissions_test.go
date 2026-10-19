package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestWritePermissionChangesTakeEffectWithinSameConversation(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "denied.md"), filepath.Join(dir, "allowed.md"), filepath.Join(dir, "revoked.md")}
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(step.Add(1))
		if n%2 == 1 && n <= 5 {
			emitModel(w, "", []ai.Call{{ID: fmt.Sprintf("write-%d", n), Name: "write", Arguments: jsonText(Object{"runtime": "local", "path": paths[(n-1)/2], "content": "explicit fixture write"})}})
		} else {
			emitModel(w, "本轮处理结束", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "permission update fixture", Protocol: "openai"})
	send := func() {
		t.Helper()
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "写入本轮演示文件"}, 202)
	}
	finish := func() { t.Helper(); waitAI(t, b, id, "completed"); b.workers.Wait() }
	reject := func(path string) {
		t.Helper()
		v := waitAI(t, b, id, "waiting_approval")
		if v.Pending == nil || v.Pending.Kind != "file_write" {
			t.Fatal("write did not request permission")
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("write happened before authorization", err)
		}
		apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": v.Pending.ID, "accept": false}, 200)
		finish()
	}
	send()
	reject(paths[0])
	saved := apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentWriteFiles": true}, 200)
	if saved["silentWriteFiles"] != true {
		t.Fatal("permission was not saved")
	}
	send()
	finish()
	content, err := os.ReadFile(paths[1])
	if err != nil || string(content) != "explicit fixture write" {
		t.Fatal("mid-conversation permission did not permit the next write", err)
	}
	v, _ := b.Engine.Snapshot(id)
	if v.Pending != nil || len(v.OperationOutcomes) != 0 {
		t.Fatal("new permission left a pending approval or false unknown")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentWriteFiles": false}, 200)
	send()
	reject(paths[2])
	if _, err := os.Stat(paths[0]); !os.IsNotExist(err) {
		t.Fatal("granting permission replayed an earlier rejected write")
	}
	other := b.Store.CreateSession(stringOf(b.Store.Session(id)["projectId"]), "unrelated conversation", nil)
	if b.sessionOptions(stringOf(other["id"]))["silentWriteFiles"] != false {
		t.Fatal("permission leaked into another conversation")
	}
}

func TestProgressiveTerminalPermissionCloseAndRecreate(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	b.Store.SaveOptions(id, Object{"contextWindow": 131072, "silentCommands": false, "silentTerminalCreation": false})
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		must(json.NewDecoder(r.Body).Decode(&req))
		if fixtureModelInspect(w, req, ref, "local") {
			return
		}
		requests.Add(1)
		emitModel(w, "会话授权状态已处理", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "progressive fixture", Protocol: "openai"})
	send := func() {
		t.Helper()
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "内存状态", "resourceIds": []string{ref}}, 202)
	}
	creation := func() string {
		t.Helper()
		view := waitAI(t, b, id, "waiting_approval")
		if view.Pending == nil || view.Pending.Kind != "terminal_open" || !view.Pending.NeedsTerminal || view.Pending.Call.Name != "inspect_host" {
			t.Fatal("missing terminal creation authorization")
		}
		return view.Pending.ID
	}
	complete := func() {
		t.Helper()
		waitAI(t, b, id, "completed")
		b.workers.Wait()
	}
	send()
	rejected := creation()
	if requests.Load() != 0 || len(objects(b.Store.Snapshot(id)["terminals"])) != 0 {
		t.Fatal("effect or model request happened before creation permission")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": rejected, "accept": false}, 200)
	complete()
	if len(objects(b.Store.Snapshot(id)["terminals"])) != 0 {
		t.Fatal("rejection still opened a terminal")
	}
	send()
	allowed := creation()
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": allowed, "accept": true}, 200)
	complete()
	tid := stringOf(b.Store.Options(id)["terminal_id"])
	if tid == "" || b.Store.Terminal(id, tid)["holder"] != "agent" {
		t.Fatal("creation approval did not establish the Agent session")
	}
	send()
	complete() // Reuse requires no second creation decision.
	if b.Store.Options(id)["terminal_id"] != tid {
		t.Fatal("live session was not reused")
	}
	before := len(objects(b.Store.Snapshot(id)["messages"]))
	apiTest(t, h, "DELETE", "/api/resources/"+ref+"/terminals/"+tid, nil, 200)
	if b.Store.Terminal(id, tid)["status"] != "disconnected" || len(objects(b.Store.Snapshot(id)["messages"])) != before {
		t.Fatal("resource closure did not preserve the conversation")
	}
	send()
	recreated := creation()
	if recreated == allowed || recreated == rejected || b.Store.Options(id)["terminal_id"] != tid {
		t.Fatal("recreation did not wait for a fresh decision")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": allowed, "accept": true}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": recreated, "accept": true}, 200)
	complete()
	newID := stringOf(b.Store.Options(id)["terminal_id"])
	if newID == tid || b.Store.Terminal(id, newID)["status"] != "ready" {
		t.Fatal("approved recreation did not produce a new connection")
	}
	catalog := apiTest(t, h, "GET", "/api/catalog", nil, 200)
	found := false
	for _, item := range objects(catalog["terminals"]) {
		if item["id"] == newID && item["sessionId"] == id && item["sessionTitle"] != "" {
			found = true
		}
	}
	if !found {
		t.Fatal("resource sidebar catalog lacks the live terminal/session metadata")
	}
}

func TestSessionPermissionSettingsAndBlocks(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	options := apiTest(t, h, "GET", "/api/sessions/"+id+"/ai/options", nil, 200)
	if options["silentReadFiles"] != true || options["silentCommands"] != true || options["silentTerminalCreation"] != true || options["silentWriteFiles"] != false || options["silentReadSQL"] != true || options["blockUnreferencedAssets"] != false || options["denyLocalExecution"] != false {
		t.Fatal("incorrect permission defaults")
	}
	// Permissions can be configured before a model is selected.
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"denyLocalExecution": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": "yes"}, 400)
	var blocked atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		json.NewDecoder(r.Body).Decode(&req)
		messages := objects(req["messages"])
		if len(messages) > 0 && strings.Contains(stringOf(messages[len(messages)-1]["content"]), "[HEXHUB_REFERENCES]") && fixtureModelInspect(w, req, ref, "local") {
			return
		}
		for _, m := range objects(req["messages"]) {
			if m["role"] == "tool" && strings.Contains(stringOf(m["content"]), "禁止本机执行") {
				blocked.Store(true)
			}
		}
		emitModel(w, "执行限制已生效", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "permissions", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "内存状态", "resourceIds": []string{ref}}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if !blocked.Load() || len(objects(b.Store.Snapshot(id)["terminals"])) != 0 {
		t.Fatal("local restriction allowed a terminal/command effect")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"denyLocalExecution": false, "silentTerminalCreation": true, "silentWriteFiles": true, "blockUnreferencedAssets": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "内存状态"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if len(objects(b.Store.Snapshot(id)["terminals"])) != 0 {
		t.Fatal("unreferenced host was automatically inspected")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "内存状态", "resourceIds": []string{ref}}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if len(objects(b.Store.Snapshot(id)["terminals"])) != 1 {
		t.Fatal("explicit reference/automatic-creation setting did not permit inspection")
	}
	second := b.Store.CreateSession(stringOf(b.Store.Session(id)["projectId"]), "different permission scope", []string{ref})
	other := apiTest(t, h, "GET", "/api/sessions/"+stringOf(second["id"])+"/ai/options", nil, 200)
	if other["blockUnreferencedAssets"] != false || other["silentWriteFiles"] != false {
		t.Fatal("permissions leaked between conversations")
	}
}

func TestCommandPermissionIsSeparateFromTerminalCreation(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	b.Store.SaveOptions(id, Object{"silentCommands": false, "silentTerminalCreation": false})
	marker := filepath.Join(t.TempDir(), "PERMISSION_MARKER")
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := step.Add(1)
		if n == 1 {
			emitModel(w, "", []ai.Call{{ID: "command-permission", Name: "shell", Arguments: jsonText(Object{"command": "touch " + quote(marker)})}})
		} else if n == 3 {
			emitModel(w, "", []ai.Call{{ID: "danger-permission", Name: "shell", Arguments: jsonText(Object{"command": "sh -c 'printf DANGER_PERMISSION_MARKER'"})}})
		} else {
			emitModel(w, "命令已完成", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "commands", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查并执行命令", "resourceIds": []string{ref}}, 202)
	view := waitAI(t, b, id, "waiting_approval")
	first := view.Pending.ID
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": first, "accept": true}, 200)
	// Avoid observing the still-visible first pending event after its decision.
	for n := 0; n < 800; n++ {
		view, _ = b.Engine.Snapshot(id)
		if view.Pending != nil && view.Pending.ID != first {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if view.Pending == nil || view.Pending.Kind != "command" || view.Pending.NeedsTerminal {
		t.Fatal("command was authorized implicitly by the creation decision")
	}
	tid := stringOf(b.Store.Options(id)["terminal_id"])
	if strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "PERMISSION_MARKER") {
		t.Fatal("command executed before its separate approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": true}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "PERMISSION_MARKER") {
		t.Fatal("approved command did not execute")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("approved ordinary write did not create its fixture file")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "危险类别确认测试"}, 202)
	view = waitAI(t, b, id, "completed")
	b.workers.Wait()
	if view.Pending != nil || !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "DANGER_PERMISSION_MARKER") {
		t.Fatal("non-destructive shell wrapper ignored command silence")
	}
}

func TestResourceTerminalCloseScopeAndAllSessions(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	other := b.Store.CreateResource(project, "different host", "local", nil)
	second := b.Store.CreateSession(project, "retained second conversation", []string{ref})
	sid := stringOf(second["id"])
	a := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	c := b.Terminals.OpenInteractive(context.Background(), sid, ref, "bash")
	background := b.Terminals.Open(context.Background(), id, ref)
	apiTest(t, h, "DELETE", "/api/resources/"+stringOf(other["id"])+"/terminals/"+stringOf(a["id"]), nil, 404)
	if b.Store.Terminal(id, stringOf(a["id"]))["status"] != "ready" {
		t.Fatal("mismatched resource closed another host's terminal")
	}
	result := apiTest(t, h, "DELETE", "/api/resources/"+ref+"/terminals", nil, 200)
	if integer(result["closed"]) != 2 || b.Store.Terminal(id, stringOf(a["id"]))["status"] != "disconnected" || b.Store.Terminal(sid, stringOf(c["id"]))["status"] != "disconnected" {
		t.Fatal("resource-wide close did not include all retained sessions")
	}
	if b.Store.Terminal(id, stringOf(background["id"]))["status"] != "ready" {
		t.Fatal("closing the manual list terminated an unlisted AI connection")
	}
	b.Store.Session(id)
	b.Store.Session(sid)
}
