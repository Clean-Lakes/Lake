package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fakeModel(t *testing.T, reply func(int, map[string]any) any) (Model, func()) {
	t.Helper()
	var count atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("bad request")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(reply(int(count.Add(1)), body))
	}))
	return Model{URL: s.URL, Name: "fixture", Protocol: "openai", ContextWindow: 64000, MaxOutput: 1024}, s.Close
}
func response(content string, calls ...Call) any {
	msg := map[string]any{"content": content}
	if len(calls) > 0 {
		list := []any{}
		for _, c := range calls {
			list = append(list, map[string]any{"id": c.ID, "type": "function", "function": map[string]any{"name": c.Name, "arguments": c.Arguments}})
		}
		msg["tool_calls"] = list
	}
	return map[string]any{"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": "stop"}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 4}}
}
func engineFor(t *testing.T, m Model, bridge Bridge) *Engine {
	t.Helper()
	if bridge != nil {
		original := bridge
		bridge = func(ctx context.Context, id, name string, args map[string]any, approved bool) (any, error) {
			value, err := original(ctx, id, name, args, approved)
			// A minimal fixture that does not implement policy still needs a trusted
			// synthetic target generation. Production bridges must return a fingerprint.
			if name == "policy" && err == nil && str(obj(value)["fingerprint"]) == "" {
				policy := obj(value)
				if policy == nil {
					policy = map[string]any{}
				}
				policy["fingerprint"] = "fixture-target-generation"
				return policy, nil
			}
			return value, err
		}
	}
	e, err := New(t.TempDir(), bridge, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Shutdown)
	if err = e.Configure("case", Config{Model: m, Profile: "core", Runtime: "local", Workspace: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	return e
}
func waitApproval(t *testing.T, e *Engine) *Approval {
	t.Helper()
	// Durable SDK initialization can exceed three seconds on native Windows CI.
	// Retain a bounded readiness wait and fail immediately on a terminal error.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		v, err := e.Snapshot("case")
		if err != nil {
			t.Fatal("approval snapshot failed", err)
		}
		if v.Pending != nil {
			return v.Pending
		}
		if v.Status == "failed" || v.Status == "cancelled" || v.Status == "completed" {
			var reason string
			for _, card := range v.Cards {
				if card.Type == "error" {
					reason = card.Content
				}
			}
			t.Fatalf("turn ended before approval: status=%s error=%s", v.Status, reason)
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("approval not emitted")
	return nil
}
func TestToolLoopAndPrivatePersistence(t *testing.T) {
	secret := "fixture-secret-\"quoted"
	m, close := fakeModel(t, func(n int, b map[string]any) any {
		if n == 1 {
			return response("", Call{"c1", "list_assets", `{"pattern":""}`})
		}
		messages := arr(b["messages"])
		if str(obj(messages[len(messages)-1])["tool_call_id"]) != "c1" {
			t.Error("tool ID lost")
		}
		return response("completed " + secret)
	})
	defer close()
	m.Key = secret
	e := engineFor(t, m, nil)
	if err := e.Chat(context.Background(), "case", "inspect", nil); err != nil {
		t.Fatal(err)
	}
	h, _ := e.History("case")
	if len(h) != 5 || h[3].CallID != "c1" {
		t.Fatal(h)
	}
	v, _ := e.Snapshot("case")
	if v.Status != "completed" || v.Usage.Total != 28 {
		t.Fatal(v)
	}
	start, startErr := time.Parse(time.RFC3339Nano, v.TurnStartedAt)
	finish, finishErr := time.Parse(time.RFC3339Nano, v.TurnFinishedAt)
	if startErr != nil || finishErr != nil || finish.Before(start) {
		t.Fatal("missing or invalid turn timing")
	}
	b, err := os.ReadFile(filepath.Join(e.Dir, "case.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted any
	if json.Unmarshal(b, &persisted) != nil || strings.Contains(string(b), "fixture-secret") {
		t.Fatal("credential leaked or JSON corrupted")
	}
	st, _ := os.Stat(filepath.Join(e.Dir, "case.json"))
	if st.Mode().Perm() != 0600 {
		t.Fatal("state permissions")
	}
	e2, _ := New(e.Dir, nil, nil)
	restored, _ := e2.Snapshot("case")
	if restored.Status != "completed" || restored.Usage.Total != 28 {
		t.Fatal(restored)
	}
	if restored.TurnStartedAt != v.TurnStartedAt || restored.TurnFinishedAt != v.TurnFinishedAt {
		t.Fatal("turn timing was not persisted")
	}
}
func TestTurnTimingResetsBetweenRounds(t *testing.T) {
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { return response("done") })
	defer closeModel()
	e := engineFor(t, m, nil)
	for round := 0; round < 2; round++ {
		old, _ := e.Snapshot("case")
		if err := e.Chat(context.Background(), "case", "round", nil); err != nil {
			t.Fatal(err)
		}
		v, _ := e.Snapshot("case")
		if v.TurnStartedAt == "" || v.TurnFinishedAt == "" || v.TurnStartedAt == old.TurnStartedAt {
			t.Fatal("turn timing reused")
		}
	}
	if err := e.Clear("case"); err != nil {
		t.Fatal(err)
	}
	v, _ := e.Snapshot("case")
	if v.TurnStartedAt != "" || v.TurnFinishedAt != "" {
		t.Fatal("cleared context retained active timing")
	}
}
func TestApprovalFrozenAndSingleUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "change")
	m, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{"c1", "write", js(map[string]any{"path": path, "content": "new"})})
		}
		return response("done")
	})
	defer close()
	e := engineFor(t, m, nil)
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "write", nil) }()
	p := waitApproval(t, e)
	waiting, _ := e.Snapshot("case")
	if waiting.TurnStartedAt == "" || waiting.TurnFinishedAt != "" {
		t.Fatal("waiting turn should retain its start without a finish time")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("write happened before approval")
	}
	if err := e.Decision("case", p.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	if err := e.Decision("case", p.ID, true, ""); err == nil {
		t.Fatal("approval reused")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "new" {
		t.Fatal(string(b))
	}
	written, _ := e.Snapshot("case")
	var change Card
	for _, card := range written.Cards {
		if card.Type == "diff" {
			change = card
		}
	}
	if change.Title != path || obj(change.Data)["existed"] != false || obj(change.Data)["runtime"] != "local" {
		t.Fatal("file diff omitted its target or creation state")
	}
	if _, err := e.UndoFile(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("new file undo failed")
	}
	restored, _ := e.Snapshot("case")
	undo := restored.Cards[len(restored.Cards)-1]
	if undo.Type != "diff" || undo.Title != path || obj(undo.Data)["before"] != "new" || obj(undo.Data)["after"] != "" || obj(undo.Data)["deleted"] != true || obj(undo.Data)["existed"] != true {
		t.Fatal("restored file did not produce a reverse diff")
	}
}
func TestApprovalDriftAndCancellation(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(fmt.Sprint(cancel), func(t *testing.T) {
			var fp atomic.Int32
			path := filepath.Join(t.TempDir(), "never")
			m, close := fakeModel(t, func(n int, _ map[string]any) any {
				if n == 1 {
					return response("", Call{"c1", "write", js(map[string]any{"path": path, "content": "new"})})
				}
				return response("no change")
			})
			defer close()
			e := engineFor(t, m, func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
				return map[string]any{"fingerprint": fmt.Sprint(fp.Load())}, nil
			})
			done := make(chan error, 1)
			go func() { done <- e.Chat(context.Background(), "case", "change", nil) }()
			p := waitApproval(t, e)
			if cancel {
				_ = e.Abort("case")
			} else {
				fp.Add(1)
				_ = e.Decision("case", p.ID, true, "")
			}
			err := <-done
			if cancel && err == nil {
				t.Fatal("cancel returned success")
			}
			if _, err = os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("stale/cancelled write ran")
			}
			h, _ := e.History("case")
			if err = validHistory(h); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestLegacyRestartDoesNotReplayPending(t *testing.T) {
	m, close := fakeModel(t, func(_ int, _ map[string]any) any {
		return response("", Call{"c1", "write", `{"path":"/tmp/should-never-exist-lake-test","content":"no"}`})
	})
	defer close()
	e := engineFor(t, m, nil)
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "write", nil) }()
	p := waitApproval(t, e)
	// This fixture intentionally represents a pre-ADK interrupted approval.
	// Native durable approvals have a separate crash/restart acceptance test.
	statePath := filepath.Join(e.Dir, "case.json")
	raw, readErr := os.ReadFile(statePath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	var legacy State
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatal(err)
	}
	legacy.Runtime = nil
	legacy.View.PendingApprovals = nil
	raw, _ = json.Marshal(legacy)
	legacyDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(legacyDir, "case.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	e2, _ := New(legacyDir, nil, nil)
	t.Cleanup(e2.Shutdown)
	v, err := e2.Snapshot("case")
	if err != nil || v.Status != "interrupted" || v.Pending != nil {
		t.Fatal(v, err)
	}
	if e2.Decision("case", p.ID, true, "") == nil {
		t.Fatal("old approval revived")
	}
	h, _ := e2.History("case")
	if validHistory(h) != nil {
		t.Fatal("unpaired restored tools")
	}
	_ = e.Abort("case")
	<-done
}
func TestRemoteTargetNeverFallsBack(t *testing.T) {
	m, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("done") })
	defer close()
	e := engineFor(t, m, nil)
	c := Config{Model: m, Runtime: "ssh", AssetRef: "missing", Assets: []Asset{{ID: "local", Kind: "local", Name: "local"}}}
	if _, err := e.command(context.Background(), c, map[string]any{}, "touch /tmp/lake-fallback"); err == nil {
		t.Fatal("missing remote accepted")
	}
	if _, err := e.command(context.Background(), c, map[string]any{"runtime": "local", "asset_ref": "missing"}, "true"); err == nil {
		t.Fatal("remote alias ran locally")
	}
	if _, err := e.docker(context.Background(), Config{Assets: []Asset{{ID: "d", Kind: "docker"}}}, "list_docker_containers", map[string]any{"asset_ref": "d"}); err == nil {
		t.Fatal("Docker silently used local daemon")
	}
}
func TestFileUndoRejectsDrift(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	_ = os.WriteFile(path, []byte("before"), 0644)
	m, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("done") })
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	c := s.state.Config
	if _, err := e.file(context.Background(), s, c, "write", map[string]any{"path": path, "content": "after"}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0644 {
		t.Fatal("mode changed")
	}
	_ = os.WriteFile(path, []byte("external"), 0644)
	if _, err := e.UndoFile(context.Background(), "case"); err == nil {
		t.Fatal("overwrote external change")
	}
	_ = os.WriteFile(path, []byte("after"), 0644)
	if _, err := e.UndoFile(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "before" {
		t.Fatal(string(b))
	}
}
func TestSQLiteAndSQLPolicies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	as := Asset{ID: "db", Kind: "database", Settings: map[string]any{"driver": "sqlite", "path": path}}
	conn, _, err := databaseOpen(as, false, "")
	if err != nil {
		t.Fatal(err)
	} // create fixture separately, asset tools never create an absent DB implicitly.
	conn.Close()
	os.WriteFile(path, nil, 0600)
	conn, _, _ = databaseOpen(as, false, "")
	_, err = conn.Exec("CREATE TABLE sample(id INTEGER); INSERT INTO sample VALUES(1)")
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	e, _ := New(t.TempDir(), nil, nil)
	c := Config{Assets: []Asset{as}}
	value, err := e.database(context.Background(), c, "execute_sql", map[string]any{"asset_ref": "db", "sql": "SELECT * FROM sample"})
	if err != nil || len(arr(obj(value)["rows"])) != 1 {
		t.Fatal(value, err)
	}
	value, err = e.database(context.Background(), c, "db_table_ddl", map[string]any{"asset_ref": "db", "schema": "main", "table": "sample"})
	if err != nil || !strings.Contains(js(value), "CREATE TABLE") {
		t.Fatal(value, err)
	}
	for _, s := range []string{"SELECT 1;DELETE FROM sample", "SELECT pg_read_file('/a')", "SELECT * INTO OUTFILE '/x' FROM sample", "SELECT 1 -- hidden"} {
		if readonlySQL(s) {
			t.Fatal(s)
		}
	}
	if !readonlySQL("SELECT count(*) FROM sample;") {
		t.Fatal("ordinary SELECT blocked")
	}
}
func TestProfilesAndSchemaValidation(t *testing.T) {
	all := map[string]bool{}
	for _, p := range []string{"core", "terminal2", "db-query-editor"} {
		for _, tool := range Catalog(p) {
			all[tool.Name] = true
		}
		if strings.Contains(Prompt(Config{Profile: p, Runtime: "local"}), "%!s") {
			t.Fatal("prompt substitutions")
		}
	}
	if len(all) != 45+len(extendedTools()) || !all["list_resource_groups"] || !all["inspect_host"] || !all["preview_resource_import"] || !all["import_resources"] {
		t.Fatal(len(all))
	}
	for _, tool := range Catalog("core") {
		if tool.Name == "list_assets" {
			if validateTool(tool, map[string]any{}) == nil || validateTool(tool, map[string]any{"pattern": 123}) == nil {
				t.Fatal("required/type unchecked")
			}
		}
	}
	if !redisReadOnly(`GET "key with spaces"`) || redisReadOnly("EVAL 'return 1' 0") || redisReadOnly("CONFIG SET dir /tmp") {
		t.Fatal("Redis policy")
	}
}
func TestRollbackCompactionAndPresets(t *testing.T) {
	m, close := fakeModel(t, func(n int, b map[string]any) any {
		if strings.Contains(str(obj(arr(b["messages"])[0])["content"]), "Extract a reusable") {
			return response(`{"title":"检查","content":"先读取证据再分析"}`)
		}
		return response(fmt.Sprintf("response %d", n))
	})
	defer close()
	e := engineFor(t, m, nil)
	for _, text := range []string{"one", "two", "three"} {
		if err := e.Chat(context.Background(), "case", text, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.Rollback("case"); err != nil {
		t.Fatal(err)
	}
	v, _ := e.Snapshot("case")
	if v.Turns != 2 {
		t.Fatal(v)
	}
	if err := e.Compact(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	h, _ := e.History("case")
	if validHistory(h) != nil {
		t.Fatal(h)
	}
	if e.Rollback("case") == nil {
		t.Fatal("checkpoint survived compaction")
	}
	p, err := e.ExtractPreset(context.Background(), "case")
	if err != nil || p.Title != "检查" {
		t.Fatal(p, err)
	}
	list, _ := e.Presets()
	if len(list) != 1 {
		t.Fatal(list)
	}
	if err = e.Clear("case"); err != nil {
		t.Fatal(err)
	}
	h, _ = e.History("case")
	if len(h) != 0 {
		t.Fatal(h)
	}
}
func TestConcurrentSnapshotsAndAbort(t *testing.T) {
	ready := make(chan struct{})
	mserver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(ready)
		<-r.Context().Done()
	}))
	defer mserver.Close()
	m := Model{URL: mserver.URL, Name: "fixture"}
	e := engineFor(t, m, nil)
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "stream", nil) }()
	<-ready
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = e.Snapshot("case") }()
	}
	wg.Wait()
	_ = e.Abort("case")
	if <-done == nil {
		t.Fatal("abort succeeded")
	}
}

func TestFilePreviewRejectsConcurrentChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config")
	_ = os.WriteFile(path, []byte("before"), 0600)
	m, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{"c1", "write", js(map[string]any{"path": path, "content": "after"})})
		}
		return response("changed file left intact")
	})
	defer close()
	e := engineFor(t, m, nil)
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "change", nil) }()
	p := waitApproval(t, e)
	if str(obj(p.Preview)["before"]) != "before" {
		t.Fatal("approval has no before/after preview")
	}
	_ = os.WriteFile(path, []byte("external"), 0600)
	if err := e.Decision("case", p.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "external" {
		t.Fatal("overwrote concurrent edit")
	}
}
func TestTranscriptPagesAndCredentialRedaction(t *testing.T) {
	m, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("done") })
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	for i := 0; i < 500; i++ {
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: fmt.Sprint(i), Type: "message", Content: "line", At: timestamp()})
	}
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: "secret", Data: map[string]any{"password": "synthetic-private-value"}})
	s.mu.Unlock()
	view, err := e.Snapshot("case")
	if err != nil || view.TotalCards != 501 || view.CardsOffset != 201 || len(view.Cards) != 300 {
		t.Fatal(view, err)
	}
	if strings.Contains(js(view), "synthetic-private-value") {
		t.Fatal("structured secret leaked")
	}
	page, err := e.SnapshotPage("case", view.CardsOffset, 100)
	if err != nil || page.CardsOffset != 101 || len(page.Cards) != 100 {
		t.Fatal(page, err)
	}
}
