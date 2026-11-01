package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func recoveryLiveTransportFixture(t *testing.T, origin string) string {
	t.Helper()
	owner, err := ai.OpenSecurityHome(t.Context(), t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	home := owner.Home
	runtimePath := filepath.Join(filepath.Dir(owner.RuntimeRoot), "runtime.json")
	owner.Close()
	data, _ := json.Marshal(map[string]any{"origin": origin, "token": "synthetic-local-token", "pid": os.Getpid()})
	if err = os.WriteFile(runtimePath, data, 0600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestSecurityRecoveryLiveTransportRejectsForeignOriginAndRedirect(t *testing.T) {
	var foreign atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { foreign.Add(1); w.Write([]byte(`{}`)) }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-local-token" {
			t.Error("private host token missing")
		}
		http.Redirect(w, r, other.URL, http.StatusFound)
	}))
	defer server.Close()
	home := recoveryLiveTransportFixture(t, server.URL)
	if _, err := securityRecoveryLiveRequest(context.Background(), home, "/api/security/recovery/review", http.MethodGet, nil); err == nil || foreign.Load() != 0 {
		t.Fatal("management redirect forwarded bearer", err, foreign.Load())
	}
	for _, origin := range []string{"https://127.0.0.1:4177", "http://192.0.2.1:4177", "http://localhost:4177/path", "http://user@localhost:4177", "http://localhost:4177?target=other"} {
		home := recoveryLiveTransportFixture(t, origin)
		if _, err := securityRecoveryLiveRequest(t.Context(), home, "/api/security/recovery/review", http.MethodGet, nil); err == nil {
			t.Fatal("foreign/malformed management origin accepted", origin)
		}
	}
}

func TestSecurityRecoveryLiveCommandsRequireBoundInputs(t *testing.T) {
	for _, args := range [][]string{{"recovery-reconcile-preview"}, {"recovery-reconcile-preview", "--home", t.TempDir()}, {"recovery-reconcile", "--home", t.TempDir()}} {
		handled, err := runSecurityMaintenance(t.Context(), args)
		if !handled || err == nil {
			t.Fatal("unbound recovery command accepted", args, handled, err)
		}
	}
}
