package ai

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

func TestFileSSHWarningsDoNotChangeFingerprintOrContent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH process; portable classification tests run on Windows")
	}
	bin := t.TempDir()
	ssh := filepath.Join(bin, "ssh")
	// This adapter runs only against temporary files and never opens a socket.
	script := "#!/bin/sh\nprintf '** WARNING: connection is not using a post-quantum key exchange algorithm.\\n' >&2\nfor arg do remote=$arg; done\nexec /bin/sh -c \"$remote\"\n"
	if err := os.WriteFile(ssh, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if selected, _ := exec.LookPath("ssh"); selected != ssh {
		t.Fatal("fake SSH was not selected")
	}
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	c.CredentialDir = filepath.Join(t.TempDir(), "credentials")
	if err := platform.MkdirAll(c.CredentialDir, 0700); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(c.CredentialDir, "synthetic")
	if err := os.WriteFile(key, []byte("synthetic fixture, not a private key"), 0600); err != nil {
		t.Fatal(err)
	}
	c.Runtime, c.AssetRef = "ssh", "fixture-host"
	c.Assets = []Asset{{ID: c.AssetRef, Kind: "ssh", SSH: &SSH{Host: "fixture.invalid", Port: 22, Username: "fixture", AuthMethod: "key", IdentityFile: key}}}
	path := filepath.Join(c.Workspace, "PLAN.md")
	before := "# Original plan\n\nPreserve exact content.\n"
	if err := os.WriteFile(path, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"path": path, "runtime": "ssh", "asset_ref": c.AssetRef}
	value, err := e.file(context.Background(), s, c, "read", args)
	if err != nil {
		t.Fatal(err)
	}
	page := obj(value)
	if str(page["content_hash"]) != hash(before) || str(page["content"]) != before {
		t.Fatal("SSH stderr corrupted file content or fingerprint")
	}
	args["expected_hash"], args["content"] = page["content_hash"], "# Updated plan\n"
	if _, err := e.file(context.Background(), s, c, "write", args); err != nil {
		t.Fatal("unchanged file was rejected", err)
	}
	actual, err := os.ReadFile(path)
	if err != nil || string(actual) != "# Updated plan\n" {
		t.Fatal("exact update failed", err)
	}
	result, err := e.searchFiles(context.Background(), c, "glob", map[string]any{"path": c.Workspace, "runtime": "ssh", "asset_ref": c.AssetRef, "pattern": "*.md"})
	if err != nil || strings.Contains(js(result), "WARNING") {
		t.Fatal("SSH warning became a search result", err)
	}
	if runtimeStdout(map[string]any{"stdout": "", "output": "stderr only"}) != "" {
		t.Fatal("empty stdout fell back to stderr")
	}
	if runtimeStdout(map[string]any{"output": "legacy"}) != "legacy" {
		t.Fatal("legacy output adapter lost compatibility")
	}
}

func TestFilePreflightFailureDoesNotBlockLaterWrites(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	path := filepath.Join(c.Workspace, "PLAN.md")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	row := nativeOperation{ID: "preflight", SessionID: "case", Tool: "write", Risk: "write", Status: "dispatched", StartedAt: time.Now()}
	if err := store.DB.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	_, failure := e.file(context.Background(), s, c, "write", map[string]any{"path": path, "content": "must not be written", "expected_hash": hash("stale")})
	var notExecuted *ToolNotExecutedError
	if !errors.As(failure, &notExecuted) {
		t.Fatal("precondition failure was not classified as not executed", failure)
	}
	if err := e.finishNativeOperation(&row, c, nil, failure); err != nil {
		t.Fatal(err)
	}
	if err := store.DB.First(&row, "id = ?", row.ID).Error; err != nil || row.Status != "not_executed" {
		t.Fatal("precondition poisoned operation ledger", row.Status, err)
	}
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	next, err := e.dispatchNativeOperation(ctx, s, c, Call{ID: "next", Name: "write", Arguments: "{}"}, "write", "fixture", "generation")
	if err != nil || next == nil {
		t.Fatal("later operation remained blocked", err)
	}
	if err := e.finishNativeOperation(next, c, map[string]any{}, &ToolNotExecutedError{Err: errors.New("test did not execute")}); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(path)
	if string(actual) != "original" {
		t.Fatal("failed precondition changed file")
	}
}

func TestLegacyFilePreflightRepairIsNarrowAndAudited(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	reason := "file changed since read; expected_hash mismatch"
	base := nativeOperation{SessionID: "case", Identity: "{}", Tool: "write", Risk: "write", Status: "unknown", Result: reason, StartedAt: time.Now()}
	rows := []nativeOperation{}
	for _, id := range []string{"old-preflight", "genuine", "other-tool", "live-handle", "running", "other-session", "sre"} {
		row := base
		row.ID = id
		switch id {
		case "genuine":
			row.Result = "runtime interrupted; outcome unknown"
		case "other-tool":
			row.Tool = "shell"
		case "live-handle":
			row.Handle = "terminal:entry"
		case "running":
			row.Status = "dispatched"
		case "other-session":
			row.SessionID = "other"
		case "sre":
			row.Identity = js(RunIdentity{TaskID: "task"})
		}
		rows = append(rows, row)
	}
	if err := store.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := e.OperationOutcomes("case"); err != nil {
			t.Fatal(err)
		}
	}
	for _, expected := range rows {
		var actual nativeOperation
		if err := store.DB.First(&actual, "id = ?", expected.ID).Error; err != nil {
			t.Fatal(err)
		}
		want := expected.Status
		if expected.ID == "old-preflight" {
			want = "not_executed"
		}
		if actual.Status != want {
			t.Fatal("repair changed an unproven outcome", expected.ID, actual.Status)
		}
	}
	var count int64
	if err := store.DB.Model(&nativeEvidence{}).Where("operation_id = ? AND status = ?", "old-preflight", "preflight_reconciled_not_executed").Count(&count).Error; err != nil || count != 1 {
		t.Fatal("repair audit was missing or duplicated", count, err)
	}
}

func TestInvalidCachedFileFingerprintRequiresFreshRead(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	path := filepath.Join(c.Workspace, "PLAN.md")
	a := map[string]any{"path": path, "content": "must not be written"}
	s.state.FileReads = map[string]string{fileReadKey(c, a): "**"}
	_, err := e.invoke(context.Background(), s, c, Call{ID: "bad-cache", Name: "write", Arguments: js(a)})
	var notExecuted *ToolNotExecutedError
	if !errors.As(err, &notExecuted) || !strings.Contains(err.Error(), "read the file again") {
		t.Fatal("invalid cached fingerprint did not require a fresh read", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("invalid cached fingerprint reached file mutation", err)
	}
}

func TestFileExecutionFailureRemainsUnknown(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	path := filepath.Join(c.Workspace, "missing-parent", "PLAN.md")
	_, failure := e.file(context.Background(), s, c, "write", map[string]any{"path": path, "content": "fixture"})
	var notExecuted *ToolNotExecutedError
	if failure == nil || errors.As(failure, &notExecuted) {
		t.Fatal("execution failure was incorrectly labeled not executed", failure)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	row := nativeOperation{ID: "execution-failure", SessionID: "case", Tool: "write", Risk: "write", Status: "dispatched", StartedAt: time.Now()}
	if err := store.DB.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishNativeOperation(&row, c, nil, failure); err != nil {
		t.Fatal(err)
	}
	if err := store.DB.First(&row, "id = ?", row.ID).Error; err != nil || row.Status != "unknown" {
		t.Fatal("execution failure lost its conservative outcome", row.Status, err)
	}
}
