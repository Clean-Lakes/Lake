package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

type bridgeTestWriter func([]byte) (int, error)

func (f bridgeTestWriter) Write(p []byte) (int, error) { return f(p) }

func TestBridgeOutputAssignsOrderedVersionedSequences(t *testing.T) {
	var output bytes.Buffer
	writer := &bridgeOutput{enc: json.NewEncoder(&output)}
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			writer.send(bridgeEvent{Type: "progress"})
		}()
	}
	workers.Wait()
	decoder := json.NewDecoder(&output)
	for sequence := uint64(1); sequence <= 20; sequence++ {
		var event bridgeEvent
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event.Version != 1 || event.Sequence != sequence {
			t.Fatalf("event %d has version %d and sequence %d", sequence, event.Version, event.Sequence)
		}
	}
}

func TestBridgeHelloNegotiatesVersionAndKeepsLegacyRequests(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test-model", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: "http://127.0.0.1", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	input := strings.NewReader("{\"type\":\"hello\",\"id\":\"v1\",\"version\":1}\n{\"type\":\"hello\",\"id\":\"future\",\"version\":999}\n{\"type\":\"approve\",\"id\":\"missing\",\"approved\":false}\n")
	var output bytes.Buffer
	if err := runBridge(ctx, root, input, &output); err != nil {
		t.Fatal(err)
	}
	var events []bridgeEvent
	decoder := json.NewDecoder(&output)
	for decoder.More() {
		var event bridgeEvent
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if len(events) != 4 || events[0].Type != "ready" || events[1].Type != "hello" || events[1].ID != "v1" || events[1].Version != 1 || events[2].Type != "error" || events[2].ID != "future" || events[3].Type != "error" || events[3].ID != "missing" {
		t.Fatalf("unexpected protocol responses: %+v", events)
	}
	for index, event := range events {
		if event.Sequence != uint64(index+1) {
			t.Fatalf("event order changed: %+v", events)
		}
	}
}

func TestBridgePersistsCompactionSourcesAcrossReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "long conversation lake", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200; i++ {
		if _, err := s.AppendConversationTurn(ctx, conversation.ID, strings.Repeat("x", 700), strings.Repeat("y", 700), "", ""); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools []json.RawMessage `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if len(body.Tools) == 0 {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"The conversation concerns a test project."}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"final answer"}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "test-model", ModelProvider: "test", ContextWindow: 4096, MaxOutputTokens: 512,
		ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"new-turn","prompt":"current question"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	compactionVisible := false
	decoder := json.NewDecoder(&output)
	for decoder.More() {
		var event bridgeEvent
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "activity" && event.ID == "new-turn" && event.Activity != nil && event.Activity.Kind == "summary_created" {
			compactionVisible = true
		}
	}
	if !compactionVisible {
		t.Fatal("persisted context compaction was not shown live")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	summary, err := reopened.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || summary == nil {
		t.Fatalf("summary was not persisted: %+v err=%v", summary, err)
	}
	if summary.ThroughSeq < 336 || summary.ThroughSeq > 400 || len(summary.SourceEventIDs) != int(summary.ThroughSeq) || summary.SourceEventIDs[0] != 1 || summary.SourceEventIDs[len(summary.SourceEventIDs)-1] != summary.ThroughSeq || summary.TaskState == nil {
		t.Fatalf("summary lost source events: %+v", summary)
	}
	turns, err := reopened.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 201 || turns[200].Answer != "final answer" {
		t.Fatalf("latest turn was not saved: turns=%d err=%v", len(turns), err)
	}
}

func TestBridgePersistsVersionedRunLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "event lake", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"answer"}],"usage":{"input_tokens":20,"output_tokens":3}}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test-model", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"request-1","prompt":"question"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"user", "run_started", "model_usage", "assistant", "answer_finished"}
	if len(events) != len(want) {
		t.Fatalf("event timeline: %+v", events)
	}
	for i, kind := range want {
		if events[i].Kind != kind || events[i].Sequence != uint64(i+1) {
			t.Fatalf("event timeline: %+v", events)
		}
	}
	if events[0].LegacyTurnID == "" || events[0].LegacyTurnID != events[3].LegacyTurnID {
		t.Fatalf("user and assistant events were not linked to one turn: %+v", events)
	}
	var detail bytes.Buffer
	if err := conversationCommand(ctx, s, []string{"show", conversation.ID, "--json"}, &detail, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	var restored struct {
		Events []store.ConversationEvent `json:"events"`
	}
	if err := json.Unmarshal(detail.Bytes(), &restored); err != nil || len(restored.Events) != len(want) {
		t.Fatalf("show omitted versioned events: %s err=%v", detail.String(), err)
	}
}

func TestBridgePersistsFailedRunTerminalEvent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "failed run", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"failure"}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test-model", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"failed","prompt":"question"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) < 4 || events[len(events)-1].Kind != "run_failed" {
		t.Fatalf("failure timeline: %+v", events)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || turns[0].Error == "" {
		t.Fatalf("failed turn: %+v err=%v", turns, err)
	}
}

func TestBridgePersistsOrdinaryToolLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "tool lake", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"toolu-list","name":"lake_overview","input":{}}]}`))
		} else {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"done"}]}`))
		}
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"tool-turn","prompt":"有哪些湖"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 30)
	if err != nil {
		t.Fatal(err)
	}
	var proposed, finished bool
	for _, event := range events {
		if event.ToolCallID != "toolu-list" {
			continue
		}
		proposed = proposed || event.Kind == "tool_proposed"
		finished = finished || event.Kind == "tool_finished"
	}
	if requests != 2 || !proposed || !finished {
		t.Fatalf("ordinary tool events missing: requests=%d events=%+v", requests, events)
	}
}

func TestEnabledMemoryCrossesConversationsAndDisableRemovesContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "memory lake", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetMemoryEnabled(ctx, lake.ID, true); err != nil {
		t.Fatal(err)
	}
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, string(body))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	for index, prompt := range []string{"请记住：湖中生产环境位于上海", "生产环境在哪", "生产环境在哪"} {
		if index == 2 {
			if err := s.SetMemoryEnabled(ctx, lake.ID, false); err != nil {
				t.Fatal(err)
			}
		}
		conversation, err := s.CreateConversation(ctx, lake.Name)
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		request, _ := json.Marshal(bridgeRequest{Type: "ask", ID: "turn", Prompt: prompt})
		if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(string(request)+"\n"), &output); err != nil {
			t.Fatal(err)
		}
	}
	facts, err := s.ListMemoryFacts(ctx, lake.ID, "")
	if err != nil || len(facts) != 1 || facts[0].SourceEventSeq == 0 {
		t.Fatalf("saved memory: %+v err=%v", facts, err)
	}
	if len(requests) != 3 || !strings.Contains(requests[1], "historical facts") || !strings.Contains(requests[1], "湖中生产环境位于上海") || strings.Contains(requests[2], "historical facts") {
		t.Fatalf("memory context visibility: requests=%d second=%q third=%q", len(requests), requests[1], requests[2])
	}
}

func TestBridgeImageReachesModelAndConversation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "图片湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	imageData := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nimage"))
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var body struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		found := false
		for _, message := range body.Messages {
			if message.Role != "user" {
				continue
			}
			var blocks []struct {
				Type   string `json:"type"`
				Source *struct {
					MediaType string `json:"media_type"`
					Data      string `json:"data"`
				} `json:"source"`
			}
			if json.Unmarshal(message.Content, &blocks) == nil {
				for _, block := range blocks {
					if block.Type == "image" && block.Source != nil && block.Source.MediaType == "image/png" && block.Source.Data == imageData {
						found = true
					}
				}
			}
		}
		if !found {
			t.Error("image was not sent to the model")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"图片已收到"}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "deepseek-flash", ModelProvider: "deepseek", ModelProviders: map[string]providerConfig{"deepseek": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	request, _ := json.Marshal(bridgeRequest{Type: "ask", ID: "image-turn", Prompt: "图里有什么", Images: []store.ImageAttachment{{Name: "a.png", MIMEType: "image/png", Data: imageData}}})
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(string(request)+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	if requests != 1 || !strings.Contains(output.String(), "图片已收到") {
		t.Fatalf("requests=%d output=%s", requests, output.String())
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || len(turns[0].Images) != 1 || turns[0].Images[0].Data != imageData {
		t.Fatalf("image was not saved: turns=%+v err=%v", turns, err)
	}
}

func TestBridgePersistsSpecialistCallLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"}}); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		switch requests {
		case 1:
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"delegate-1","name":"lake_ssh_agent","input":{"request":"检查 host 的 CPU 占用"}}]}`))
		case 2:
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"无法读取该主机。"}]}`))
		case 3:
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"SSH 专员没有取得 CPU 数据。"}]}`))
		default:
			t.Errorf("unexpected model request %d", requests)
		}
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "mimo", ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"turn-1","prompt":"检查 host 的 CPU 占用"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	stages := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var event bridgeEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "specialist" && event.Specialist != nil {
			stages[event.Specialist.Stage] = true
		}
	}
	if requests != 3 || !stages["delegated"] || !stages["working"] || !stages["returned"] || !stages["completed"] {
		t.Fatalf("specialist stages=%v requests=%d", stages, requests)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || len(turns[0].Specialists) != 1 {
		t.Fatalf("stored calls=%+v err=%v", turns, err)
	}
	call := turns[0].Specialists[0]
	if call.ID != "delegate-1" || call.Kind != "ssh" || call.Stage != "completed" || call.Task != "检查 host 的 CPU 占用" {
		t.Fatalf("stored call=%+v", call)
	}
	tasks, err := s.ListSpecialistTasks(ctx, conversation.ID)
	if err != nil || len(tasks) != 1 || tasks[0].Name != "lake_ssh_agent" || tasks[0].Model != "test" || tasks[0].Status != "completed" || tasks[0].ConversationID != conversation.ID {
		t.Fatalf("persisted specialist tasks=%+v err=%v", tasks, err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 30)
	if err != nil {
		t.Fatal(err)
	}
	var proposed, finished bool
	for _, event := range events {
		if event.ToolCallID != call.ID {
			continue
		}
		proposed = proposed || event.Kind == "tool_proposed"
		finished = finished || event.Kind == "tool_finished"
	}
	if !proposed || !finished {
		t.Fatalf("specialist tool events missing: %+v", events)
	}
}

func TestWorkflowTracePersistsActualSSHSteps(t *testing.T) {
	progress := workflow.Progress{RunID: "run-1", Name: "巡检", Status: "running", Total: 2}
	call := workflowTrace(store.SpecialistCall{}, progress)
	progress.StepID, progress.StepName, progress.Resource, progress.Kind, progress.StepStatus = "cpu", "CPU 巡检", "web", "ssh_check", "running"
	call = workflowTrace(call, progress)
	progress.StepStatus, progress.Completed = "completed", 1
	call = workflowTrace(call, progress)
	progress.StepID, progress.StepName, progress.Resource, progress.StepStatus = "disk", "磁盘巡检", "db", "failed"
	call = workflowTrace(call, progress)
	progress.StepID, progress.Status, progress.Completed = "", "failed", 2
	call = workflowTrace(call, progress)
	if call.Kind != "workflow" || call.Stage != "failed" || len(call.Steps) != 2 || call.Steps[0].Status != "completed" || call.Steps[0].Resource != "web" || call.Steps[1].Resource != "db" {
		t.Fatalf("trace=%+v", call)
	}
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "测试湖", ""); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, "测试湖")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurnWithDetails(ctx, conversation.ID, "运行巡检", "失败", "失败", "", nil, []store.SpecialistCall{call}); err != nil {
		t.Fatal(err)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || len(turns[0].Specialists) != 1 || len(turns[0].Specialists[0].Steps) != 2 {
		t.Fatalf("saved trace=%+v err=%v", turns, err)
	}
}

