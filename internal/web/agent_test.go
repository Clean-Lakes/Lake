package web

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func emitModel(w http.ResponseWriter, content string, calls []ai.Call) {
	w.Header().Set("Content-Type", "text/event-stream")
	delta := Object{}
	reason := "stop"
	if content != "" {
		delta["content"] = content
	}
	if len(calls) > 0 {
		items := []Object{}
		for i, c := range calls {
			items = append(items, Object{"index": i, "id": c.ID, "type": "function", "function": Object{"name": c.Name, "arguments": c.Arguments}})
		}
		delta["tool_calls"] = items
		reason = "tool_calls"
	}
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", jsonText(Object{"choices": []Object{{"index": 0, "delta": delta, "finish_reason": reason}}, "usage": Object{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}))
}
func waitAI(t *testing.T, b *Server, id, want string) ai.View {
	t.Helper()
	until := time.Now().Add(8 * time.Second)
	for time.Now().Before(until) {
		v, e := b.Engine.Snapshot(id)
		if e != nil {
			t.Fatal(e)
		}
		if v.Status == want {
			return v
		}
		time.Sleep(10 * time.Millisecond)
	}
	v, _ := b.Engine.Snapshot(id)
	t.Fatalf("want %s got %s: %s", want, v.Status, jsonText(v))
	return v
}

