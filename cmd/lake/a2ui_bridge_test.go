package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
)

func TestBridgeGeneratesUIAndResumesSubmittedFormAfterReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "界面测试", "")
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
	components := []map[string]any{
		{"id": "root", "component": "Column", "children": []string{"chart", "question", "submit", "result"}},
		{"id": "chart", "component": "Chart", "label": "实际采样", "values": uiBinding("/samples")},
		{"id": "question", "component": "TextField", "label": "关注点", "value": uiBinding("/question")},
		{"id": "submit", "component": "Button", "label": "更新图表", "action": uiEvent("continue", map[string]any{"question": uiBinding("/question")})},
		{"id": "result", "component": "Text", "text": uiBinding("/result")},
	}
	initial := uiToolInput{SurfaceID: "main", Components: components, Data: map[string]any{"question": "", "result": "等待选择", "samples": []any{map[string]any{"label": "样本", "value": 12}}}}
	update := []agent.UIMessage{{Version: agent.UIVersion, UpdateDataModel: &agent.UIUpdateDataModel{SurfaceID: "main", Path: "/result", Value: "已按关注点更新"}}}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		n := requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if n == 1 || n == 3 {
			input := initial
			if n == 3 {
				input = uiToolInput{Messages: update}
				if !strings.Contains(string(body), "只看端口") || !strings.Contains(string(body), "surfaceId=main") || !strings.Contains(string(body), "动态界面的事实") {
					t.Error("resumed model lost the submitted form or prior UI context")
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "ui-call", "name": "lake_ui", "input": input}}})
			return
		}
		if n > 4 {
			t.Errorf("unexpected model request %d", n)
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"在面板中继续操作。"}]}`))
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL + "/anthropic", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	run := func(request bridgeRequest) []agent.UISnapshot {
		t.Helper()
		input, _ := json.Marshal(request)
		var output bytes.Buffer
		if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(string(input)+"\n"), &output); err != nil {
			t.Fatal(err)
		}
		var snapshots []agent.UISnapshot
		for _, line := range strings.Split(strings.TrimSpace(output.String()), "\n") {
			var event bridgeEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				t.Fatal(err)
			}
			if event.Error != "" {
				t.Fatalf("bridge error: %s", event.Error)
			}
			if event.Type == "a2ui" && event.UI != nil {
				snapshots = append(snapshots, *event.UI)
			}
		}
		return snapshots
	}
	first := run(bridgeRequest{Type: "ask", ID: "create", Prompt: "用交互表单和图表展示采样"})
	if len(first) != 1 || first[0].Revision != 1 {
		t.Fatalf("initial UI not delivered: %+v", first)
	}
	// A new bridge process must reconstruct the saved surface before accepting
	// the action. The first update persists the form; the model updates data only.
	second := run(bridgeRequest{Type: "ui_action", ID: "continue", UIAction: &agent.UIUserAction{SurfaceID: "main", SourceComponentID: "submit", Name: "continue", Revision: 1, Context: map[string]any{"question": "只看端口"}}})
	if len(second) != 2 || second[1].Revision != 3 || second[1].Data["question"] != "只看端口" || second[1].Data["result"] != "已按关注点更新" {
		t.Fatalf("form or incremental update was lost: %+v", second)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 2 || !strings.Contains(turns[1].Answer, "只看端口") || strings.Contains(turns[1].Display, "surfaceId") {
		t.Fatalf("UI context persistence leaked into display: turns=%+v err=%v", turns, err)
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	audit := false
	for _, event := range events {
		if event.Kind == "ui_action" {
			audit = true
			if strings.Contains(string(event.Payload), "只看端口") || !strings.Contains(string(event.Payload), "context_sha256") {
				t.Fatal("UI audit retained raw form parameters")
			}
		}
	}
	if !audit || requests.Load() != 4 {
		t.Fatalf("audit=%v requests=%d", audit, requests.Load())
	}
}