func TestBridgeEmitsAndPersistsWorkflowExecutionTrace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"}}); err != nil {
		t.Fatal(err)
	}
	definition := workflow.Definition{Name: "巡检", TargetMode: "fixed", Steps: []workflow.Step{{ID: "cpu", Name: "CPU", Kind: "ssh_check", Resource: "host", Check: "cpu"}}}
	body, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateWorkflow(ctx, lake.Name, definition.Name, "", body); err != nil {
		t.Fatal(err)
	}
	requests, planningRequests := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(body), "你是 Lake 工作流执行计划评估器") {
			planningRequests++
			io.WriteString(w, `{"content":[{"type":"text","text":"{\"adjustments\":[]}"}]}`)
			return
		}
		requests++
		if requests == 1 {
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"workflow-call","name":"lake_workflow_run","input":{"name":"巡检"}}]}`))
		}
		if requests == 2 {
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"巡检未通过。"}]}`))
		}
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "mimo", ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	reader, inputWriter := io.Pipe()
	defer inputWriter.Close()
	go func() {
		_, _ = io.WriteString(inputWriter, `{"type":"ask","id":"turn-1","prompt":"运行巡检"}`+"\n")
	}()
	var output bytes.Buffer
	respondingOutput := bridgeTestWriter(func(p []byte) (int, error) {
		n, err := output.Write(p)
		var event bridgeEvent
		if json.Unmarshal(p, &event) == nil {
			if event.Type == "approval" && event.Kind == "workflow" {
				go func() { _, _ = io.WriteString(inputWriter, `{"type":"approve","id":"turn-1","approved":true}`+"\n") }()
			}
			if event.Type == "result" {
				_ = inputWriter.Close()
			}
		}
		return n, err
	})
	if err := runBridgeConversation(ctx, root, conversation.ID, reader, respondingOutput); err != nil {
		t.Fatal(err)
	}
	var sawRunningStep, sawTrace bool
	for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
		var event bridgeEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "visual_report" {
			t.Fatal("execution bookkeeping was presented as an inspection result")
		}
		if event.Type == "workflow" && event.Workflow != nil && event.Workflow.StepID == "cpu" && event.Workflow.StepStatus == "running" {
			sawRunningStep = true
		}
		if event.Type == "specialist" && event.Specialist != nil && event.Specialist.Kind == "workflow" && len(event.Specialist.Steps) == 1 {
			sawTrace = true
		}
	}
	if requests != 2 || planningRequests != 1 || !sawRunningStep || !sawTrace {
		t.Fatalf("requests=%d running=%t trace=%t events=%s", requests, sawRunningStep, sawTrace, output.String())
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || len(turns[0].Specialists) != 1 || turns[0].Specialists[0].Kind != "workflow" || turns[0].Specialists[0].Steps[0].Status != "failed" {
		t.Fatalf("saved trace=%+v err=%v", turns, err)
	}
}

