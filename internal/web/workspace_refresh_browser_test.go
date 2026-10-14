package web

import (
	"context"
	"encoding/json"
	webassets "github.com/Clean-Lakes/Lake/assets/web"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// Optional isolated UI diagnostic. Toggle failure with the fixture-owned
// /tmp/lake-workspace-refresh.fail file; no external model or SSH requests.
func TestWorkspaceRefreshBrowserFixture(t *testing.T) {
	if os.Getenv("LAKE_WORKSPACE_REFRESH_BROWSER") != "1" {
		t.Skip("manual browser fixture")
	}
	b, initial := fixture(t)
	id, ref := newSession(t, initial)
	b.options.Static = webassets.Files()
	b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	var catalogs, snapshots atomic.Int32
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__fixture__/metrics" {
			_ = json.NewEncoder(w).Encode(Object{"catalogs": catalogs.Load(), "snapshots": snapshots.Load()})
			return
		}
		if r.URL.Path == "/api/catalog" {
			catalogs.Add(1)
			// Make pending state observable and check repeated clicks are disabled.
			time.Sleep(800 * time.Millisecond)
			if _, err := os.Stat("/tmp/lake-workspace-refresh.fail"); err == nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":"隔离测试：刷新服务暂不可用"}`))
				return
			}
		}
		if r.URL.Path == "/api/sessions/"+id+"/snapshot" {
			snapshots.Add(1)
		}
		b.ServeHTTP(w, r)
	}))
	t.Cleanup(func() { b.Close(); h.Close() })
	u, _ := url.Parse(h.URL)
	b.options.Port, _ = strconv.Atoi(u.Port())
	t.Logf("REFRESH_BROWSER_URL=%s/?session=%s#token=synthetic-test-auth-token", h.URL, id)
	deadline := time.NewTimer(6 * time.Minute)
	defer deadline.Stop()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("browser fixture timed out")
		case <-tick.C:
			if _, err := os.Stat("/tmp/lake-workspace-refresh.done"); err == nil {
				return
			}
		}
	}
}
