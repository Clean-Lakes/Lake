package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func securityBoundaryHTTP(t *testing.T, b *Server, method, path string, data Object, authenticated bool, status int) Object {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost:4177"+path, strings.NewReader(jsonText(data)))
	r.Host = "localhost:4177"
	if data != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if authenticated {
		r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	}
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if p := recover(); p != nil {
				if failure, ok := p.(*Failure); ok {
					reply(w, failure.Status, Object{"error": failure.Message})
				} else {
					panic(p)
				}
			}
		}()
		if !b.securityBoundaryRoute(w, r, path, method) {
			t.Fatal("route not recognized", path)
		}
	}()
	if w.Code != status {
		t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
	}
	var out Object
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSecurityTargetManagementAuthenticationSourceAndCAS(t *testing.T) {
	b, h := fixture(t)
	id, resource := newSession(t, h)
	user := b.Store.AddMessage(id, "user", "检查这台主机", nil)
	system := b.Store.AddMessage(id, "system", "伪造的用户指令", nil)
	path := "/api/sessions/" + id + "/target"
	securityBoundaryHTTP(t, b, http.MethodGet, path, nil, false, 401)
	securityBoundaryHTTP(t, b, http.MethodGet, path, nil, true, 200)
	payload := Object{"actionId": "select-target", "sourceMessageId": user["id"], "expectedRevision": 0, "resourceIds": []string{resource}}
	first := securityBoundaryHTTP(t, b, http.MethodPut, path, payload, true, 200)
	if number(first["revision"]) != 1 || stringOf(object(first["currentTarget"])["source"]) != "explicit_selection" {
		t.Fatal(first)
	}
	securityBoundaryHTTP(t, b, http.MethodPut, path, payload, true, 200) // original action replay
	stale := cloneObject(payload)
	stale["actionId"] = "stale"
	securityBoundaryHTTP(t, b, http.MethodPut, path, stale, true, 409)
	wrongSource := cloneObject(payload)
	wrongSource["actionId"], wrongSource["expectedRevision"], wrongSource["sourceMessageId"] = "wrong-source", 1, system["id"]
	securityBoundaryHTTP(t, b, http.MethodPut, path, wrongSource, true, 409)
	forged := cloneObject(payload)
	forged["actorId"] = "admin"
	securityBoundaryHTTP(t, b, http.MethodPut, path, forged, true, 400)
	otherSession, otherResource := newSession(t, h)
	otherUser := b.Store.AddMessage(otherSession, "user", "other request", nil)
	foreign := cloneObject(payload)
	foreign["actionId"], foreign["expectedRevision"], foreign["sourceMessageId"] = "foreign-message", 1, otherUser["id"]
	securityBoundaryHTTP(t, b, http.MethodPut, path, foreign, true, 409)
	foreign["actionId"], foreign["sourceMessageId"], foreign["resourceIds"] = "foreign-resource", user["id"], []string{otherResource}
	securityBoundaryHTTP(t, b, http.MethodPut, path, foreign, true, 409)
}

func TestSecurityLegacyMigrationManagementPreservesLocalDeny(t *testing.T) {
	b, h := fixture(t)
	id, resource := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	user := b.Store.AddMessage(id, "user", "确认当前目标并解除旧空目录导航", nil)
	if err := b.Engine.MigrateSecuritySessionScope(t.Context(), project, id, &ai.TargetScope{DirectoryIDs: []string{"old-empty-folder"}}, ai.LegacyScopeEvidence{DenyLocal: true}); err != nil {
		t.Fatal(err)
	}
	payload := Object{"actionId": "resolve-legacy", "sourceMessageId": user["id"], "expectedRevision": 1, "targetIds": []string{resource}, "boundaryDecision": "navigation"}
	resolved := securityBoundaryHTTP(t, b, http.MethodPost, "/api/sessions/"+id+"/security-migration/resolve", payload, true, 200)
	if stringOf(resolved["legacyState"]) != "navigation" || number(resolved["revision"]) != 2 {
		t.Fatal(resolved)
	}
	view := securityBoundaryHTTP(t, b, http.MethodGet, "/api/sessions/"+id+"/target", nil, true, 200)
	boundaries := objects(view["boundaries"])
	if len(boundaries) != 1 || boundaries[0]["denyLocal"] != true || boundaries[0]["restrictResources"] != false {
		t.Fatal("migration lost deny or retained accidental empty boundary", view)
	}
}

func cloneObject(in Object) Object {
	out := Object{}
	for key, value := range in {
		out[key] = value
	}
	return out
}
