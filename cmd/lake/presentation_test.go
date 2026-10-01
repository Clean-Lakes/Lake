package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"github.com/cloudwego/eino/lake/workflow"
	"github.com/cloudwego/eino/schema"
)

func TestPresentationBudgetCountsOnlyValidationAndStopsParallelAttempts(t *testing.T) {
	ctx := withPresentationBudget(context.Background())
	operational := errors.New("fixture persistence failure")
	if _, err := runPresentationAttempt(ctx, func() (string, error) { return "", operational }); !errors.Is(err, operational) {
		t.Fatal("operational failure was swallowed")
	}
	b := ctx.Value(presentationBudgetKey{}).(*presentationBudget)
	if b.exhausted() {
		t.Fatal("operational failure consumed the budget")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := runPresentationAttempt(canceled, func() (string, error) { t.Error("canceled attempt ran"); return "", nil }); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was swallowed")
	}
	var actual atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := runPresentationAttempt(ctx, func() (string, error) {
				actual.Add(1)
				return `{"error":"invalid_ui","message":"correct format"}`, nil
			})
			if err != nil || !strings.Contains(out, "error") {
				t.Error("invalid presentation feedback", err)
			}
		}()
	}
	wg.Wait()
	if actual.Load() != 2 || !b.exhausted() {
		t.Fatalf("executed %d invalid layouts", actual.Load())
	}
	next := withPresentationBudget(ctx)
	if next.Value(presentationBudgetKey{}).(*presentationBudget).exhausted() {
		t.Fatal("next user turn inherited the exhausted budget")
	}
}

type presentationBadEndpoint struct{}

func (presentationBadEndpoint) Generate(_ context.Context, messages []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	if len(model.GetCommonOptions(nil, opts...).Tools) != 0 {
		return nil, errors.New("fallback still offered tools")
	}
	if !strings.Contains(messages[0].Content, presentationFallbackInstruction) {
		return nil, errors.New("fallback did not request automatic UI text")
	}
	return schema.AssistantMessage("", []schema.ToolCall{{ID: "bad", Function: schema.FunctionCall{Name: "lake_workflow_run", Arguments: `{}`}}}), nil
}
func (m presentationBadEndpoint) Stream(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	out, err := m.Generate(ctx, input, opts...)
	return schema.StreamReaderFromArray([]*schema.Message{out}), err
}

func TestPresentationFallbackNeverExecutesUnsolicitedToolCalls(t *testing.T) {
	ctx := withPresentationBudget(context.Background())
	b := ctx.Value(presentationBudgetKey{}).(*presentationBudget)
	b.failures = presentationFailureLimit
	first := schema.SystemMessage("original instruction")
	m := &presentationModel{base: presentationBadEndpoint{}}
	input := []*schema.Message{first, schema.UserMessage("saved facts")}
	opts := []model.Option{model.WithTools([]*schema.ToolInfo{{Name: "lake_ui"}})}
	out, err := m.Generate(ctx, input, opts...)
	if err != nil || len(out.ToolCalls) != 0 || out.Content == "" || first.Content != "original instruction" {
		t.Fatal("fallback executed calls or mutated history", err)
	}
	stream, err := m.Stream(ctx, input, opts...)
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	out, err = stream.Recv()
	if err != nil || len(out.ToolCalls) != 0 {
		t.Fatal("streaming fallback exposed calls", err)
	}
}

type presentationWorkflowFixture struct{ calls atomic.Int32 }

func (f *presentationWorkflowFixture) RunRead(_ context.Context, _, check string) (sshtransport.Result, error) {
	f.calls.Add(1)
	return sshtransport.Result{Stdout: map[string]string{"cpu": "CPU：25%", "disk": "磁盘：60%"}[check]}, nil
}
func (f *presentationWorkflowFixture) RunCommand(context.Context, string, string) (sshtransport.Result, error) {
	return sshtransport.Result{}, errors.New("unexpected command")
}

