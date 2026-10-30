package web

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSecurityWebStdioShareExclusiveHome(t *testing.T) {
	home := t.TempDir()
	home, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(context.Background(), Options{Home: home, Token: "test", DynamicPort: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	if server.Engine.RuntimeDir != filepath.Join(home, "web-agent", "adk") {
		t.Fatal("web uses wrong runtime")
	}
	if _, err = ai.OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("stdio second owner allowed")
	}
	server.Close()
	h, err := ai.OpenSecurityHome(context.Background(), home, "")
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if h.RuntimeRoot != filepath.Join(home, "web-agent", "adk") {
		t.Fatal("stdio runtime differs")
	}
}

func TestSecurityClosedGateRejectsBridgeBeforeIO(t *testing.T) {
	server, err := New(context.Background(), Options{Home: t.TempDir(), Token: "test", DynamicPort: true})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	if err = server.Engine.SecurityRuntime.RotateRecoveryEpoch(); err != nil {
		t.Fatal(err)
	}
	// Deliberately invalid session/arguments: the gate must reject before even
	// looking up resources, starting an extension, or submitting a command.
	for _, name := range []string{"runtimeCommandExec", "call_mcp_tool", "preview_resource_import"} {
		if _, err = server.bridge(context.Background(), "does-not-exist", name, Object{}, true); err == nil {
			t.Fatal("closed gate dispatched", name)
		}
	}
}
