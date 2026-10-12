package web

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func fixture(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	home := t.TempDir()
	b, e := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token", Static: fstest.MapFS{"index.html": {Data: []byte("React static fixture")}, "assets/app.js": {Data: []byte("script")}}})
	if e != nil {
		t.Fatal(e)
	}
	h := httptest.NewServer(b)
	t.Cleanup(func() { h.Close(); b.Close() })
	return b, h
}
func apiTest(t *testing.T, h *httptest.Server, method, path string, data any, status int) Object {
	t.Helper()
	var body io.Reader
	if data != nil {
		body = strings.NewReader(jsonText(data))
	}
	r, e := http.NewRequest(method, h.URL+path, body)
	if e != nil {
		t.Fatal(e)
	}
	r.Host = "localhost:4177"
	r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	if data != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, e := h.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
	}
	var o Object
	json.Unmarshal(raw, &o)
	return o
}
func newSession(t *testing.T, h *httptest.Server) (string, string) {
	p := apiTest(t, h, "POST", "/api/projects", Object{"name": "Go migration"}, 201)
	s := apiTest(t, h, "POST", "/api/projects/"+stringOf(p["id"])+"/sessions", Object{"title": "Persistent shell"}, 201)
	return stringOf(s["id"]), stringsOf(s["resourceIds"])[0]
}
func expectPanic(t *testing.T, status int, fn func()) {
	t.Helper()
	defer func() {
		p := recover()
		f, ok := p.(*Failure)
		if !ok || f.Status != status {
			t.Fatalf("expected failure %d; got %v", status, p)
		}
	}()
	fn()
	t.Fatal("expected failure")
}
func TestHTTPAuthenticationAndIsolation(t *testing.T) {
	b, h := fixture(t)
	r, _ := http.NewRequest("GET", h.URL+"/api/catalog", nil)
	r.Host = "localhost:4177"
	resp, e := h.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal(resp.StatusCode)
	}
	for _, bad := range []struct{ host, origin string }{{"evil.test:4177", ""}, {"localhost:4177", "https://evil.test"}} {
		r, _ := http.NewRequest("GET", h.URL+"/api/catalog", nil)
		r.Host = bad.host
		r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
		r.Header.Set("Origin", bad.origin)
		resp, e := h.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		if resp.StatusCode != 403 {
			t.Fatal(resp.StatusCode)
		}
	}
	boot := apiTest(t, h, "GET", "/api/bootstrap", nil, 200)
	if boot["backendRuntime"] != "go" || boot["terminalMode"] != "pty" {
		t.Fatal(boot)
	}
	apiTest(t, h, "GET", "/assets/missing.js", nil, 404)
	id, ref := newSession(t, h)
	second := b.Store.CreateProject("Other")
	other := b.Store.CreateSession(stringOf(second["id"]), "other", nil)
	apiTest(t, h, "POST", "/api/sessions/"+stringOf(other["id"])+"/terminals", Object{"resourceId": ref}, 404)
	apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
	apiTest(t, h, "GET", "/api/sessions/"+id+"/events?after=01", nil, 400)
}
func TestSSEReplayAndLive(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	r, _ := http.NewRequest("GET", h.URL+"/api/sessions/"+id+"/events?after=0", nil)
	r.Host = "localhost:4177"
	r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	resp, e := h.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer resp.Body.Close()
	scan := bufio.NewScanner(resp.Body)
	seen := []int{}
	for scan.Scan() {
		line := scan.Text()
		if strings.HasPrefix(line, "data: ") {
			var ev Object
			json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev)
			seen = append(seen, integer(ev["seq"]))
			break
		}
	}
	b.Store.AddMessage(id, "user", "SSE live", nil)
	for scan.Scan() {
		line := scan.Text()
		if strings.HasPrefix(line, "data: ") {
			var ev Object
			json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev)
			seen = append(seen, integer(ev["seq"]))
			break
		}
	}
	if len(seen) != 2 || seen[0] >= seen[1] {
		t.Fatal(seen)
	}
}

