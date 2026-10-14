package web

import (
	"context"
	webassets "github.com/Clean-Lakes/Lake/assets/web"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"
)

// LAKE_TERMINAL_BROWSER=1 go test ./internal/web -run TestTerminalBrowserFixture -v
func TestTerminalBrowserFixture(t *testing.T) {
	if os.Getenv("LAKE_TERMINAL_BROWSER") != "1" {
		t.Skip("manual browser fixture")
	}
	b, h := fixture(t)
	id, ref := newSession(t, h)
	b.options.Static = webassets.Files()
	u, _ := url.Parse(h.URL)
	b.options.Port, _ = strconv.Atoi(u.Port())
	b.Terminals.OpenInteractive(context.Background(), id, ref, "sh")
	t.Logf("TERMINAL_BROWSER_URL=%s/?resource=%s#token=synthetic-test-auth-token", h.URL, ref)
	deadline := time.NewTimer(4 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("browser fixture timed out")
		case <-ticker.C:
			if _, err := os.Stat("/tmp/lake-terminal-browser.done"); err == nil {
				return
			}
		}
	}
}