func allowFixtureHost(b *Server, id string) {
	options := b.Store.Options(id)
	options["silentTerminalCreation"] = true
	options["silentCommands"] = true
	b.Store.SaveOptions(id, options)
}
func TestGoHTTPAIApprovalAndHistory(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	target := filepath.Join(t.TempDir(), "approved.txt")
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		json.NewDecoder(r.Body).Decode(&req)
		switch step.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "shell-fixture", Name: "shell", Arguments: jsonText(Object{"command": "printf NATIVE_GO_AI", "runtime": "local"})}})
		case 2:
			emitModel(w, "", []ai.Call{{ID: "write-fixture", Name: "write", Arguments: jsonText(Object{"path": target, "content": "approved native Go", "runtime": "local"})}})
		default:
			emitModel(w, "本轮已完成", nil)
		}
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "Go fixture"}, 202)
	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Call.Name != "write" {
		t.Fatal(view)
	}
	if _, e := os.Stat(target); !os.IsNotExist(e) {
		t.Fatal("effect before approval")
	}
	snap := b.Store.Snapshot(id)
	terms := objects(snap["terminals"])
	if len(terms) != 1 || !strings.Contains(stringOf(b.Store.History(id, stringOf(terms[0]["id"]))["output"]), "NATIVE_GO_AI") {
		t.Fatal(snap)
	}
	pending := view.Pending.ID
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": pending, "accept": true}, 200)
	waitAI(t, b, id, "completed")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": pending, "accept": true}, 409)
	actual, e := os.ReadFile(target)
	if e != nil || string(actual) != "approved native Go" {
		t.Fatal("approved effect missing", e)
	}
	// Wait for the final SQLite conversation export as well as the engine completion.
	until := time.Now().Add(time.Second)
	for b.Store.Session(id)["status"] == "investigating" && time.Now().Before(until) {
		time.Sleep(time.Millisecond)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/undoFile", Object{}, 200)
	if _, e = os.Stat(target); !os.IsNotExist(e) {
		t.Fatal("file undo failed")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/rollback", Object{}, 200)
	apiTest(t, h, "POST", "/api/ai/presets", Object{"title": "fixture", "content": "test reusable workflow"}, 200)
	apiTest(t, h, "GET", "/api/sessions/"+id+"/ai/history", nil, 200)
	apiTest(t, h, "GET", "/api/sessions/"+id+"/ai/tools", nil, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/clear", Object{}, 200)
}

func TestEarlierPendingActionsDoNotBlockFreshReadOnlyTurn(t *testing.T) {
	for _, state := range []string{"disconnected", "user", "agent"} {
		t.Run(state, func(t *testing.T) { testEarlierPendingActions(t, state) })
	}
}

func testEarlierPendingActions(t *testing.T, holder string) {
	t.Helper()
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	opts := b.Store.Options(id)
	opts["contextWindow"] = 131072
	b.Store.SaveOptions(id, opts)
	b.Store.AddMessage(id, "user", "上一轮检查", nil)
	var oldTerminal Object
	if holder == "disconnected" {
		oldTerminal = b.Store.CreateTerminal(id, ref)
		b.Store.TerminalStatus(id, stringOf(oldTerminal["id"]), "disconnected")
	} else {
		oldTerminal = b.Terminals.Open(context.Background(), id, ref)
		if holder == "agent" {
			oldTerminal = b.Terminals.Control(id, stringOf(oldTerminal["id"]), "agent")
		}
	}
	tid := stringOf(oldTerminal["id"])
	oldTerminal = b.Store.Terminal(id, tid)
	oldFile := filepath.Join(t.TempDir(), "must-not-replay.txt")
	oldRead := b.Store.AddAction(id, ref, tid, "vmstat 1 3", "上一轮只读检查")
	oldWrite := b.Store.AddAction(id, ref, tid, "printf OLD > "+quote(oldFile), "上一轮待批准写入")
	newFile := filepath.Join(t.TempDir(), "new-write.txt")
	var step atomic.Int32
	var collected atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if fixtureModelInspect(w, req, ref, "local") {
			return
		}
		hasShell := false
		for _, tool := range objects(req["tools"]) {
			if object(tool["function"])["name"] == "shell" {
				hasShell = true
			}
		}
		if !hasShell {
			t.Error("earlier pending action disabled this turn's shell tool")
		}
		if strings.Contains(jsonText(req["messages"]), "Continue conversation without any tools") {
			t.Error("stale conversation-only instruction sent to model")
		}
		switch step.Add(1) {
		case 1:
			if !strings.Contains(jsonText(req["messages"]), "pendingOperations") || !strings.Contains(jsonText(req["messages"]), "HEXHUB_REFERENCES") {
				t.Error("missing historical operation context or referenced target")
			}
			for _, m := range objects(req["messages"]) {
				if m["role"] == "tool" && m["name"] == "inspect_host" {
					var data Object
					json.Unmarshal([]byte(stringOf(m["content"])), &data)
					output := jsonText(data["checks"])
					memory := strings.Contains(output, "Mach Virtual Memory") || strings.Contains(output, "Mem:")
					collected.Store(memory && strings.Contains(output, "PID") && data["terminal_id"] != tid)
				}
			}
			// The preceding model call chose inspection; this response consumes its evidence.
			emitModel(w, "已经采集本轮进程数据", nil)
		case 2:
			emitModel(w, "", []ai.Call{{ID: "fresh-write", Name: "write", Arguments: jsonText(Object{"path": newFile, "content": "new operation", "runtime": "local"})}})
		default:
			emitModel(w, "本轮写入已拒绝", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "pending-turn fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "什么进程资源占用过高", "resourceIds": []string{ref}}, 202)
	view := waitAI(t, b, id, "completed")
	if !collected.Load() || view.Pending != nil {
		t.Fatal("model-selected fresh process evidence was not collected")
	}
	// Engine completion is published before the SQLite assistant message export.
	b.workers.Wait()
	entries := b.Store.Recent(id)
	if len(entries) < 4 {
		t.Fatal("fresh host checks missing")
	}
	for _, entry := range entries {
		if entry["terminalId"] == tid || entry["command"] == oldRead["command"] || entry["command"] == oldWrite["command"] {
			t.Fatal("earlier pending command or terminal was reused")
		}
	}
	assertOldPending := func() {
		t.Helper()
		currentTerminal := b.Store.Terminal(id, tid)
		if currentTerminal["holder"] != oldTerminal["holder"] || currentTerminal["status"] != oldTerminal["status"] || currentTerminal["contextVersion"] != oldTerminal["contextVersion"] {
			t.Fatal("fresh inspection changed the earlier terminal's ownership or approval context", currentTerminal)
		}
		for _, original := range []Object{oldRead, oldWrite} {
			current := b.Store.Action(stringOf(original["id"]))
			if current["status"] != "pending" || current["createdAt"] != original["createdAt"] || current["updatedAt"] != original["updatedAt"] {
				t.Fatal("new turn changed an earlier approval", current)
			}
		}
		if _, err := os.Stat(oldFile); !os.IsNotExist(err) {
			t.Fatal("earlier write was replayed", err)
		}
	}
	assertOldPending()
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "本轮新写入"}, 202)
	view = waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Call.ID != "fresh-write" {
		t.Fatal("new write did not receive its own approval", view)
	}
	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Fatal("new write executed without approval", err)
	}
	assertOldPending()
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	assertOldPending()
	if _, err := os.Stat(newFile); !os.IsNotExist(err) {
		t.Fatal("rejected write executed", err)
	}
}
func TestAIAbortAndTerminalFingerprint(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"stream\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "abort fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "abort"}, 202)
	waitAI(t, b, id, "running")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
	waitAI(t, b, id, "cancelled")
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	p1, e := b.bridge(context.Background(), id, "policy", Object{"name": "terminal_execute_command", "arguments": Object{"terminal_id": tid, "command": "pwd"}}, false)
	if e != nil {
		t.Fatal(e)
	}
	b.Terminals.Control(id, tid, "user")
	p2, e := b.bridge(context.Background(), id, "policy", Object{"name": "terminal_execute_command", "arguments": Object{"terminal_id": tid, "command": "pwd"}}, false)
	if e != nil {
		t.Fatal(e)
	}
	if object(p1)["fingerprint"] == object(p2)["fingerprint"] {
		t.Fatal("ownership drift ignored")
	}
}

