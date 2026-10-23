package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func memoryV2ServerFixture(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	b, err := New(context.Background(), Options{Home: t.TempDir(), Token: "synthetic-test-auth-token", memoryV2ForTest: true, Static: fstest.MapFS{"index.html": {Data: []byte("memory fixture")}}})
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(b)
	t.Cleanup(func() { h.Close(); b.Close() })
	return b, h
}

func TestMemoryV2APIRequiresScopeAndPreventsTrustedFieldWrites(t *testing.T) {
	_, h := memoryV2ServerFixture(t)
	p := stringOf(apiTest(t, h, "POST", "/api/projects", Object{"name": "V2 routes"}, 201)["id"])
	path := "/api/projects/" + p + "/memory/new-rule"
	base := Object{"type": "project", "description": "发布前备份", "body": "核对备份后再继续。", "expectedRevision": 0}
	apiTest(t, h, "PUT", path, base, 422) // Unknown/missing classification cannot default global.
	base["knowledgeKind"], base["scopeKind"], base["resourceIds"], base["factKey"] = "procedure", "project", []string{}, "release.backup"
	base["observedAt"] = "2026-10-23T00:00:00Z"
	apiTest(t, h, "PUT", path, base, 400)
	delete(base, "observedAt")
	apiTest(t, h, "PUT", path, base, 200)
	entry := apiTest(t, h, "GET", path, nil, 200)
	if entry["verification"] != "user-stated" || entry["observedAt"] != "" {
		t.Fatal("manual save fabricated observation")
	}
	apiTest(t, h, "GET", "/api/projects/"+p+"/memory?limit=51", nil, 400)
	apiTest(t, h, "DELETE", path, Object{"expectedRevision": 1}, 200)
	apiTest(t, h, "DELETE", path, Object{"expectedRevision": 1}, 200)
	forgotten := apiTest(t, h, "GET", path+"?includeDeleted=true", nil, 200)
	if forgotten["body"] != nil || forgotten["sources"] != nil {
		t.Fatal("forgotten metadata exposes content")
	}
}

func TestMemoryV2IncrementalExtractionAndSourceNavigation(t *testing.T) {
	b, h := memoryV2ServerFixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var mu sync.Mutex
	mainRequests := []string{}
	extractions := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request["tools"] == nil {
			mu.Lock()
			extractions++
			mu.Unlock()
			if len(jsonText(request["messages"])) > 24*1024 {
				t.Error("unbounded extraction request")
			}
			emitModel(w, `{"schemaVersion":2,"mutations":[{"operation":"upsert","key":"release-backup","type":"project","description":"发布前核对备份","body":"发布前先核对可恢复的备份，再继续。","sourceIds":["user:0"],"expectedRevision":0,"knowledgeKind":"procedure","scopeKind":"project","resourceIds":[],"subject":{},"factKey":"release.backup"}]}`, nil)
			return
		}
		mu.Lock()
		mainRequests = append(mainRequests, jsonText(request["messages"]))
		mu.Unlock()
		emitModel(w, "收到发布流程要求。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "memory-v2-model", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "请记住：本项目发布前核对备份。"}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	b.messageMu.Lock()
	b.memoryLastForeground = time.Now().Add(-3 * time.Second)
	b.messageMu.Unlock()
	b.processOneMemoryJob()
	full := b.Store.ReadProjectMemory(project, "release-backup", false)
	if full["reviewState"] != "active" || full["scopeKind"] != "project" {
		t.Fatal("explicit method did not become active")
	}
	sources := objects(full["sources"])
	if len(sources) != 1 || stringOf(sources[0]["messageId"]) == "" {
		t.Fatal("source message identity missing")
	}
	link := apiTest(t, h, "GET", "/api/projects/"+project+"/memory/release-backup/sources/"+stringOf(sources[0]["sourceId"]), nil, 200)
	if link["available"] != true || link["messageId"] != sources[0]["messageId"] {
		t.Fatal("source cannot be navigated")
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "请说明备份的发布要求。"}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	mu.Lock()
	defer mu.Unlock()
	if extractions != 1 || len(mainRequests) != 2 || !strings.Contains(mainRequests[1], "release-backup") {
		t.Fatal("incremental index did not reach next turn")
	}
	view, _ := b.Engine.Snapshot(session)
	if len(view.MemoryAccess) != 1 || view.MemoryAccess[0].Kind != "index" {
		t.Fatal("index access footprint missing")
	}
}

func TestMemoryV2ActualForegroundMessagePreemptsBlockedProvider(t *testing.T) {
	b, h := memoryV2ServerFixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	started, release := make(chan struct{}), make(chan struct{})
	var startOnce sync.Once
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request["tools"] != nil {
			emitModel(w, "前台请求已继续。", nil)
			return
		}
		startOnce.Do(func() { close(started) })
		select {
		case <-r.Context().Done():
			return
		case <-release:
			emitModel(w, `{"schemaVersion":2,"mutations":[]}`, nil)
		}
	}))
	defer provider.Close()
	defer close(release)
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "preemption-fixture", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	snapshot := testMemorySnapshot(project, session, "background-source", 0, 0)
	snapshot.SchemaVersion = 2
	snapshot.ModelRef = ai.ModelIdentity(*b.Models.Active())
	snapshot = ai.SealMemorySnapshot(snapshot)
	if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { b.processOneMemoryJob(); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("background request did not start")
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "请继续处理当前的前台问题。"}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled extraction still blocked foreground")
	}
	if integer(b.Store.ListProjectMemories(project, "", 0, 50, true, false)["total"]) != 0 {
		t.Fatal("cancelled provider committed memory")
	}
	job := b.Store.read(func() any {
		return b.Store.row("SELECT status,attempts FROM projectMemoryJobs WHERE lastErrorCode='foreground_preempted'")
	}).(Object)
	if job["status"] != "queued" || integer(job["attempts"]) != 0 {
		t.Fatal("preemption consumed failure budget")
	}
}
