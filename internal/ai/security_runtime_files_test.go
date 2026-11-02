package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityTaskFileAuthorityCannotReadLakeControlOrAuthentication(t *testing.T) {
	e := managedEngineFixture(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"})
	home := e.securityHome().Home
	paths := []string{filepath.Join(home, "web-agent", "runtime.json"), filepath.Join(home, "security", "control.json"), filepath.Join(e.runtimeDirectory(), "sessions.sqlite")}
	if err := os.MkdirAll(filepath.Dir(paths[0]), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths[0], []byte(`{"token":"synthetic-private-host-token"}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		op := security.PreparedOperation{Tool: "read", Proof: security.ProofOpaque, Resources: []security.ResourceRevision{{ID: "local", Local: true}}}
		if _, err := e.prepareSecurityLocalFile(Config{Runtime: "local"}, &op, map[string]any{"path": path}); err == nil {
			t.Fatal("task file authority exposed Lake control/credentials")
		}
	}
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "ordinary.txt")
	if err = os.WriteFile(path, []byte("ordinary target data"), 0600); err != nil {
		t.Fatal(err)
	}
	op := security.PreparedOperation{Tool: "read", Proof: security.ProofOpaque, Resources: []security.ResourceRevision{{ID: "local", Local: true}}}
	if supported, err := e.prepareSecurityLocalFile(Config{Runtime: "local"}, &op, map[string]any{"path": path}); err != nil || !supported {
		t.Fatal("ordinary target read was lost", err)
	}
}

func TestSecurityHostAuthenticationIsRedactedWithoutSerialization(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	secret := "synthetic-private-host-token"
	e.SetSecurityHostSecrets([]string{secret})
	if err := e.Configure("case", Config{Model: Model{Name: "fixture", URL: "http://127.0.0.1:1"}, Runtime: "local"}); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	if strings.Contains(redact("copied outside credential file: "+secret, c), secret) {
		t.Fatal("host token reached normal output")
	}
	if strings.Contains(js(c), secret) || strings.Contains(js(c), "runtimeProtectedPaths") {
		t.Fatal("private host protection entered serializable configuration")
	}
}