func TestHostConversationConnectsReadsReusesAndReconnects(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	allowFixtureHost(b, id)
	// Lifecycle checks use a larger fixture window so OS output size cannot
	// trigger an unrelated compaction request to this scripted provider.
	options := b.Store.Options(id)
	options["contextWindow"] = 131072
	b.Store.SaveOptions(id, options)
	cwd := t.TempDir()
	var step atomic.Int32
	var firstTerminal string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		json.NewDecoder(r.Body).Decode(&req)
		if fixtureModelInspect(w, req, ref, "local") {
			return
		}
		latest := Object{}
		for _, m := range objects(req["messages"]) {
			if m["role"] == "tool" && m["name"] == "inspect_host" {
				json.Unmarshal([]byte(stringOf(m["content"])), &latest)
			}
		}
		memory := false
		for _, check := range objects(latest["checks"]) {
			if check["exitCode"] == float64(0) && (strings.Contains(stringOf(check["output"]), "Mach Virtual Memory") || strings.Contains(stringOf(check["output"]), "Mem:")) {
				memory = true
			}
		}
		if !memory || latest["status"] != "ready" || latest["runtime"] != "local" {
			t.Error("model-selected inspection did not return live host memory evidence")
		}
		tid := stringOf(latest["terminal_id"])
		switch step.Add(1) {
		case 1:
			firstTerminal = tid
			emitModel(w, "已读取初始会话内存数据", nil)
		case 2:
			if tid != firstTerminal {
				t.Error("second round opened another terminal instead of reusing the bound session")
			}
			foundCwd := false
			for _, check := range objects(latest["checks"]) {
				if check["command"] == "pwd" && strings.Contains(stringOf(check["output"]), cwd) {
					foundCwd = true
				}
			}
			if !foundCwd {
				t.Error("persistent shell cwd was lost")
			}
			emitModel(w, "", []ai.Call{{ID: "read-bound-session", Name: "ssh_terminal_read", Arguments: jsonText(Object{"terminal_id": tid, "mode": "tail", "lines": 80, "max_chars": 20000})}})
		case 3:
			read := false
			for _, m := range objects(req["messages"]) {
				if m["role"] == "tool" && m["tool_call_id"] == "read-bound-session" && strings.Contains(stringOf(m["content"]), firstTerminal) && !strings.Contains(stringOf(m["content"]), `"error"`) {
					read = true
				}
			}
			if !read {
				t.Error("model could not read the live bound terminal")
			}
			emitModel(w, "已继续读取同一会话", nil)
		default:
			if tid == firstTerminal || tid == "" {
				t.Error("disconnected terminal was not reconnected")
			}
			emitModel(w, "已重连并读取新数据", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "host lifecycle", Protocol: "openai"})
	send := func(refs []string) {
		t.Helper()
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "内存状态", "resourceIds": refs}, 202)
		// Wait for the worker, including model-selected connection and final export.
		b.workers.Wait()
		view, err := b.Engine.Snapshot(id)
		if err != nil || view.Status != "completed" {
			t.Fatal("host turn failed", err, view.Status)
		}
	}
	send([]string{ref})
	tid := stringOf(b.Store.Options(id)["terminal_id"])
	if tid == "" || b.Store.Options(id)["asset_ref"] != ref || b.Store.Terminal(id, tid)["holder"] != "agent" {
		t.Fatal("initial conversation did not bind an Agent terminal")
	}
	b.Terminals.Control(id, tid, "user")
	entry := b.Terminals.Execute(id, tid, "user", "cd "+quote(cwd), "")
	b.Terminals.Wait(context.Background(), id, tid, stringOf(entry["id"]))
	b.Terminals.Control(id, tid, "agent")
	send(nil)
	if b.Store.Options(id)["terminal_id"] != tid {
		t.Fatal("persistent terminal binding changed across turns")
	}
	b.Terminals.Close(id, tid)
	send(nil)
	if b.Store.Options(id)["terminal_id"] == tid || step.Load() != 4 {
		t.Fatal("reconnect/read lifecycle failed")
	}
}

