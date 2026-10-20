package extensions

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type gatedMCPFixture struct {
	server      *httptest.Server
	started     chan struct{}
	release     func()
	initializes atomic.Int32
}

func gatedMCP(t *testing.T, blockedMethod string) *gatedMCPFixture {
	t.Helper()
	f := &gatedMCPFixture{started: make(chan struct{})}
	gate := make(chan struct{})
	var started, released sync.Once
	f.release = func() { released.Do(func() { close(gate) }) }
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return testServer() }, nil)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var request struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(raw, &request)
		if request.Method == "initialize" {
			f.initializes.Add(1)
		}
		if request.Method == blockedMethod {
			started.Do(func() { close(f.started) })
			select {
			case <-gate:
			case <-r.Context().Done():
				return
			}
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(func() { f.release(); f.server.Close() })
	return f
}

func discoverAsync(m *Manager, ctx context.Context, id string) <-chan error {
	done := make(chan error, 1)
	go func() { _, err := m.Tools(ctx, id, false); done <- err }()
	return done
}

func awaitDiscovery(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("MCP discovery blocked behind another connection")
		return nil
	}
}

func saveMCPFixture(t *testing.T, store *Store, id string, f *gatedMCPFixture) {
	t.Helper()
	if err := store.SaveServer(Server{ID: id, Name: id, Transport: "http", URL: f.server.URL, Enabled: true, TimeoutMS: 10000}, true, true); err != nil {
		t.Fatal(err)
	}
}

func TestMCPSlowConnectionDoesNotBlockAnotherServer(t *testing.T) {
	store := NewStore(t.TempDir())
	slow, fast := gatedMCP(t, "initialize"), gatedMCP(t, "initialize")
	fast.release()
	saveMCPFixture(t, store, "slow", slow)
	saveMCPFixture(t, store, "fast", fast)
	manager := NewManager(store)
	defer manager.Close()
	defer slow.release()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pending := discoverAsync(manager, ctx, "slow")
	select {
	case <-slow.started:
	case <-ctx.Done():
		t.Fatal("slow fixture did not start")
	}
	if err := awaitDiscovery(t, discoverAsync(manager, ctx, "fast")); err != nil {
		t.Fatal(err)
	}
	slow.release()
	if err := awaitDiscovery(t, pending); err != nil {
		t.Fatal(err)
	}
}

func TestMCPInvalidateAndCloseCancelPendingConnections(t *testing.T) {
	for _, action := range []string{"invalidate", "close"} {
		t.Run(action, func(t *testing.T) {
			store := NewStore(t.TempDir())
			slow, replacement := gatedMCP(t, "initialize"), gatedMCP(t, "initialize")
			replacement.release()
			saveMCPFixture(t, store, "target", slow)
			manager := NewManager(store)
			defer manager.Close()
			defer slow.release()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			pending := discoverAsync(manager, ctx, "target")
			select {
			case <-slow.started:
			case <-ctx.Done():
				t.Fatal("slow fixture did not start")
			}
			if action == "invalidate" {
				saveMCPFixture(t, store, "target", replacement)
			}
			stopped := make(chan error, 1)
			go func() {
				if action == "invalidate" {
					manager.Invalidate("target")
				} else {
					manager.Close()
				}
				stopped <- nil
			}()
			if err := awaitDiscovery(t, stopped); err != nil {
				t.Fatal(err)
			}
			if err := awaitDiscovery(t, pending); err == nil {
				t.Fatal("cancelled connection was accepted")
			}
			if action == "invalidate" {
				if err := awaitDiscovery(t, discoverAsync(manager, ctx, "target")); err != nil {
					t.Fatal(err)
				}
				if replacement.initializes.Load() != 1 {
					t.Fatal("new configuration was not connected")
				}
			} else if _, err := manager.Tools(ctx, "target", false); err == nil {
				t.Fatal("closed manager accepted a connection")
			}
		})
	}
}

func TestMCPConcurrentDiscoverySharesOneConnection(t *testing.T) {
	store := NewStore(t.TempDir())
	f := gatedMCP(t, "initialize")
	saveMCPFixture(t, store, "target", f)
	manager := NewManager(store)
	defer manager.Close()
	defer f.release()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	const callers = 8
	results := make([]<-chan error, callers)
	for i := range results {
		results[i] = discoverAsync(manager, ctx, "target")
	}
	select {
	case <-f.started:
	case <-ctx.Done():
		t.Fatal("fixture did not start")
	}
	f.release()
	for _, result := range results {
		if err := awaitDiscovery(t, result); err != nil {
			t.Fatal(err)
		}
	}
	if f.initializes.Load() != 1 {
		t.Fatalf("initialized %d connections, want one", f.initializes.Load())
	}
}

func TestMCPStaleDiscoveryFailureDoesNotCancelReplacement(t *testing.T) {
	store := NewStore(t.TempDir())
	old, replacement := gatedMCP(t, "tools/list"), gatedMCP(t, "initialize")
	saveMCPFixture(t, store, "target", old)
	manager := NewManager(store)
	defer manager.Close()
	defer old.release()
	defer replacement.release()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	oldCtx, stopOld := context.WithCancel(ctx)
	defer stopOld()
	previous := discoverAsync(manager, oldCtx, "target")
	select {
	case <-old.started:
	case <-ctx.Done():
		t.Fatal("old discovery did not start")
	}
	saveMCPFixture(t, store, "target", replacement)
	next := discoverAsync(manager, ctx, "target")
	select {
	case <-replacement.started:
	case err := <-next:
		t.Fatalf("replacement was cancelled by old discovery: %v", err)
	case <-ctx.Done():
		t.Fatal("replacement did not start")
	}
	stopOld()
	if err := awaitDiscovery(t, previous); err == nil {
		t.Fatal("old discovery should stop on reconfiguration")
	}
	replacement.release()
	if err := awaitDiscovery(t, next); err != nil {
		t.Fatal(err)
	}
}
