package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMemoryV2RetiredManagementRoutesKeepAuthenticationAndProjectBoundary(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		name := "current-v1"
		if legacy {
			name = "historical-v2"
		}
		t.Run(name, func(t *testing.T) {
			var b *Server
			var h *httptest.Server
			if legacy {
				b, h = memoryV2ServerFixture(t)
			} else {
				b, h = fixture(t)
			}
			project := stringOf(b.Store.CreateProject("Retired management")["id"])
			suffixes := []string{"/memory-classification", "/memory-candidates", "/memory-candidates/old/decision", "/memory/old/sources/source"}
			for _, suffix := range suffixes {
				for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
					result := apiTest(t, h, method, "/api/projects/"+project+suffix, "not an object", 410)
					if result["code"] != retiredMemoryV2Code {
						t.Fatal("wrong retirement response", method, suffix)
					}
				}
				apiTest(t, h, "GET", "/api/projects/missing-project"+suffix, nil, 404)
				req, err := http.NewRequest("GET", h.URL+"/api/projects/"+project+suffix, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Host = "localhost:4177"
				response, err := h.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				if response.StatusCode != 401 {
					t.Fatal("retired endpoint bypassed authentication", response.StatusCode)
				}
			}
			if !legacy {
				apiTest(t, h, "PUT", "/api/projects/"+project+"/memory/current-rule", Object{"type": "project", "description": "当前规则", "body": "发布前核对备份。", "expectedRevision": 0}, 200)
			}
		})
	}
}

func TestMemoryV2RetiredWritesPreserveHistoryAndStillAllowForgetting(t *testing.T) {
	b, h := memoryV2ServerFixture(t)
	project := stringOf(b.Store.CreateProject("Historical privacy")["id"])
	m := memoryV2Mutation("historical-rule")
	b.Store.CommitMemoryV2(project, m)
	b.Store.update(func() any {
		b.Store.insertMemoryCandidate(project, "historical-job", m.Key, 1, Object{"body": "historical candidate"}, "conflict")
		return nil
	})
	audit := func() string {
		return b.Store.read(func() any {
			return jsonText(Object{"entries": b.Store.rows("SELECT * FROM projectMemoryEntriesV2"), "revisions": b.Store.rows("SELECT * FROM projectMemoryRevisionsV2"), "sources": b.Store.rows("SELECT * FROM projectMemorySourcesV2"), "candidates": b.Store.rows("SELECT * FROM projectMemoryCandidatesV2")})
		}).(string)
	}
	before := audit()
	base := "/api/projects/" + project
	apiTest(t, h, "PUT", base+"/memory/"+m.Key, Object{"body": "must not overwrite", "expectedRevision": 1}, 410)
	apiTest(t, h, "POST", base+"/memory-classification", Object{}, 410)
	apiTest(t, h, "POST", base+"/memory-candidates/old/decision", Object{"action": "accept"}, 410)
	if audit() != before {
		t.Fatal("retired management changed historical content")
	}
	// No model-facing save path can restore the retired management workflow.
	session := stringOf(b.Store.CreateSession(project, "Historical tool", nil)["id"])
	if err := b.Engine.Configure(session, ai.Config{Model: ai.Model{URL: "http://127.0.0.1:1", Name: "unused", Protocol: "openai"}, MemoryProjectID: project, MemorySchemaVersion: 2, MemoryEnabled: true, Profile: "core", Runtime: "local"}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.projectMemoryBridge(context.Background(), session, "save_project_memory", Object{"key": m.Key}); err == nil || !strings.Contains(err.Error(), retiredMemoryV2Code) {
		t.Fatal("retired model save was not rejected", err)
	}
	// Privacy erasure remains available without reopening editing or adoption.
	apiTest(t, h, "DELETE", base+"/memory/"+m.Key, Object{"expectedRevision": 1}, 200)
	forgotten := apiTest(t, h, "GET", base+"/memory/"+m.Key+"?includeDeleted=true", nil, 200)
	if forgotten["body"] != nil || forgotten["sources"] != nil {
		t.Fatal("historical forget exposed retained content")
	}
	for _, table := range []string{"projectMemorySourcesV2", "projectMemoryRevisionsV2", "projectMemoryCandidatesV2"} {
		count := b.Store.read(func() any { return integer(b.Store.row("SELECT count(*) n FROM " + table)["n"]) }).(int)
		if count != 0 {
			t.Fatal("historical forget retained derived content", table)
		}
	}
}
