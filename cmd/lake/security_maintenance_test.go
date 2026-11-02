package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSecurityMaintenanceCLIValidatesExplicitInputsAndClosedActivation(t *testing.T) {
	for _, args := range [][]string{
		{"security", "checkpoint"},
		{"security", "checkpoint", "--home", t.TempDir()},
		{"security", "verify-backup"},
		{"security", "verify-backup", "--path", t.TempDir(), "unexpected"},
		{"security", "restore"},
		{"security", "restore", "--home", t.TempDir()},
		{"security", "recovery-status"},
		{"security", "recovery-review"},
		{"security", "recovery-map", "--home", t.TempDir()},
		{"security", "recovery-confirm-policy", "--home", t.TempDir()},
		{"security", "recovery-activate", "--home", t.TempDir()},
		{"security", "shadow"},
		{"security", "enforce"},
	} {
		if err := run(context.Background(), args); err == nil {
			t.Fatal("unsafe or incomplete management command accepted", args)
		}
	}
}

func TestSecurityMaintenanceTypedActionsRejectActorAndUnknownBypass(t *testing.T) {
	for _, value := range []string{`{"actorId":"model"}`, `{"ignoreUnknown":true}`, `{"actionId":"a"} {"actionId":"b"}`} {
		path := filepath.Join(t.TempDir(), "action.json")
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		var action ai.SecurityRecoveryAction
		if err := readSecurityMaintenanceAction(path, &action); err == nil {
			t.Fatal("untrusted actor/bypass/trailing action accepted")
		}
	}
}

func TestSecurityMaintenanceCLICheckpointVerifyAndClosedRestore(t *testing.T) {
	ctx := context.Background()
	h, err := ai.OpenSecurityHome(ctx, t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	home := h.Home
	before, err := ai.ReadSecurityControl(home)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
	checkpoint := filepath.Join(t.TempDir(), "checkpoint")
	for _, args := range [][]string{
		{"security", "checkpoint", "--home", home, "--output", checkpoint},
		{"security", "verify-backup", "--path", checkpoint},
		{"security", "restore", "--home", home, "--from", checkpoint},
		{"security", "recovery-status", "--home", home},
	} {
		if err = run(ctx, args); err != nil {
			t.Fatal("management command failed", args, err)
		}
	}
	after, err := ai.ReadSecurityControl(home)
	if err != nil || after.Gate != "closed" || after.RecoveryEpoch == before.RecoveryEpoch {
		t.Fatal("CLI restore did not fence execution", err)
	}
}
