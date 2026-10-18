package lakeadk

import (
	"context"
	"errors"
	"iter"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"
)

type scriptedLLM struct {
	mu    sync.Mutex
	calls int
	first *model.LLMResponse
	then  *model.LLMResponse
}

func (s *scriptedLLM) Name() string { return "scripted" }

func (s *scriptedLLM) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		s.mu.Lock()
		s.calls++
		call := s.calls
		s.mu.Unlock()
		resp := s.first
		if call > 1 {
			resp = s.then
		}
		if resp == nil {
			yield(nil, errors.New("missing scripted response"))
			return
		}
		yield(resp, nil)
	}
}

func (s *scriptedLLM) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func toolCallResponse(id, name string, args map[string]any) *model.LLMResponse {
	return &model.LLMResponse{
		Content: &genai.Content{
			Role: "model",
			Parts: []*genai.Part{{
				FunctionCall: &genai.FunctionCall{ID: id, Name: name, Args: args},
			}},
		},
		TurnComplete: true,
	}
}

func textResponse(text string) *model.LLMResponse {
	return &model.LLMResponse{
		Content: &genai.Content{
			Role:  "model",
			Parts: []*genai.Part{{Text: text}},
		},
		TurnComplete: true,
	}
}

func runtimeSpec(called *bool) ToolSpec {
	return ToolSpec{
		Name:        "write_probe",
		Description: "A test-only write operation",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string"},
			},
			"required": []string{"command"},
		},
		Target:   "local",
		ReadOnly: func(map[string]any) bool { return false },
		Execute: func(context.Context, map[string]any) (any, error) {
			*called = true
			return map[string]any{"ok": true}, nil
		},
	}
}

func TestRuntimePausesForApprovalAndResumes(t *testing.T) {
	called := false
	gate := NewGate(NewMemoryApprovalStore(), NewMemoryEvidence())
	tools, err := BuildTools([]ToolSpec{runtimeSpec(&called)}, gate)
	if err != nil {
		t.Fatal(err)
	}
	llm := &scriptedLLM{
		first: toolCallResponse("call-1", "write_probe", map[string]any{"command": "touch /tmp/x"}),
		then:  textResponse("done"),
	}
	sink := &RecordingSink{}
	rt, err := NewRuntime(llm, tools, session.InMemoryService(), sink)
	if err != nil {
		t.Fatal(err)
	}

	if err := rt.RunTurn(context.Background(), "session-1", "do it"); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}
	_, _, calls, _, approvals, errs, _ := sink.Snapshot()
	if len(errs) != 0 {
		t.Fatalf("runtime errors: %v", errs)
	}
	if called {
		t.Fatal("write tool executed before approval")
	}
	if len(approvals) != 1 {
		t.Fatalf("approvals = %d, want 1: %#v", len(approvals), approvals)
	}
	approval := approvals[0]
	if approval.Tool != "write_probe" {
		t.Fatalf("approval tool = %q", approval.Tool)
	}
	payload, ok := approval.Payload.(map[string]any)
	if !ok || stringValue(payload["approval_id"]) == "" {
		t.Fatalf("approval payload = %#v", approval.Payload)
	}
	if len(calls) != 1 || calls[0].Name != "write_probe" {
		t.Fatalf("tool calls = %#v", calls)
	}

	if err := rt.Resume(context.Background(), "session-1", approval.ID, true, approval.Payload); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	_, messages, _, results, _, errs, done := sink.Snapshot()
	if len(errs) != 0 {
		t.Fatalf("runtime errors after resume: %v", errs)
	}
	if !called {
		t.Fatal("approved tool did not execute")
	}
	if len(results) == 0 || results[0].Name != "write_probe" {
		t.Fatalf("tool results = %#v", results)
	}
	if done < 2 {
		t.Fatalf("done count = %d, want >= 2", done)
	}
	if !strings.Contains(strings.Join(messages, ""), "done") {
		t.Fatalf("final message missing: %#v", messages)
	}
}

