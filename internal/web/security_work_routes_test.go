package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func securityWorkHTTP(t *testing.T, b *Server, path string, payload Object, auth bool, status int) {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "http://localhost:4177"+path, strings.NewReader(jsonText(payload)))
	r.Host = "localhost:4177"
	r.Header.Set("Content-Type", "application/json")
	if auth {
		r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	}
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				if f, ok := recovered.(*Failure); ok {
					reply(w, f.Status, Object{"error": f.Message})
				} else {
					panic(recovered)
				}
			}
		}()
		if !b.securityWorkRoute(w, r) {
			t.Fatal("route not recognized")
		}
	}()
	if w.Code != status {
		t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
	}
	var out Object
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
}

func TestHumanWorkVerificationRequiresAuthenticationAndOriginalUserMessage(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	user := b.Store.AddMessage(id, "user", "我人工核验结果", nil)
	machine := b.Store.AddMessage(id, "system", "自动报告成功", nil)
	other, _ := newSession(t, h)
	foreign := b.Store.AddMessage(other, "user", "other", nil)
	path := "/api/sessions/" + id + "/security-work/goal/verify-human"
	payload := Object{"actionId": "verify", "sourceMessageId": machine["id"], "expectedRevision": 1, "stepId": "step", "criteriaIds": []string{"result"}, "note": "checked"}
	securityWorkHTTP(t, b, path, payload, false, 401)
	securityWorkHTTP(t, b, path, payload, true, 409)
	payload["sourceMessageId"] = foreign["id"]
	securityWorkHTTP(t, b, path, payload, true, 409)
	payload["sourceMessageId"] = user["id"]
	payload["actorId"] = "admin"
	securityWorkHTTP(t, b, path, payload, true, 400)
}
