package web

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSecurityRecoveryRestoresProjectsWithoutWorkersOrWrites(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy_schema=%v", legacy), func(t *testing.T) {
			testSecurityRecoveryRestoresProjects(t, legacy)
		})
	}
}

func testSecurityRecoveryRestoresProjects(t *testing.T, legacy bool) {
	b, httpServer := fixture(t)
	id, resource := newSession(t, httpServer)
	home, root := b.options.Home, b.securityRuntime.RuntimeRoot
	b.Store.AddMessage(id, "assistant", "saved history", nil)
	task, err := b.Store.CreateSRETask(ai.SRETask{SessionID: id, RequestID: "saved-task", Goal: "verify the existing result", Mode: "assist", Scope: []string{resource}})
	if err != nil {
		t.Fatal(err)
	}
	state := ai.State{View: ai.View{Session: id, Status: "running", Cards: []ai.Card{{ID: "historical", Type: "assistant", Content: "original conclusion"}}}}
	statePath := filepath.Join(b.options.DataDir, "ai", id+".json")
	data, _ := json.Marshal(state)
	if err = os.WriteFile(statePath, data, 0600); err != nil {
		t.Fatal(err)
	}
	b.Close()
	if legacy {
		// An upgrade can close the security gate before OpenStore has installed
		// natural memory. Recovery must read that older schema without migrating it.
		db, err := sql.Open("sqlite", filepath.Join(b.options.DataDir, "lake-web.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		rows, err := db.Query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'natural*'")
		if err != nil {
			t.Fatal(err)
		}
		var tables []string
		for rows.Next() {
			var name string
			if err = rows.Scan(&name); err != nil {
				t.Fatal(err)
			}
			tables = append(tables, name)
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		for _, name := range tables {
			if _, err = db.Exec(`DROP TABLE "` + name + `"`); err != nil {
				t.Fatal(err)
			}
		}
		db.Close()
	}
	ledgerPath := filepath.Join(root, "sessions.sqlite")
	db, err := sql.Open("sqlite", ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE native_operations(id TEXT PRIMARY KEY,session_id TEXT,tool TEXT,target TEXT,status TEXT,handle TEXT,result TEXT,risk TEXT,started_at DATETIME); INSERT INTO native_operations VALUES('old-operation',?,'shell','test-resource','unknown','old-handle','','write',?)`, id, time.Now().UTC())
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	c, err := ai.ReadSecurityControl(home)
	if err != nil {
		t.Fatal(err)
	}
	c.Gate = "closed"
	controlPath := filepath.Join(home, "security", "control.json")
	data, _ = json.Marshal(c)
	if err = os.WriteFile(controlPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	pendingPath := filepath.Join(home, "security", "legacy-inventory.pending")
	if err = os.WriteFile(pendingPath, []byte(`{"storeID":"`+c.StoreID+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	paths := []string{controlPath, pendingPath, statePath, ledgerPath, filepath.Join(b.options.DataDir, "lake-web.sqlite")}
	before := map[string][32]byte{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = sha256.Sum256(data)
	}
	recovery, err := New(context.Background(), Options{Home: home, Port: 4177, Token: "synthetic-test-auth-token", Output: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(recovery.Close)
	if recovery.Engine != nil || recovery.Terminals != nil || recovery.Extensions != nil || !recovery.Store.readOnly {
		t.Fatal("executable services created during recovery")
	}
	server := httptest.NewServer(recovery)
	defer server.Close()
	boot := apiTest(t, server, "GET", "/api/bootstrap", nil, 200)
	if boot["recoveryReadOnly"] != true {
		t.Fatal("recovery status missing")
	}
	catalog := apiTest(t, server, "GET", "/api/catalog", nil, 200)
	if len(objects(catalog["projects"])) != 1 || len(objects(catalog["sessions"])) != 1 {
		t.Fatal("saved project missing")
	}
	snapshot := apiTest(t, server, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
	view := object(snapshot["ai"])
	if objects(snapshot["messages"])[0]["text"] != "saved history" || objects(view["cards"])[0]["content"] != "original conclusion" || view["status"] != "running" {
		t.Fatal("saved history changed")
	}
	if got := objects(object(snapshot["sre"])["tasks"]); len(got) != 1 || got[0]["id"] != task.ID {
		t.Fatal("saved SRE task missing")
	}
	if got := objects(view["operationOutcomes"]); len(got) != 1 || got[0]["status"] != "unknown" || got[0]["handle"] != "old-handle" {
		t.Fatal("unknown outcome changed")
	}
	for _, request := range []struct{ method, path string }{
		{"POST", "/api/projects"},
		{"DELETE", "/api/sessions/" + id},
		{"POST", "/api/sessions/" + id + "/messages"},
		{"POST", "/api/sessions/" + id + "/terminals"},
		{"POST", "/api/actions/old/decision"},
		{"POST", "/api/settings/model/test"},
		{"GET", "/api/settings/model/capacity"},
		{"GET", "/api/sessions/" + id + "/terminals/old/stream"},
		{"POST", "/api/sessions/" + id + "/ai/resolveOperation"},
		{"GET", "/api/new-unreviewed-route"},
	} {
		apiTest(t, server, request.method, request.path, Object{}, 409)
	}
	expectPanic(t, 409, func() { recovery.Store.CreateProject("must not be created") })
	if _, err = recovery.Store.db.Exec("UPDATE projects SET name='changed'"); err == nil {
		t.Fatal("raw SQL write allowed")
	}
	r, _ := http.NewRequest("GET", server.URL+"/api/catalog", nil)
	r.Host = "localhost:4177"
	response, err := server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("recovery bypassed authentication")
	}
	// A changed manifest cannot promote an already read-only process.
	originalControl, err := os.ReadFile(controlPath)
	if err != nil {
		t.Fatal(err)
	}
	c.Gate = "open"
	data, _ = json.Marshal(c)
	if err = os.WriteFile(controlPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	apiTest(t, server, "GET", "/api/catalog", nil, 409)
	if _, err = recovery.bridge(context.Background(), id, "runtimeCommandExec", Object{}, true); err == nil {
		t.Fatal("read-only process dispatched a tool after manifest change")
	}
	if err = os.WriteFile(controlPath, originalControl, 0600); err != nil {
		t.Fatal(err)
	}
	// Exercise actual Start as well: this used to launch memory/model workers.
	recovery.options.Port = 0
	done := make(chan error, 1)
	go func() { done <- recovery.Start() }()
	runtimePath := filepath.Join(b.options.DataDir, "runtime.json")
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err = os.Stat(runtimePath); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal("recovery listener did not start", err)
	}
	recovery.Close()
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil || before[path] != sha256.Sum256(data) {
			t.Fatal("recovery changed durable data", path, err)
		}
	}
}