func TestBridgeStopsInvalidLayoutsAndRestoresNextTurn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "fixture", "")
	if err = s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	_, err = s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "fixture-host", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	definition := workflow.Definition{Name: "CPU磁盘巡检", TargetMode: "fixed", ExecutionMode: "fixed", Steps: []workflow.Step{{ID: "cpu", Name: "CPU", Resource: "fixture-host", Kind: "ssh_check", Check: "cpu"}, {ID: "disk", Name: "磁盘", Resource: "fixture-host", Kind: "ssh_check", Check: "disk"}}}
	body, _ := json.Marshal(definition)
	saved, err := s.CreateWorkflow(ctx, lake.Name, definition.Name, "", body)
	if err != nil {
		t.Fatal(err)
	}
	remote := &presentationWorkflowFixture{}
	run, err := workflow.Start(ctx, s, saved, "desktop", remote, nil)
	if err != nil || run.Status != "completed" || remote.calls.Load() != 2 {
		t.Fatal("fixture workflow did not complete", err)
	}
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	answer := formatWorkflowRunAnswer(run)
	if _, err := s.AppendConversationTurn(ctx, conversation.ID, "运行CPU磁盘巡检", answer, answer, ""); err != nil {
		t.Fatal(err)
	}
	final := "## 巡检结果\n\n两项采样已完成。\n\n| 指标 | 使用率 |\n| --- | --- |\n| CPU | 25% |\n| 磁盘 | 60% |\n\n运行记录：" + run.ID
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		n := requests.Add(1)
		tools, _ := json.Marshal(body["tools"])
		messages, _ := json.Marshal(body["messages"])
		w.Header().Set("Content-Type", "application/json")
		if n == 1 || n == 2 {
			if bytes.Contains(tools, []byte("lake_visual_report")) || bytes.Contains(tools, []byte("lake_workflow_run")) || !bytes.Contains(tools, []byte("lake_ui")) {
				t.Error("review offered legacy or execution tools")
			}
			input := map[string]any{"messages": []any{}}
			if n == 2 {
				input = map[string]any{"root": "root"}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": fmt.Sprintf("invalid-%d", n), "name": "lake_ui", "input": input}}})
			return
		}
		if n == 3 {
			available, _ := body["tools"].([]any)
			if len(available) != 0 {
				t.Error("fallback still offered tools")
			}
			for _, fact := range []string{"25%", "60%", run.ID, "invalid_ui"} {
				if !bytes.Contains(messages, []byte(fact)) {
					t.Error("fallback lost evidence", fact)
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "text", "text": final}}})
			return
		}
		if n == 4 {
			if !bytes.Contains(tools, []byte("lake_ui")) || !bytes.Contains(tools, []byte("lake_workflow_run")) {
				t.Error("next turn did not restore tools")
			}
			ui := uiCreate("next", []map[string]any{{"id": "root", "component": "Text", "text": "下一轮界面正常展示"}}, map[string]any{})
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "valid-next", "name": "lake_ui", "input": uiToolInput{Messages: ui}}}})
			return
		}
		if n != 5 {
			t.Error("unexpected additional generation", n)
		}
		_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"界面已更新。"}]}`)
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	reader, sender := io.Pipe()
	defer sender.Close()
	var output bytes.Buffer
	writer := bridgeTestWriter(func(p []byte) (int, error) {
		n, err := output.Write(p)
		var event bridgeEvent
		if json.Unmarshal(p, &event) == nil && event.Type == "result" {
			if event.Error != "" {
				t.Error("presentation aborted the turn", event.Error)
			}
			if event.ID == "first" {
				go func() {
					_ = json.NewEncoder(sender).Encode(bridgeRequest{Type: "ask", ID: "next", Prompt: "展示一个新面板"})
				}()
			} else {
				_ = sender.Close()
			}
		}
		return n, err
	})
	go func() {
		_ = json.NewEncoder(sender).Encode(bridgeRequest{Type: "ask", ID: "first", Prompt: "整理已有CPU磁盘巡检结果", ReviewOnly: true})
	}()
	if err := runBridgeConversation(ctx, root, conversation.ID, reader, writer); err != nil {
		t.Fatal(err)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 3 || !strings.Contains(turns[1].Display, final) || turns[1].Error != "" || turns[2].Error != "" {
		t.Fatal("fallback or subsequent UI was not saved", err)
	}
	events, _ := s.ListAgentEvents(ctx, conversation.ID, 0, 100)
	invalid, success := 0, 0
	for _, event := range events {
		if event.Kind == "tool_finished" && bytes.Contains(event.Payload, []byte(`"failed"`)) {
			invalid++
		}
		if event.Kind == "a2ui" {
			success++
		}
	}
	runs, err := s.ListWorkflowRuns(ctx, lake.ID, 10)
	if err != nil || len(runs) != 1 || remote.calls.Load() != 2 || invalid != 2 || success != 1 || requests.Load() != 5 {
		t.Fatalf("runs=%d operations=%d invalid=%d surfaces=%d requests=%d", len(runs), remote.calls.Load(), invalid, success, requests.Load())
	}
}

func TestLegacyPresentationChannelStillUsesReportTool(t *testing.T) {
	root := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tools, _ := json.Marshal(body["tools"])
		if !bytes.Contains(tools, []byte("lake_visual_report")) || bytes.Contains(tools, []byte(`"name":"lake_ui"`)) {
			t.Error("legacy-only channel lost its report tool")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"已说明。"}]}`)
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	if err := runChatWithHooks(context.Background(), []string{"解释检查结果"}, root, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, &chatHooks{PresentReport: func(context.Context, agent.VisualReport) error { return nil }}); err != nil {
		t.Fatal(err)
	}
}
