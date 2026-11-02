package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func migrationRouteFixture(b *Server) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				if f, ok := p.(*Failure); ok {
					reply(w, f.Status, Object{"error": f.Message})
					return
				}
				panic(p)
			}
		}()
		if !b.securityMigrationRoute(w, r) {
			http.NotFound(w, r)
		}
	})
}

func TestSecurityMigrationManagementRoutesRequireAuthAndDoNotEnableModes(t *testing.T) {
	b, _ := fixture(t)
	h := httptest.NewServer(migrationRouteFixture(b))
	defer h.Close()
	status := apiTest(t, h, http.MethodGet, "/api/security/status", nil, http.StatusOK)
	if status["gate"] != "open" || status["storeReady"] != true {
		t.Fatal("incorrect management status")
	}
	pending := apiTest(t, h, http.MethodGet, "/api/security/recovery/status", nil, http.StatusOK)
	if pending["pending"] != false {
		t.Fatal("new Home unexpectedly recovering")
	}
	apiTest(t, h, http.MethodPost, "/api/security/enforce", Object{"enabled": true}, http.StatusConflict)
	r := httptest.NewRequest(http.MethodGet, "/api/security/status", nil)
	r.Host = "localhost:4177"
	w := httptest.NewRecorder()
	migrationRouteFixture(b).ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatal("unauthenticated management state exposed", w.Code)
	}
}

func TestSecurityMigrationRoutesExposeRecoveryWithoutRuntimeOrWrites(t *testing.T) {
	b, _ := fixture(t)
	home := b.options.Home
	b.Close()
	checkpoint := filepath.Join(t.TempDir(), "checkpoint")
	if _, err := ai.CreateSecurityCheckpoint(context.Background(), home, checkpoint); err != nil {
		t.Fatal(err)
	}
	result, err := ai.RestoreSecurityBackup(context.Background(), home, checkpoint, false)
	if err != nil {
		t.Fatal(err)
	}
	recovery, err := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.Close()
	h := httptest.NewServer(migrationRouteFixture(recovery))
	defer h.Close()
	status := apiTest(t, h, http.MethodGet, "/api/security/recovery/status", nil, http.StatusOK)
	if status["pending"] != true || object(status["recovery"])["recoveryID"] != result.RecoveryID {
		t.Fatal("recovery management identity unavailable")
	}
	index := apiTest(t, h, http.MethodGet, "/api/security/recovery/ledger-index", nil, http.StatusOK)
	if index["resourceMapping"] != "unverified" {
		t.Fatal("unverified resource mapping promoted")
	}
	review := apiTest(t, h, http.MethodGet, "/api/security/recovery/review", nil, http.StatusOK)
	if review["readyForActivation"] != (review["reviewComplete"] == true && ai.SecurityEnforcementStatus().Ready) {
		t.Fatal("recovery readiness did not match complete review and compiled coverage")
	}
	apiTest(t, h, http.MethodPost, "/api/security/recovery/impact-map", Object{"action": Object{"actorId": "model"}, "impactId": "invented", "recordDigest": "invented", "resourceIds": []string{}}, http.StatusBadRequest)
	apiTest(t, h, http.MethodPost, "/api/security/recovery/confirm", Object{"ignoreUnknown": true}, http.StatusConflict)
	apiTest(t, h, http.MethodGet, "/api/security/recovery/reconcile-preview?impactId=invented&resourceId=asset&operationId=old", nil, http.StatusConflict)
	apiTest(t, h, http.MethodPost, "/api/security/recovery/reconcile", Object{"ignoreUnknown": true}, http.StatusConflict)
	control, err := ai.ReadSecurityControl(home)
	if err != nil || control.Gate != "closed" {
		t.Fatal("management reads changed gate", err)
	}
	if recovery.Engine != nil || recovery.Terminals != nil || recovery.Extensions != nil {
		t.Fatal("management route constructed executable clients")
	}
}
