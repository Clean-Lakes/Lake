package ai

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRuntimeTargetValidationNeverRunsCommand(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	c.Assets = []Asset{{ID: "remote", Name: "fixture", Kind: "ssh"}}
	marker := filepath.Join(c.Workspace, "MUST_NOT_EXIST")
	_, err := e.execRuntime(context.Background(), c, map[string]any{"runtime": "local", "asset_ref": "remote"}, []string{"/bin/sh", "-c", "touch " + quote(marker)}, "")
	var rejected *ToolNotExecutedError
	if !errors.As(err, &rejected) || err.Error() != "cannot run a remote asset locally" {
		t.Fatal("runtime precondition became an unknown effect", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("rejected runtime executed a command")
	}
}

func TestLegacyShellTargetRejectionIsNarrowAuditedAndUnblocksWrites(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	p := DefaultPermissions()
	p.SilentWriteFiles = true
	c.Permissions = &p
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	base := nativeOperation{SessionID: "case", RootTurnID: "turn", Identity: js(RunIdentity{SessionID: "case", RootTurnID: "turn"}), Tool: "shell", Risk: "write", Status: "unknown", Result: "Shell runtime and asset do not match", StartedAt: time.Now()}
	var rows []nativeOperation
	for _, id := range []string{"rejected", "transport", "other-tool", "live-handle", "dispatched", "foreign-session", "foreign-identity", "missing-turn", "sre"} {
		row := base
		row.ID = id
		switch id {
		case "transport":
			row.Result = "runtime interrupted; outcome unknown"
		case "other-tool":
			row.Tool = "write"
		case "live-handle":
			row.Handle = "terminal:entry"
		case "dispatched":
			row.Status = "dispatched"
		case "foreign-session":
			row.SessionID = "other"
		case "foreign-identity":
			row.Identity = js(RunIdentity{SessionID: "other", RootTurnID: "turn"})
		case "missing-turn":
			row.Identity = "{}"
		case "sre":
			row.Identity = js(RunIdentity{SessionID: "case", RootTurnID: "turn", TaskID: "task"})
		}
		rows = append(rows, row)
	}
	if err = store.DB.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = e.reconcilePreflightOutcomes(context.Background(), "case"); err != nil {
			t.Fatal(err)
		}
	}
	for _, expected := range rows {
		var actual nativeOperation
		if err = store.DB.First(&actual, "id = ?", expected.ID).Error; err != nil {
			t.Fatal(err)
		}
		want := expected.Status
		if expected.ID == "rejected" {
			want = "not_executed"
		}
		if actual.Status != want || actual.Result != expected.Result {
			t.Fatal("repair changed unproven outcome or original evidence", expected.ID, actual.Status)
		}
	}
	var count int64
	if err = store.DB.Model(&nativeEvidence{}).Where("operation_id = ? AND status = ?", "rejected", "preflight_reconciled_not_executed").Count(&count).Error; err != nil || count != 1 {
		t.Fatal("missing or duplicated audit", count, err)
	}
	// A genuine unknown still blocks dispatch, regardless of granted permissions.
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, true)
	call := Call{ID: "new-write", Name: "write", Arguments: js(map[string]any{"path": filepath.Join(c.Workspace, "PLAN.md"), "content": "new explicit operation"})}
	if _, err = e.invoke(ctx, s, c, call); err == nil {
		t.Fatal("genuine unknown outcome did not block write")
	}
	// Isolate the proven-rejection case without changing the other fixture facts.
	if err = store.DB.Where("id <> ?", "rejected").Delete(&nativeOperation{}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.invoke(ctx, s, c, call); err != nil {
		t.Fatal("rejected preflight still blocked explicitly permitted write", err)
	}
	content, err := os.ReadFile(filepath.Join(c.Workspace, "PLAN.md"))
	if err != nil || string(content) != "new explicit operation" {
		t.Fatal("new explicit operation failed", err)
	}
}