// Six HTTP/1 browser connections must still leave room for snapshots and sends.
func TestMultipleEventStreamsLeaveRoomForSessionRequests(t *testing.T) {
	_, h := fixture(t)
	id, _ := newSession(t, h)
	transport := &http.Transport{MaxConnsPerHost: 6}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	request := func(path string) *http.Response {
		t.Helper()
		r, err := http.NewRequest("GET", h.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Host = "localhost:4177"
		r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	for i := 0; i < 4; i++ {
		resp := request("/api/sessions/" + id + "/events?after=0")
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("stream %d: %d", i, resp.StatusCode)
		}
	}
	for i := 0; i < 4; i++ {
		resp := request("/api/sessions/" + id + "/events?after=0")
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") == "" {
			t.Fatalf("overflow stream should release its socket: %d", resp.StatusCode)
		}
		resp = request("/api/sessions/" + id + "/snapshot")
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("snapshot blocked: %d", resp.StatusCode)
		}
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": false}, 200)
}

func TestPersistentPTYAndOwnership(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := apiTest(t, h, "POST", "/api/sessions/"+id+"/terminals", Object{"resourceId": ref}, 201)
	tid := stringOf(term["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	run := func(command string) Object {
		t.Helper()
		entry := b.Terminals.Execute(id, tid, "user", command, "")
		return b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	}
	target := t.TempDir()
	result := run("cd " + quote(target) + "; export LAKE_FIXTURE_VALUE=survived")
	if integer(result["exitCode"]) != 0 {
		t.Fatal(result)
	}
	result = run("printf '%s:%s' \"$PWD\" \"$LAKE_FIXTURE_VALUE\"")
	if !strings.Contains(stringOf(result["output"]), target+":survived") {
		t.Fatal(result)
	}
	b.Terminals.Resize(id, tid, 80, 20)
	run("printf '\\033[2J\\033[Hhello\\033[2;1Hworld'")
	viewport := b.Terminals.Screen(id, tid, "viewport", 80, 20000)
	if !strings.HasPrefix(viewport, "hello\nworld") {
		t.Fatalf("viewport %q", viewport)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/terminals/"+tid+"/commands", Object{"actor": "agent", "command": "pwd"}, 403)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/terminals/"+tid+"/commands", Object{"actor": "user", "command": "touch /tmp/not-created"}, 400)
	b.Terminals.Control(id, tid, "agent")
	entry := b.Terminals.Execute(id, tid, "agent", "sleep 1", "")
	b.Terminals.Control(id, tid, "user")
	result = b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	if result["exitCode"] != nil {
		t.Fatal("takeover must leave unknown outcome", result)
	}
	entry = b.Terminals.Execute(id, tid, "user", "sleep 30", "")
	b.Terminals.Interrupt(id, tid)
	result = b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	if result["exitCode"] != nil || b.Store.Terminal(id, tid)["status"] != "ready" {
		t.Fatal(result)
	}
	if !strings.Contains(stringOf(run("printf '%s' \"$LAKE_FIXTURE_VALUE\"")["output"]), "survived") {
		t.Fatal("Ctrl-C lost shell environment")
	}
}
func TestModelsPrivateStorage(t *testing.T) {
	b, h := fixture(t)
	key := "synthetic-model-key-not-real"
	o := apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "http://localhost:12345/v1", "name": "fixture", "apiKey": key, "protocol": "openai"}, 200)
	if o["keyConfigured"] != true || strings.Contains(jsonText(o), key) {
		t.Fatal(o)
	}
	metadata, e := os.ReadFile(filepath.Join(b.Models.Dir, "model.json"))
	if e != nil || bytes.Contains(metadata, []byte(key)) {
		t.Fatal("credential in metadata", e)
	}
	var cfg Object
	json.Unmarshal(metadata, &cfg)
	p, e := privateFile(filepath.Join(b.Models.Home, "secrets"), stringOf(cfg["credentialRef"]))
	if e != nil {
		t.Fatal(e)
	}
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "http://localhost:12345/v1", "name": "changed"}, 200)
	if b.Models.Active().Key != key {
		t.Fatal("lost unchanged key")
	}
	os.Chmod(p, 0644)
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "http://name:secret@localhost:12345", "name": "bad"}, 400)
}
func TestRestartKeepsHistoryAndNeverReplays(t *testing.T) {
	home := t.TempDir()
	store, e := OpenStore(home)
	if e != nil {
		t.Fatal(e)
	}
	p := store.CreateProject("persisted")
	session := store.CreateSession(stringOf(p["id"]), "session", nil)
	id := stringOf(session["id"])
	ref := stringsOf(session["resourceIds"])[0]
	term := store.CreateTerminal(id, ref)
	tid := stringOf(term["id"])
	store.TerminalStatus(id, tid, "ready")
	store.AddMessage(id, "user", "saved", nil)
	store.Status(id, "investigating")
	store.BeginCommand(id, tid, "user", "sleep 30", "")
	store.Close()
	store, e = OpenStore(home)
	if e != nil {
		t.Fatal(e)
	}
	defer store.Close()
	if store.Session(id)["status"] != "failed" || store.Terminal(id, tid)["holder"] != nil || store.Terminal(id, tid)["status"] != "disconnected" {
		t.Fatal(store.Snapshot(id))
	}
	if len(objects(store.Snapshot(id)["messages"])) < 2 {
		t.Fatal("lost messages")
	}
}
func TestCommandPolicyBoundaries(t *testing.T) {
	for _, c := range []struct{ command, risk string }{
		{"sysctl -n hw.memsize", "readonly"},
		{"sysctl vm.swapusage", "readonly"},
		{"sysctl -w kern.maxfiles=1024", "write"},
		{"sysctl -n kern.bootargs", "write"},
		{"/tmp/sysctl -n hw.memsize", "write"},
		{"top -l 1 -o cpu -n 10", "readonly"},
		{"top -l 1 -o mem -n 10", "readonly"},
		{"top -b -n 1 -o %CPU", "readonly"},
		{"top -o cpu", "write"},
		{"top -l 1 -o", "write"},
		{"top -l 1 -o unknown", "write"},
		{"top -l 1 -o cpu > /tmp/top.txt", "write"},
	} {
		if got := CommandPolicy(c.command).Risk; got != c.risk {
			t.Errorf("%q => %s want %s", c.command, got, c.risk)
		}
	}
	for _, c := range []struct{ command, risk string }{{"vmstat 1 3", "readonly"}, {"pwd && uname -a", "readonly"}, {"printf '%s' hello", "readonly"}, {"cat ~/.ssh/id_ed25519", "dangerous"}, {"echo $(rm a)", "dangerous"}, {"printf -v a value", "write"}, {"find /tmp -delete", "dangerous"}, {"top", "write"}, {"cd /tmp", "write"}, {"touch a > b", "write"}, {"sh -c 'echo safe'", "dangerous"}} {
		p := CommandPolicy(c.command)
		if p.Risk != c.risk {
			t.Errorf("%q => %s want %s", c.command, p.Risk, c.risk)
		}
	}
}

func TestRawInputOwnershipAndRedaction(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	b.Models.Save(&ai.Model{URL: "http://127.0.0.1:12345/v1/chat/completions", Name: "fixture", Key: "synthetic-private-value", Protocol: "openai"})
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	entry := b.Terminals.Execute(id, tid, "user", "printf 'synthetic-'; printf 'private-value'", "")
	result := b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	if strings.Contains(stringOf(result["output"]), "synthetic-private-value") || !strings.Contains(stringOf(result["output"]), "[REDACTED]") {
		t.Fatal("terminal output secret not redacted")
	}
	b.Terminals.Control(id, tid, "agent")
	entry = b.Terminals.Execute(id, tid, "agent", "pwd", "")
	b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	expectPanic(t, 409, func() { b.Terminals.Input(id, tid, "fake\n", false) })
	b.Terminals.Control(id, tid, "user")
	entry = b.Terminals.Execute(id, tid, "user", "read answer; printf 'ANSWER:%s' \"$answer\"", "")
	b.Terminals.Input(id, tid, "hello\n", false)
	result = b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "ANSWER:hello") {
		t.Fatal(result)
	}
}
