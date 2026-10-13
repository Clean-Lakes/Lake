package web

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestRenameSessionUpdatesNavigationWithoutChangingRunningConversation(t *testing.T) {
	b, h := fixture(t)
	project := b.Store.CreateProject("rename fixture")
	session := b.Store.CreateSession(stringOf(project["id"]), "", nil)
	id := stringOf(session["id"])
	b.Store.Begin(id, "你好", nil)
	before := b.Store.Session(id)
	path := "/api/sessions/" + id
	updated := apiTest(t, h, "PATCH", path, Object{"title": "  新集群日常巡检  "}, 200)
	if updated["title"] != "新集群日常巡检" || updated["status"] != before["status"] || updated["projectId"] != before["projectId"] || updated["createdAt"] != before["createdAt"] {
		t.Fatal("rename changed conversation identity or execution state")
	}
	snap := apiTest(t, h, "GET", path+"/snapshot", nil, 200)
	if object(snap["session"])["title"] != "新集群日常巡检" || len(objects(snap["messages"])) != 1 {
		t.Fatal("snapshot or message history lost the rename")
	}
	b.Store.Status(id, "completed")
	b.Store.Begin(id, "后来检查磁盘", nil)
	if b.Store.Session(id)["title"] != "新集群日常巡检" {
		t.Fatal("automatic naming replaced explicit title")
	}
	for _, body := range []Object{{"title": " "}, {"title": true}, {"title": strings.Repeat("集", 201)}, {"title": "x", "projectId": "other"}, {"title": "x", "status": "completed"}} {
		apiTest(t, h, "PATCH", path, body, 400)
	}
	apiTest(t, h, "PATCH", "/api/sessions/missing", Object{"title": "x"}, 404)
	b.Models.Save(&ai.Model{URL: "http://localhost:9/v1/chat/completions", Name: "fixture", Protocol: "openai", Key: "synthetic-session-rename-key"})
	apiTest(t, h, "PATCH", path, Object{"title": "synthetic-session-rename-key"}, 400)
	if b.Store.Session(id)["title"] != "新集群日常巡检" {
		t.Fatal("invalid edit changed saved title")
	}
	request, _ := http.NewRequest("PATCH", h.URL+path, strings.NewReader(`{"title":"should reject"}`))
	request.Host = "localhost:4177"
	request.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Sec-Fetch-Site", "same-site")
	response, err := h.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("PATCH bypassed missing-origin browser protection")
	}
}

func TestManualSessionRenameSurvivesStoreRestart(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := s.Dir
	p := s.CreateProject("fixture")
	session := s.CreateSession(stringOf(p["id"]), "", nil)
	id := stringOf(session["id"])
	s.RenameSession(id, "保持这个会话名称")
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Begin(id, "第一条实际调查问题", nil)
	if s.Session(id)["title"] != "保持这个会话名称" {
		t.Fatal("manual name or naming lock was not persisted")
	}
}
