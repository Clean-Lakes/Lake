package main

import (
	"context"
	"errors"
	"testing"

	"github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/store"
)

func TestAuthorizeToolActionChecksBoundProjectBeforeApproval(t *testing.T) {
	approvals := 0
	approve := func(_, _, _ string) (bool, error) { approvals++; return true, nil }
	if err := authorizeToolAction(context.Background(), "lake", "/work/project", "lake_code_edit", "write", "file.go", "code-edit", "diff", approve); err != nil {
		t.Fatal(err)
	}
	if approvals != 1 {
		t.Fatalf("approvals=%d", approvals)
	}
	if err := authorizeToolAction(context.Background(), "lake", "/work/project", "lake_code_edit", "write", "../outside", "code-edit", "diff", approve); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("outside project was authorized: %v", err)
	}
	if approvals != 1 {
		t.Fatal("approval was requested for out-of-scope path")
	}
}

func TestAuthorizeToolActionWritesDigestOnlyAudit(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx = withPolicyAudit(ctx, s, "session-1")
	secretLikeDetail := "private-content-for-test"
	err = authorizeToolAction(ctx, "lake", "/work/project", "lake_code_edit", "write", "file.go", "code-edit", secretLikeDetail, func(_, _, _ string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	entries, err := s.ListJournal(ctx, store.JournalFilter{})
	if err != nil || len(entries) != 2 {
		t.Fatalf("journal=%+v err=%v", entries, err)
	}
	if entries[0].Event != "approved" || entries[1].Event != "requested" {
		t.Fatalf("events=%+v", entries)
	}
	for _, entry := range entries {
		if entry.Detail == secretLikeDetail || entry.RunID != "session-1" || entry.ActionID != entries[0].ActionID {
			t.Fatalf("unsafe journal entry: %+v", entry)
		}
	}
}