func TestRuntimeReadOnlyToolExecutesWithoutApproval(t *testing.T) {
	called := false
	spec := ToolSpec{
		Name:        "read_probe",
		Description: "A test-only read operation",
		Parameters: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		Target:   "local",
		ReadOnly: func(map[string]any) bool { return true },
		Execute: func(context.Context, map[string]any) (any, error) {
			called = true
			return map[string]any{"ok": true}, nil
		},
	}
	gate := NewGate(NewMemoryApprovalStore(), NewMemoryEvidence())
	tools, err := BuildTools([]ToolSpec{spec}, gate)
	if err != nil {
		t.Fatal(err)
	}
	llm := &scriptedLLM{
		first: toolCallResponse("call-1", "read_probe", map[string]any{}),
		then:  textResponse("done"),
	}
	sink := &RecordingSink{}
	rt, err := NewRuntime(llm, tools, session.InMemoryService(), sink)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.RunTurn(context.Background(), "session-1", "read"); err != nil {
		t.Fatalf("RunTurn: %v", err)
	}
	_, _, _, _, approvals, errs, _ := sink.Snapshot()
	if len(errs) != 0 {
		t.Fatalf("runtime errors: %v", errs)
	}
	if !called {
		t.Fatal("read-only tool did not execute")
	}
	if len(approvals) != 0 {
		t.Fatalf("read-only tool asked for approval: %#v", approvals)
	}
	if llm.callCount() < 2 {
		t.Fatalf("model calls = %d, want at least 2", llm.callCount())
	}
}

func TestRuntimeResumeAfterSQLiteReload(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sessions.sqlite")
	approvalPath := filepath.Join(dir, "approvals.json")
	evidencePath := filepath.Join(dir, "evidence.jsonl")

	called := false
	store1, err := NewFileApprovalStore(approvalPath)
	if err != nil {
		t.Fatal(err)
	}
	evidence1, err := NewFileEvidence(evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	gate1 := NewGate(store1, evidence1)
	tools1, err := BuildTools([]ToolSpec{runtimeSpec(&called)}, gate1)
	if err != nil {
		t.Fatal(err)
	}
	sessions1, err := NewSQLiteSessionService(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	sink1 := &RecordingSink{}
	llm1 := &scriptedLLM{
		first: toolCallResponse("call-1", "write_probe", map[string]any{"command": "touch /tmp/x"}),
		then:  textResponse("unused in the first process"),
	}
	rt1, err := NewRuntime(llm1, tools1, sessions1, sink1)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt1.RunTurn(context.Background(), "restart-session", "do it"); err != nil {
		t.Fatalf("first process RunTurn: %v", err)
	}
	_, _, _, _, approvals, errs, _ := sink1.Snapshot()
	if len(errs) != 0 || len(approvals) != 1 {
		t.Fatalf("first process approvals=%#v errors=%v", approvals, errs)
	}
	if called {
		t.Fatal("write executed in the first process")
	}

	if err := sessions1.(*prototypeSQLiteService).Close(); err != nil {
		t.Fatal(err)
	}
	// Simulate a process restart: new stores, new session service instance and a
	// fresh model that will produce the final answer after the tool resumes.
	store2, err := NewFileApprovalStore(approvalPath)
	if err != nil {
		t.Fatal(err)
	}
	evidence2, err := NewFileEvidence(evidencePath)
	if err != nil {
		t.Fatal(err)
	}
	gate2 := NewGate(store2, evidence2)
	tools2, err := BuildTools([]ToolSpec{runtimeSpec(&called)}, gate2)
	if err != nil {
		t.Fatal(err)
	}
	sessions2, err := NewSQLiteSessionService(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer sessions2.(*prototypeSQLiteService).Close()
	sink2 := &RecordingSink{}
	llm2 := &scriptedLLM{first: textResponse("done after restart")}
	rt2, err := NewRuntime(llm2, tools2, sessions2, sink2)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt2.Resume(context.Background(), "restart-session", approvals[0].ID, true, approvals[0].Payload); err != nil {
		t.Fatalf("resume after restart: %v", err)
	}
	_, messages, _, results, _, errs, _ := sink2.Snapshot()
	if len(errs) != 0 {
		t.Fatalf("resume errors: %v", errs)
	}
	if !called {
		t.Fatal("approved tool did not execute after restart")
	}
	if len(results) == 0 || results[0].Name != "write_probe" {
		t.Fatalf("results after restart = %#v", results)
	}
	if !strings.Contains(strings.Join(messages, ""), "done after restart") {
		t.Fatalf("final message after restart = %#v", messages)
	}
}