func TestBridgeRunsSavedWorkflowWithStructuredTargets(t *testing.T) {
	for _, test := range []struct {
		name, mode string
		targets    []string
		wantSteps  int
	}{
		{name: "fixed", mode: "fixed", wantSteps: 1},
		{name: "multiple", mode: "multiple", targets: []string{"host-a", "host-b"}, wantSteps: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			root := t.TempDir()
			s, err := store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			lake, err := s.CreateLake(ctx, "测试湖", "")
			if err != nil {
				t.Fatal(err)
			}
			if err := s.UseLake(ctx, lake.ID); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"host-a", "host-b"} {
				if _, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: name, SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"}}); err != nil {
					t.Fatal(err)
				}
			}
			resource := "host-a"
			if test.mode == "multiple" {
				resource = "$host"
			}
			def := workflow.Definition{Name: "巡检", TargetMode: test.mode, Steps: []workflow.Step{{ID: "cpu", Name: "CPU", Kind: "ssh_check", Resource: resource, Check: "cpu"}}}
			body, _ := json.Marshal(def)
			if _, err := s.CreateWorkflow(ctx, lake.Name, def.Name, "", body); err != nil {
				t.Fatal(err)
			}
			conversation, err := s.CreateConversation(ctx, lake.Name)
			if err != nil {
				t.Fatal(err)
			}
			modelCalls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				raw, _ := json.Marshal(body)
				if strings.Contains(string(raw), "你是 Lake 工作流执行计划评估器") {
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, `{"content":[{"type":"text","text":"{\"adjustments\":[]}"}]}`)
					return
				}
				modelCalls++
				if !strings.Contains(string(raw), "工作流已经在当前轮执行") || !strings.Contains(string(raw), "执行授权") {
					t.Error("actual workflow record missing from model analysis")
				}
				tools, _ := body["tools"].([]any)
				if len(tools) != 4 {
					t.Error("workflow analysis did not use the read-only tool set")
				}
				for _, candidate := range tools {
					info, _ := candidate.(map[string]any)
					switch info["name"] {
					case "lake_ui", "lake_workflow_status", "lake_workflow_v2_status", "lake_conversation_history":
					default:
						t.Error("workflow analysis exposed execution or legacy presentation", info["name"])
					}
				}
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"content":[{"type":"text","text":"运行 ID已记录；主机尚未授权，工作流failed，未执行远端操作。"}],"usage":{"input_tokens":30,"output_tokens":10}}`)
			}))
			defer server.Close()
			oldKeys := modelKeys
			modelKeys = fakeModelKeys{}
			t.Cleanup(func() { modelKeys = oldKeys })
			if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "mimo", ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
				t.Fatal(err)
			}
			request, _ := json.Marshal(bridgeRequest{Type: "workflow_run", ID: "run-turn", Prompt: "运行巡检", Workflow: &workflowRunInput{Name: "巡检", Targets: test.targets}})
			var output bytes.Buffer
			if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(string(request)+"\n"), &output); err != nil {
				t.Fatal(err)
			}
			var sawTrace, sawResult bool
			for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
				var event bridgeEvent
				if err := json.Unmarshal([]byte(line), &event); err != nil {
					t.Fatal(err)
				}
				if event.Type == "specialist" && event.Specialist != nil && event.Specialist.Kind == "workflow" && len(event.Specialist.Steps) == test.wantSteps {
					sawTrace = true
				}
				if event.Type == "result" && event.ID == "run-turn" && strings.Contains(event.Text, "运行 ID") {
					sawResult = true
				}
			}
			turns, err := s.ListConversationTurns(ctx, conversation.ID)
			if err != nil {
				t.Fatal(err)
			}
			if modelCalls != 1 || !sawTrace || !sawResult || len(turns) != 1 || turns[0].Prompt != "运行巡检" || len(turns[0].Specialists) != 1 || len(turns[0].Specialists[0].Steps) != test.wantSteps || !strings.Contains(turns[0].Display, "模型调用 2 次") {
				t.Fatalf("trace=%t result=%t turns=%+v events=%s", sawTrace, sawResult, turns, output.String())
			}
		})
	}
}

func TestBridgeKeepsAgentProcessForLocalTurn(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := saveModelConfig(root, lakeModelConfig{
		Model: "test", ModelProvider: "mimo",
		ModelProviders: map[string]providerConfig{"mimo": {BaseURL: "https://example.invalid/anthropic", WireAPI: "anthropic"}},
	}); err != nil {
		t.Fatal(err)
	}

	input := strings.NewReader("{\"type\":\"ask\",\"id\":\"one\",\"prompt\":\"/sessions\"}\n")
	var output bytes.Buffer
	if err := runBridge(ctx, root, input, &output); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("events=%q", output.String())
	}
	var ready, result bridgeEvent
	if err := json.Unmarshal([]byte(lines[0]), &ready); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &result); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "ready" || ready.Model != "test" ||
		result.Type != "result" || result.ID != "one" ||
		!strings.Contains(result.Text, "没有挂起的 SSH 连接") {
		t.Fatalf("ready=%+v result=%+v", ready, result)
	}
}

func TestBridgeRestoresSavedConversation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "mimo", ModelProviders: map[string]providerConfig{"mimo": {BaseURL: "https://example.invalid/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	input := strings.NewReader("{\"type\":\"ask\",\"id\":\"first\",\"prompt\":\"你有哪些资源\"}\n")
	if err := runBridgeConversation(ctx, root, conversation.ID, input, &output); err != nil {
		t.Fatal(err)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || turns[0].Answer == "" {
		t.Fatalf("saved turns=%+v err=%v", turns, err)
	}
	if _, err := s.RenameConversation(ctx, conversation.ID, "资源总览"); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(""), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"type":"ready"`) {
		t.Fatalf("bridge did not reopen: %s", output.String())
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestBridgeStartsWithBoundCodeProject(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	root := t.TempDir()
	projectPath := t.TempDir()
	if err := os.WriteFile(projectPath+"/main.go", []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	project, err := s.CreateCodeProject(ctx, lake.Name, "sample", projectPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetConversationProject(ctx, conversation.ID, project.ID); err != nil {
		t.Fatal(err)
	}
	var toolNames = make(map[string]bool)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		for _, item := range body.Tools {
			toolNames[item.Name] = true
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"已查看项目。"}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "mimo", ModelProviders: map[string]providerConfig{"mimo": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"code-tools","prompt":"查看项目"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"type":"ready"`) {
		t.Fatalf("bridge not ready: %s", output.String())
	}
	if !toolNames["lake_code_agent"] {
		t.Fatalf("code specialist missing from model tools: %+v", toolNames)
	}
}

func TestBridgeApprovalGateSerializesParallelCommands(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	gate := &bridgeApprovalGate{}
	events := make(chan bridgeEvent, 2)
	type result struct {
		command  string
		approved bool
		err      error
	}
	results := make(chan result, 2)
	for _, command := range []string{"first", "second"} {
		go func(command string) {
			approved, err := gate.request(ctx, "turn", "ssh", "lake/host", command, func(event bridgeEvent) {
				events <- event
			})
			results <- result{command: command, approved: approved, err: err}
		}(command)
	}
	first := <-events
	if first.Type != "approval" || first.ID != "turn" || first.Kind != "ssh" {
		t.Fatalf("first approval event = %+v", first)
	}
	select {
	case second := <-events:
		t.Fatalf("second approval appeared before the first was answered: %+v", second)
	case <-time.After(30 * time.Millisecond):
	}
	if !gate.respond("turn", true) {
		t.Fatal("first approval was not accepted")
	}
	second := <-events
	if second.Command == first.Command {
		t.Fatalf("same approval was emitted twice: %+v", second)
	}
	if !gate.respond("turn", false) {
		t.Fatal("second approval was not accepted")
	}
	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		item := <-results
		if item.err != nil {
			t.Fatal(item.err)
		}
		got[item.command] = item.approved
	}
	if !got[first.Command] || got[second.Command] {
		t.Fatalf("approval results do not match answers: %+v", got)
	}
}
