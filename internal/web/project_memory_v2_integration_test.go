package web

import (
	"context"
	"net/http/httptest"
	"testing"
	"testing/fstest"
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
