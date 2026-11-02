package web

import (
	"net/http"
	"os"
	"testing"
)

func TestSuperLifecycleIsAuthenticatedAndClosesNewAdmission(t *testing.T) {
	b, h := fixture(t)
	r, _ := http.NewRequest("POST", h.URL+"/api/superagent/lifecycle", nil)
	r.Host = "localhost:4177"
	response, err := h.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 || b.draining.Load() {
		t.Fatal("unauthenticated kernel stop", response.StatusCode)
	}
	info := apiTest(t, h, "GET", "/api/superagent/lifecycle", nil, 200)
	if integer(info["pid"]) != os.Getpid() || info["home"] != b.options.Home || info["dataDirectory"] != b.options.DataDir {
		t.Fatal("wrong Home owner identity")
	}
	apiTest(t, h, "POST", "/api/superagent/lifecycle", Object{"action": "drain"}, 202)
	if !b.draining.Load() || b.Context.Err() == nil {
		t.Fatal("new admission remained open")
	}
	apiTest(t, h, "POST", "/api/projects", Object{"name": "must not be created"}, 503)
}
