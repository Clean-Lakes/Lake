package ai

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func terminalPermitFixture(t *testing.T) (*Engine, context.Context, *nativeOperation, *SecurityCatalogView) {
	t.Helper()
	as := Asset{ID: "resource", Kind: "local"}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "terminal.execute", Effect: security.EffectAllow})
	policy, err := e.SecurityProjectPolicy(t.Context(), "project")
	if err != nil {
		t.Fatal(err)
	}
	policy.Mode = "compatible"
	policy.Rules = append(policy.Rules, security.Rule{Capability: "local.execute", Effect: security.EffectAllow})
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "terminal-policy", ProjectID: "project", ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	view, err := e.currentSecurityCatalog(t.Context(), SecurityCatalogQuery{ProjectID: "project", SessionID: "case", All: true})
	if err != nil {
		t.Fatal(err)
	}
	view.TerminalID = "terminal"
	view.TerminalGeneration = "generation"
	view.TerminalContextRevision = 0
	view.TerminalResourceID = "resource"
	if err = e.SetSecurityCatalogResolver(func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error) { return view, nil }); err != nil {
		t.Fatal(err)
	}
	c.TerminalID = "terminal"
	call := Call{ID: "pty-call", Name: "shell", Arguments: js(map[string]any{"asset_ref": assetAlias("resource"), "command": "echo reviewed", "terminal_id": "terminal"})}
	a, _ := args(call)
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || prepared == nil || decision.Effect != security.EffectApprovalRequired {
		t.Fatal(decision, err)
	}
	db, storeID, epoch, _ := e.securityTaskDB()
	op := prepared.descriptor
	if err = db.Create(&nativeApproval{ID: "pty-approval", SessionID: op.SessionID, RootTurnID: op.RootTurnID, CallID: op.CallID, StoreID: storeID, RecoveryEpoch: epoch, SecurityTaskID: op.TaskID, DescriptorDigest: prepared.digest, ExecutionRevision: op.ExecutionRevision, Status: "authorized", Accepted: true, CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	ctx := SecurityOperationContext(t.Context(), prepared)
	s, _ := e.get("case")
	operation, err := e.dispatchNativeOperation(ctx, s, prepared.executionConfig, call, "write", "pty", prepared.digest)
	if err != nil {
		t.Fatal(err)
	}
	return e, securityPermitContext(ctx, operation.permit), operation, &view
}

func TestSecurityTerminalHandoffBindsOriginalBeforeWriteAndCannotReplay(t *testing.T) {
	e, ctx, operation, _ := terminalPermitFixture(t)
	db, _, _, _ := e.securityTaskDB()
	var saved SecurityTerminalHandoff
	writes := 0
	err := e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "command", "echo reviewed", func(h SecurityTerminalHandoff) error {
		if h.ContextRevision() != 0 || h.Generation() != "generation" || h.OperationID() != operation.ID {
			t.Fatal("frozen identity lost")
		}
		if err := h.BindEntry("entry", ""); err != nil {
			return err
		}
		var row nativeOperation
		if err := db.First(&row, "id = ?", operation.ID).Error; err != nil {
			return err
		}
		if row.Handle != "terminal:entry" {
			t.Fatal("write before original registration")
		}
		saved = h
		writes++
		return nil
	})
	if err != nil || writes != 1 {
		t.Fatal(writes, err)
	}
	if saved.BindEntry("late", "") == nil {
		t.Fatal("callback token survived handoff")
	}
	if e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "command", "echo reviewed", func(h SecurityTerminalHandoff) error { return h.BindEntry("replay", "") }) == nil {
		t.Fatal("replayed original permit")
	}
	if e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "command", "echo unreviewed", func(SecurityTerminalHandoff) error { writes++; return nil }) == nil || writes != 1 {
		t.Fatal("mutated command reached I/O")
	}
}
func TestSecurityTerminalHandoffRejectsCurrentChangesAndUnboundCallback(t *testing.T) {
	for _, change := range []string{"generation", "revision", "unbound"} {
		t.Run(change, func(t *testing.T) {
			e, ctx, _, view := terminalPermitFixture(t)
			if change == "generation" {
				view.TerminalGeneration = "replacement"
			}
			if change == "revision" {
				view.TerminalContextRevision++
			}
			calls := 0
			err := e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "command", "echo reviewed", func(SecurityTerminalHandoff) error { calls++; return nil })
			if err == nil {
				t.Fatal("accepted stale/unbound handoff")
			}
			if change != "unbound" && calls != 0 {
				t.Fatal("stale terminal reached callback")
			}
		})
	}
}
func TestSecurityTerminalInputCanonicalPayloadAndMissingPermit(t *testing.T) {
	if value, ok := securityTerminalInput("terminal_send_key", map[string]any{"key": "ctrl_c", "count": 2}); !ok || value != "\x03\x03" {
		t.Fatal(value, ok)
	}
	if value, ok := securityTerminalInput("terminal_send_input", map[string]any{"input": "reviewed", "append_enter": true}); !ok || value != "reviewed\n" {
		t.Fatal(value, ok)
	}
	e, ctx, _, _ := terminalPermitFixture(t)
	if err := e.WithSecurityTerminalHandoff(context.Background(), "project", "case", "terminal", "command", "echo reviewed", func(SecurityTerminalHandoff) error { return errors.New("must not run") }); err == nil {
		t.Fatal("missing permit")
	}
	if err := e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "input", "echo reviewed", func(SecurityTerminalHandoff) error { return nil }); err == nil {
		t.Fatal("command permit reused as raw input")
	}
}

func TestSecurityTerminalLiveHostDenyToggleStopsAlreadyPreparedPermitBeforeIO(t *testing.T) {
	e, ctx, _, view := terminalPermitFixture(t)
	view.HardLocalDeny = true
	writes := 0
	err := e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "command", "echo reviewed", func(h SecurityTerminalHandoff) error { writes++; return h.BindEntry("entry", "") })
	if err == nil || writes != 0 {
		t.Fatal("current host deny allowed already approved local PTY write", err, writes)
	}
	view.HardLocalDeny = false
	err = e.WithSecurityTerminalHandoff(ctx, "project", "case", "terminal", "command", "echo reviewed", func(h SecurityTerminalHandoff) error { writes++; return h.BindEntry("entry", "") })
	if err != nil || writes != 1 {
		t.Fatal("unchanged original confirmed base authority lost", err, writes)
	}
}
