package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestPermissionsCLIUpdatesAndJournalsPolicy(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	call := func(args ...string) store.PermissionPolicy {
		t.Helper()
		var out, errOut bytes.Buffer
		if err := run(ctx, args, root, &out, &errOut); err != nil {
			t.Fatalf("permissions command: %v; stderr=%s", err, errOut.String())
		}
		var policy store.PermissionPolicy
		if err := json.Unmarshal(out.Bytes(), &policy); err != nil {
			t.Fatal(err)
		}
		return policy
	}
	if p := call("permissions", "--json"); !p.SilentSSHRead || p.SilentSSHCommand {
		t.Fatalf("defaults = %+v", p)
	}
	if p := call("permissions", "set", "ssh-command", "on", "--json"); !p.SilentSSHCommand {
		t.Fatalf("enabled policy = %+v", p)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	entries, err := s.ListJournal(ctx, store.JournalFilter{})
	if err != nil || len(entries) != 1 || entries[0].Tool != "lake.permissions" || entries[0].Detail != "on" {
		t.Fatalf("journal = %+v, %v", entries, err)
	}
}
