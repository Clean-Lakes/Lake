package lakeadk

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/toolconfirmation"
)

type fakeContext struct {
	agent.ContextMock
	callID           string
	sessionID        string
	confirmation     *toolconfirmation.ToolConfirmation
	requestedHint    string
	requestedPayload any
	actions          session.EventActions
}

func (c *fakeContext) FunctionCallID() string { return c.callID }
func (c *fakeContext) SessionID() string      { return c.sessionID }
func (c *fakeContext) ToolConfirmation() *toolconfirmation.ToolConfirmation {
	return c.confirmation
}
func (c *fakeContext) RequestConfirmation(hint string, payload any) error {
	c.requestedHint = hint
	c.requestedPayload = payload
	return nil
}
func (c *fakeContext) Actions() *session.EventActions { return &c.actions }

func readSpec(called *bool) ToolSpec {
	return ToolSpec{
		Name:     "read_probe",
		Target:   "local",
		ReadOnly: func(map[string]any) bool { return true },
		Execute: func(context.Context, map[string]any) (any, error) {
			*called = true
			return map[string]any{"ok": true}, nil
		},
	}
}

func writeSpec(called *bool) ToolSpec {
	return ToolSpec{
		Name:     "write_probe",
		Target:   "local",
		ReadOnly: func(map[string]any) bool { return false },
		Execute: func(context.Context, map[string]any) (any, error) {
			*called = true
			return map[string]any{"ok": true}, nil
		},
	}
}

func statuses(records []EvidenceRecord) []string {
	out := make([]string, 0, len(records))
	for _, record := range records {
		out = append(out, record.Status)
	}
	return out
}

func TestGateReadOnlyExecutesWithoutApproval(t *testing.T) {
	evidence := NewMemoryEvidence()
	gate := NewGate(NewMemoryApprovalStore(), evidence)
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}

	result, err := gate.Run(ctx, readSpec(&called), map[string]any{"path": "/tmp"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !called {
		t.Fatal("read-only executor was not called")
	}
	if result["ok"] != true {
		t.Fatalf("result = %#v", result)
	}
	got := statuses(evidence.Records())
	want := []string{"started", "completed"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("evidence statuses = %v, want %v", got, want)
	}
}

func TestGateWriteRequiresApprovalAndDoesNotExecute(t *testing.T) {
	evidence := NewMemoryEvidence()
	gate := NewGate(NewMemoryApprovalStore(), evidence)
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}

	result, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/x"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if called {
		t.Fatal("write executor ran without approval")
	}
	if result["status"] != "approval_required" {
		t.Fatalf("result = %#v", result)
	}
	payload, ok := ctx.requestedPayload.(map[string]any)
	if !ok || stringValue(payload["approval_id"]) == "" {
		t.Fatalf("confirmation payload = %#v", ctx.requestedPayload)
	}
	if !ctx.actions.SkipSummarization {
		t.Fatal("confirmation must pause summarization")
	}
	got := statuses(evidence.Records())
	if len(got) != 1 || got[0] != "approval_requested" {
		t.Fatalf("evidence statuses = %v", got)
	}
}

func TestGateApprovedCallExecutesOnce(t *testing.T) {
	evidence := NewMemoryEvidence()
	gate := NewGate(NewMemoryApprovalStore(), evidence)
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	args := map[string]any{"command": "touch /tmp/x"}

	first, err := gate.Run(ctx, writeSpec(&called), args)
	if err != nil {
		t.Fatalf("request approval: %v", err)
	}
	if called {
		t.Fatal("write executor ran before approval")
	}
	payload := ctx.requestedPayload
	ctx.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: payload}

	result, err := gate.Run(ctx, writeSpec(&called), args)
	if err != nil {
		t.Fatalf("approved run: %v", err)
	}
	if !called {
		t.Fatal("approved executor did not run")
	}
	if result["ok"] != true {
		t.Fatalf("result = %#v", result)
	}
	got := statuses(evidence.Records())
	want := []string{"approval_requested", "approved", "started", "completed"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("evidence statuses = %v, want %v", got, want)
	}

	// A replayed token must not execute the tool again.
	called = false
	if _, err := gate.Run(ctx, writeSpec(&called), args); err == nil {
		t.Fatal("replayed approval was accepted")
	}
	if called {
		t.Fatal("replayed approval executed the tool")
	}
	_ = first
}

func TestGateRejectsChangedArguments(t *testing.T) {
	gate := NewGate(NewMemoryApprovalStore(), NewMemoryEvidence())
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	if _, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/a"}); err != nil {
		t.Fatalf("request approval: %v", err)
	}
	ctx.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: ctx.requestedPayload}
	if _, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/b"}); err == nil {
		t.Fatal("approval was accepted for different arguments")
	}
	if called {
		t.Fatal("changed arguments executed without a new approval")
	}
}

func TestGateRejectsMissingAndWrongToken(t *testing.T) {
	gate := NewGate(NewMemoryApprovalStore(), NewMemoryEvidence())
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	ctx.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: map[string]any{}}
	if _, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/x"}); err == nil {
		t.Fatal("missing approval token was accepted")
	}
	ctx.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: map[string]any{"approval_id": "ap_wrong"}}
	if _, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/x"}); err == nil {
		t.Fatal("unknown approval token was accepted")
	}
	if called {
		t.Fatal("invalid approval executed the tool")
	}
}