func TestAIBackgroundPersistentTerminal(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		json.NewDecoder(r.Body).Decode(&req)
		hasTool := false
		for _, m := range objects(req["messages"]) {
			if m["role"] == "tool" && m["tool_call_id"] == "background-fixture" {
				hasTool = true
			}
		}
		if hasTool {
			emitModel(w, "background started", nil)
		} else {
			emitModel(w, "", []ai.Call{{ID: "background-fixture", Name: "shell", Arguments: jsonText(Object{"command": "sleep 1; printf BACKGROUND_GO", "run_in_background": true, "timeout": 3000})}})
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "background", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "background"}, 202)
	view := waitAI(t, b, id, "completed")
	shellID := ""
	for _, c := range view.Cards {
		if c.Type == "operation" && c.Title == "shell" {
			var data Object
			json.Unmarshal([]byte(c.Content), &data)
			shellID = stringOf(data["shell_id"])
		}
	}
	if shellID == "" {
		t.Fatal("missing background job", view)
	}
	result, e := b.handleAI(context.Background(), "waitShell", id, Object{"shell_id": shellID, "timeout": 3000})
	if e != nil {
		t.Fatal(e)
	}
	if object(result)["status"] != "completed" || !strings.Contains(jsonText(result), "BACKGROUND_GO") {
		t.Fatal(result)
	}
	_, e = b.handleAI(context.Background(), "shellOutput", "another-session", Object{"shell_id": shellID})
	if e == nil {
		t.Fatal("cross-session shell access")
	}
}

func TestImageMetadataAndAuthenticatedBytes(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	pngBytes, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
	validated, e := ai.ValidateImages([]ai.ImageAttachment{{ID: "fixture-image", MimeType: "image/png", Base64: base64.StdEncoding.EncodeToString(pngBytes)}})
	if e != nil {
		t.Fatal(e)
	}
	message := b.Store.AddMessage(id, "user", "image fixture", validated)
	snap := b.Store.Snapshot(id)
	image := objects(objects(snap["messages"])[0]["images"])[0]
	if image["base64"] != "" || image["url"] == nil {
		t.Fatal("raw attachment leaked in snapshot")
	}
	path := "/api/sessions/" + id + "/messages/" + stringOf(message["id"]) + "/images/fixture-image"
	r, _ := http.NewRequest("GET", h.URL+path, nil)
	r.Host = "localhost:4177"
	response, e := h.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("unauthed image")
	}
	r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	response, e = h.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !bytes.Equal(body, pngBytes) {
		t.Fatal("wrong image bytes")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "bad", "images": []any{}}, 400)
}

func TestImageOnlyMessageKeepsUserTextEmpty(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	requests := make(chan Object, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload Object
		if err := json.NewDecoder(r.Body).Decode(&payload); err == nil {
			requests <- payload
		}
		emitModel(w, "收到图片", nil)
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "image-fixture", "supportsImageInput": true}, 200)
	pngBytes, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
	image := Object{"id": "image-only", "name": "image.png", "mimeType": "image/png", "base64": base64.StdEncoding.EncodeToString(pngBytes)}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "", "images": []any{image}}, 202)
	waitAI(t, b, id, "completed")
	snapshot := b.Store.Snapshot(id)
	user := objects(snapshot["messages"])[0]
	if user["text"] != "" || len(objects(user["images"])) != 1 {
		t.Fatal("image-only message gained synthetic text or lost its image")
	}
	select {
	case payload := <-requests:
		messages := objects(payload["messages"])
		content := objects(messages[len(messages)-1]["content"])
		images := 0
		for _, part := range content {
			if part["type"] == "image_url" {
				images++
			}
			if strings.Contains(stringOf(part["text"]), "请分析附加图片") {
				t.Fatal("model payload contains an injected image instruction")
			}
		}
		if images != 1 {
			t.Fatal("model payload lost the attached image")
		}
	default:
		t.Fatal("model request missing")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": ""}, 400)
}