func TestGateRejectedConfirmationDoesNotExecute(t *testing.T) {
	gate := NewGate(NewMemoryApprovalStore(), NewMemoryEvidence())
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	if _, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/x"}); err != nil {
		t.Fatalf("request approval: %v", err)
	}
	payload := ctx.requestedPayload
	ctx.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: false, Payload: payload}
	_, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/x"})
	if !errors.Is(err, tool.ErrConfirmationRejected) {
		t.Fatalf("err = %v, want ErrConfirmationRejected", err)
	}
	if called {
		t.Fatal("rejected operation executed")
	}

	// A rejection consumes the token: a later approval with the same payload
	// must not execute the operation.
	ctx.confirmation = &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: payload}
	if _, err := gate.Run(ctx, writeSpec(&called), map[string]any{"command": "touch /tmp/x"}); err == nil {
		t.Fatal("rejected approval token was accepted later")
	}
	if called {
		t.Fatal("rejected token executed the tool later")
	}
}

func TestGateRedactsCredentialArguments(t *testing.T) {
	evidence := NewMemoryEvidence()
	gate := NewGate(NewMemoryApprovalStore(), evidence)
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	args := map[string]any{
		"command":  "curl -H 'Authorization: Bearer sk-live-abc' 'https://example.com/?token=supersecret'",
		"password": "hunter2",
		"nested":   map[string]any{"api_key": "sk-secret"},
	}
	if _, err := gate.Run(ctx, writeSpec(&called), args); err != nil {
		t.Fatalf("request approval: %v", err)
	}
	records := evidence.Records()
	if len(records) == 0 {
		t.Fatal("no evidence recorded")
	}
	body, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"hunter2", "sk-secret", "sk-live-abc", "supersecret"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("secret %q leaked into evidence: %s", secret, body)
		}
	}
	if !strings.Contains(string(body), "[REDACTED]") {
		t.Fatalf("evidence has no redaction marker: %s", body)
	}
	if records[0].Args["password"] != "[REDACTED]" {
		t.Fatalf("password was not redacted: %#v", records[0].Args)
	}
}

func TestFileApprovalStoreSurvivesNewGate(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileApprovalStore(filepath.Join(dir, "pending.json"))
	if err != nil {
		t.Fatal(err)
	}
	evidence := NewMemoryEvidence()
	gate := NewGate(store, evidence)
	called := false
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	args := map[string]any{"command": "touch /tmp/x"}
	if _, err := gate.Run(ctx, writeSpec(&called), args); err != nil {
		t.Fatalf("request approval: %v", err)
	}
	payload := ctx.requestedPayload

	// Simulate a process restart: a new gate reads the same pending store.
	reloaded, err := NewFileApprovalStore(filepath.Join(dir, "pending.json"))
	if err != nil {
		t.Fatal(err)
	}
	gate2 := NewGate(reloaded, evidence)
	ctx2 := &fakeContext{callID: "call-1", sessionID: "session-1", confirmation: &toolconfirmation.ToolConfirmation{Confirmed: true, Payload: payload}}
	if _, err := gate2.Run(ctx2, writeSpec(&called), args); err != nil {
		t.Fatalf("resume after reload: %v", err)
	}
	if !called {
		t.Fatal("resumed approval did not execute")
	}
}

func TestFileApprovalStoreExpires(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pending.json")
	store, err := NewFileApprovalStore(path)
	if err != nil {
		t.Fatal(err)
	}
	p := PendingApproval{ID: "ap_expired", Tool: "x", ArgsHash: "h", Target: "local", CreatedAt: time.Now().Add(-2 * time.Hour), ExpiresAt: time.Now().Add(-time.Hour)}
	if err := store.Put(p); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Get(p.ID); ok {
		t.Fatal("expired approval was returned")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !platform.Private(path, info) {
		t.Fatalf("approval store mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestFileEvidenceIsAppendOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "evidence.jsonl")
	sink, err := NewFileEvidence(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := sink.Append(EvidenceRecord{Tool: "a", Status: "started"}); err != nil {
		t.Fatal(err)
	}
	if err := sink.Append(EvidenceRecord{Tool: "a", Status: "completed"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d, want 2: %s", len(lines), b)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !platform.Private(path, info) {
		t.Fatalf("evidence mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestEvidenceRedactsToolResult(t *testing.T) {
	evidence := NewMemoryEvidence()
	gate := NewGate(NewMemoryApprovalStore(), evidence)
	called := false
	spec := ToolSpec{
		Name:     "read_result",
		Target:   "local",
		ReadOnly: func(map[string]any) bool { return true },
		Execute: func(context.Context, map[string]any) (any, error) {
			called = true
			return map[string]any{
				"output":   "token=supersecret",
				"password": "hunter2",
			}, nil
		},
	}
	ctx := &fakeContext{callID: "call-1", sessionID: "session-1"}
	if _, err := gate.Run(ctx, spec, map[string]any{}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !called {
		t.Fatal("executor was not called")
	}
	body, err := json.Marshal(evidence.Records())
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"supersecret", "hunter2"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("secret %q leaked from tool result: %s", secret, body)
		}
	}
	if !strings.Contains(string(body), "[REDACTED]") {
		t.Fatalf("result was not redacted: %s", body)
	}
}
