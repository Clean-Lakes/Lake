package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/agent"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/schema"
)

func TestBridgeEmptyModelRecoveryDoesNotRepeatExecutedToolOrLoseMCPImage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "空响应恢复", "")
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	data := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfixture"))
	_, err = s.AppendConversationTurnWithImages(ctx, conversation.ID, "添加这个MCP，参考截图", "", "", "fixture earlier request failed", []store.ImageAttachment{{Name: "fixture.png", MIMEType: "image/png", Data: data}})
	if err != nil {
		t.Fatal(err)
	}
	var modelCalls atomic.Int32
	var firstAfterTool []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !bytes.Contains(body, []byte(data)) || !bytes.Contains(body, []byte("添加这个MCP")) || !bytes.Contains(body, []byte("继续加一下上面的mcp部分")) {
			t.Error("model retry lost pending MCP request, screenshot or current request")
		}
		w.Header().Set("Content-Type", "application/json")
		switch modelCalls.Add(1) {
		case 1:
			io.WriteString(w, `{"content":[{"type":"tool_use","id":"history-once","name":"lake_conversation_history","input":{"query":"MCP"}}]}`)
		case 2:
			firstAfterTool = body
			if !bytes.Contains(body, []byte("tool_result")) || !bytes.Contains(body, []byte("history-once")) {
				t.Error("actual tool result missing before empty response")
			}
			io.WriteString(w, `{"content":[],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":1}}`)
		case 3:
			if !bytes.Equal(firstAfterTool, body) {
				t.Error("recovery restarted the Agent or altered actual tool context")
			}
			io.WriteString(w, `{"content":[{"type":"text","text":"MCP 截图和原请求仍在，继续处理。"}]}`)
		default:
			t.Error("model recovery repeated tool execution")
			io.WriteString(w, `{"content":[{"type":"text","text":"unexpected"}]}`)
		}
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previousKeys := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previousKeys })
	var output bytes.Buffer
	if err = runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"retry","prompt":"继续加一下上面的mcp部分"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	turns, _ := s.ListConversationTurns(ctx, conversation.ID)
	if modelCalls.Load() != 3 || len(turns) != 2 || turns[1].Error != "" || !strings.Contains(turns[1].Answer, "MCP 截图") || turns[0].Images[0].Data != data {
		t.Fatal("empty response recovery did not finish current request")
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 500)
	proposed, finished, usageEvents := 0, 0, 0
	for _, event := range events {
		if event.ToolCallID == "history-once" && event.Kind == "tool_proposed" {
			proposed++
		} else if event.ToolCallID == "history-once" && event.Kind == "tool_finished" {
			finished++
		} else if event.Kind == "model_usage" {
			usageEvents++
		}
	}
	if err != nil || proposed != 1 || finished != 1 || usageEvents != 1 {
		t.Fatalf("tool or usage audit duplicated: proposed=%d finished=%d usage=%d err=%v", proposed, finished, usageEvents, err)
	}
}

func TestChatRecordsUsageWhenEmptyResponseRecoveryFails(t *testing.T) {
	root := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"content":[],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":1}}`)
	}))
	defer server.Close()
	if err := saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previousKeys := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previousKeys })
	var usage lakemodel.UsageSnapshot
	calls := 0
	err := runChatWithHooks(context.Background(), []string{"继续 MCP 请求"}, root, strings.NewReader(""), &bytes.Buffer{}, &bytes.Buffer{}, &chatHooks{OnUsage: func(value lakemodel.UsageSnapshot) error { calls++; usage = value; return nil }})
	if err == nil || !strings.Contains(err.Error(), "已自动重试1次") || calls != 1 || usage.Calls != 2 || usage.TotalTokens() != 22 {
		t.Fatalf("failed recovery usage missing: hooks=%d usage=%+v err=%v", calls, usage, err)
	}
}

func TestBridgeFailedImageRequestIsRememberedOnContinue(t *testing.T) {
	for _, restart := range []bool{false, true} {
		name := "same_bridge"
		if restart {
			name = "reopened_bridge"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			root := t.TempDir()
			s, err := store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			lake, _ := s.CreateLake(ctx, "连续性", "")
			if err = s.UseLake(ctx, lake.ID); err != nil {
				t.Fatal(err)
			}
			conversation, _ := s.CreateConversation(ctx, lake.Name)
			for i := 0; i < 3; i++ {
				if _, err = s.AppendConversationTurn(ctx, conversation.ID, "旧巡检任务", strings.Repeat("巡检已完成，旧任务结束。", 600), "", ""); err != nil {
					t.Fatal(err)
				}
			}
			data := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfixture"))
			var modelCalls, summaryCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Tools []struct {
						Name string `json:"name"`
					} `json:"tools"`
					Messages []struct {
						Role    string          `json:"role"`
						Content json.RawMessage `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error("invalid model input")
				}
				w.Header().Set("Content-Type", "application/json")
				if len(body.Tools) == 0 {
					summaryCalls.Add(1)
					io.WriteString(w, `{"content":[{"type":"text","text":"旧巡检已经结束。"}]}`)
					return
				}
				if modelCalls.Add(1) == 1 {
					w.WriteHeader(http.StatusBadRequest)
					io.WriteString(w, `{"type":"error","error":{"type":"invalid_request_error","message":"fixture rejected this turn"}}`)
					return
				}
				hasRequest, hasImage, hasFailure, hasHistoryTool := false, false, false, false
				for _, candidate := range body.Tools {
					hasHistoryTool = hasHistoryTool || candidate.Name == "lake_conversation_history"
				}
				for _, message := range body.Messages {
					var parts []struct {
						Type   string `json:"type"`
						Text   string `json:"text"`
						Source *struct {
							Data string `json:"data"`
						} `json:"source"`
					}
					if json.Unmarshal(message.Content, &parts) == nil {
						for _, part := range parts {
							if message.Role == "user" && strings.Contains(part.Text, "添加这个连接，参考截图") {
								hasRequest = true
							}
							if message.Role == "user" && part.Source != nil && part.Source.Data == data {
								hasImage = true
							}
							if message.Role == "assistant" && strings.Contains(part.Text, "本轮失败或中断") {
								hasFailure = true
							}
						}
					}
				}
				if !hasRequest || !hasImage || !hasFailure || !hasHistoryTool {
					t.Errorf("continue lost latest failed request: prompt=%t image=%t failure=%t history=%t", hasRequest, hasImage, hasFailure, hasHistoryTool)
				}
				io.WriteString(w, `{"content":[{"type":"text","text":"继续处理刚才的连接请求，截图仍在。"}]}`)
			}))
			defer server.Close()
			if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ContextWindow: 8192, MaxOutputTokens: 1024, ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
				t.Fatal(err)
			}
			previousKeys := modelKeys
			modelKeys = fakeModelKeys{}
			t.Cleanup(func() { modelKeys = previousKeys })
			request, _ := json.Marshal(bridgeRequest{Type: "ask", ID: "failed", Prompt: "添加这个连接，参考截图", Images: []store.ImageAttachment{{Name: "fixture.png", MIMEType: "image/png", Data: data}}})
			var output bytes.Buffer
			if restart {
				if err = runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(string(request)+"\n"), &output); err != nil {
					t.Fatal(err)
				}
				if err = runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"continue","prompt":"继续"}`+"\n"), &output); err != nil {
					t.Fatal(err)
				}
			} else {
				reader, input := io.Pipe()
				defer reader.Close()
				defer input.Close()
				go func() { _, _ = io.WriteString(input, string(request)+"\n") }()
				writer := bridgeTestWriter(func(p []byte) (int, error) {
					n, err := output.Write(p)
					var event bridgeEvent
					if json.Unmarshal(p, &event) == nil && event.Type == "result" {
						if event.ID == "failed" {
							go func() { _, _ = io.WriteString(input, `{"type":"ask","id":"continue","prompt":"继续"}`+"\n") }()
						} else {
							_ = input.Close()
						}
					}
					return n, err
				})
				if err = runBridgeConversation(ctx, root, conversation.ID, reader, writer); err != nil {
					t.Fatal(err)
				}
			}
			turns, err := s.ListConversationTurns(ctx, conversation.ID)
			if err != nil || len(turns) != 5 || turns[3].Error == "" || turns[3].Answer != "" || len(turns[3].Images) != 1 || turns[3].Images[0].Data != data || turns[4].Error != "" || !strings.Contains(turns[4].Answer, "连接请求") || modelCalls.Load() != 2 || summaryCalls.Load() == 0 {
				t.Fatal("failed turn audit or resumed context incorrect", err)
			}
		})
	}
}

func TestPendingContextReleasesAfterReplyAndKeepsSourceHoles(t *testing.T) {
	var history []agent.ContextItem
	for i := 0; i < 20; i++ {
		history = appendConversationContext(history, schema.UserMessage("继续"), "", true)
	}
	preserved := 0
	for _, item := range history {
		if item.Preserve {
			preserved++
		}
	}
	if preserved != 4 {
		t.Fatal("retries pinned unbounded context")
	}
	history = appendConversationContext(history, schema.UserMessage("完成当前请求"), "已回复", false)
	for _, item := range history {
		if item.Preserve {
			t.Fatal("completed reply retained a pending anchor")
		}
	}
	summary := &agent.ContextSummary{ThroughSeq: 20, SourceEventIDs: []uint64{3, 4, 19, 20}}
	if summaryCoversTurn(summary, 1, 2) || summaryCoversTurn(summary, 3, 5) || !summaryCoversTurn(summary, 3, 4) {
		t.Fatal("summary coverage assumed contiguous sequence numbers")
	}
}

func TestBridgeManualCompactionKeepsTaskRequirementsOnReopen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "任务交接", "")
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	quote := "工作流需要能够自建目录分级拖拽移动"
	_, err = s.AppendConversationTurn(ctx, conversation.ID, quote, "先整理目录设计，尚未实现。", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var summaryCalls, mainCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools    []json.RawMessage `json:"tools"`
			Messages json.RawMessage   `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid fixture input")
		}
		w.Header().Set("Content-Type", "application/json")
		if len(body.Tools) == 0 {
			summaryCalls.Add(1)
			// Deliberately omit constraints: deterministic user quotes must win.
			state := `{"summary":"目录设计尚未实现。","task_state":{"version":1,"goals":[{"text":"工作流需要能够自建目录分级拖拽移动","source_event_ids":[1]}],"pending":[{"text":"目录分组与拖拽尚未实现","source_event_ids":[2]}],"constraints":[]}}`
			encoded, _ := json.Marshal(map[string]any{"content": []map[string]string{{"type": "text", "text": state}}})
			w.Write(encoded)
			return
		}
		mainCalls.Add(1)
		if !strings.Contains(string(body.Messages), quote) || !strings.Contains(string(body.Messages), "task_state") || !strings.Contains(string(body.Messages), "pending") || !strings.Contains(string(body.Messages), "source_event_ids") {
			t.Error("reopen lost structured task handoff")
		}
		io.WriteString(w, `{"content":[{"type":"text","text":"继续处理目录分组与拖拽需求。"}]}`)
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ContextWindow: 8192, MaxOutputTokens: 1024,
		ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previous := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previous })
	var output bytes.Buffer
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"compact","prompt":"/compact"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	if summaryCalls.Load() != 1 || mainCalls.Load() != 0 || !strings.Contains(output.String(), "已压缩会话上下文") {
		t.Fatal("manual compaction invoked the task or failed")
	}
	checkpoint, err := s.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || checkpoint.TaskState == nil || len(checkpoint.TaskState.Constraints) != 1 || checkpoint.TaskState.Constraints[0].Text != quote {
		t.Fatal("user constraint was not persisted", err)
	}
	output.Reset()
	if err := runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"continue","prompt":"继续"}`+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	if mainCalls.Load() != 1 || !strings.Contains(output.String(), "继续处理目录分组") {
		t.Fatal("reopened conversation did not continue the task")
	}
}

func TestBridgeRecallsOriginalHistoryAndRestoresSummaryGaps(t *testing.T) {
	for _, gap := range []bool{false, true} {
		t.Run(map[bool]string{false: "retrieve_after_summary", true: "restore_uncovered_turn"}[gap], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			root := t.TempDir()
			s, err := store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			lake, _ := s.CreateLake(ctx, "原文回查", "")
			if err = s.UseLake(ctx, lake.ID); err != nil {
				t.Fatal(err)
			}
			conversation, _ := s.CreateConversation(ctx, lake.Name)
			goal := "工作流目录需要自建、多级分组和拖拽移动"
			for _, prompt := range []string{goal, "完成其他事项", "旧任务结束"} {
				if _, err = s.AppendConversationTurn(ctx, conversation.ID, prompt, "已经记录", "", ""); err != nil {
					t.Fatal(err)
				}
			}
			sources := []uint64{1, 2, 3, 4, 5, 6}
			if gap {
				sources = []uint64{3, 4, 5, 6}
			}
			if err = s.SaveConversationSummary(ctx, conversation.ID, store.ConversationSummaryInput{ThroughSeq: 6, Text: "旧任务已经结束，细节可以回查原文。", SourceEventIDs: sources, TokenEstimate: 40}); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					t.Error("bad request")
				}
				raw, _ := json.Marshal(body["messages"])
				w.Header().Set("Content-Type", "application/json")
				if calls.Add(1) == 1 {
					if strings.Contains(string(raw), goal) != gap {
						t.Error("summary provenance gap was not respected")
					}
					io.WriteString(w, `{"content":[{"type":"tool_use","id":"recall-1","name":"lake_conversation_history","input":{"query":"工作流目录","limit":1}}],"stop_reason":"tool_use"}`)
					return
				}
				if !strings.Contains(string(raw), goal) || !strings.Contains(string(raw), "recall-1") {
					t.Error("history tool did not deliver stored original request")
				}
				io.WriteString(w, `{"content":[{"type":"text","text":"你要求目录自建、多级分组和拖拽移动，已从本会话原文核对。"}]}`)
			}))
			defer server.Close()
			if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ContextWindow: 8192, MaxOutputTokens: 1024, ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
				t.Fatal(err)
			}
			previous := modelKeys
			modelKeys = fakeModelKeys{}
			t.Cleanup(func() { modelKeys = previous })
			var output bytes.Buffer
			if err = runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(`{"type":"ask","id":"recall","prompt":"我之前对目录提过什么要求？"}`+"\n"), &output); err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 2 || !strings.Contains(output.String(), "从本会话原文核对") || !strings.Contains(output.String(), "lake_conversation_history") {
				t.Fatal("original history recall failed")
			}
		})
	}
}

func TestBridgeLargeScreenshotContinuesOversizedRecentConversation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "截图回归", "")
	if err = s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("已核验运行结果，保留原始记录。", 600)
	for i := 0; i < 3; i++ {
		if _, err = s.AppendConversationTurn(ctx, conversation.ID, "整理巡检", long, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	// A valid, poorly compressible image gives a large encoding without any
	// real user data or credentials. Keep it byte-for-byte through the bridge.
	img := image.NewRGBA(image.Rect(0, 0, 900, 600))
	seed := uint32(1)
	for y := 0; y < 600; y++ {
		for x := 0; x < 900; x++ {
			seed = seed*1664525 + 1013904223
			img.SetRGBA(x, y, color.RGBA{uint8(seed), uint8(seed >> 8), uint8(seed >> 16), 255})
		}
	}
	var encoded bytes.Buffer
	if err = png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	data := base64.StdEncoding.EncodeToString(encoded.Bytes())
	if len(data) < 200000 {
		t.Fatal("fixture no longer reproduces the transport-size bug")
	}
	summaries, answers := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools    []json.RawMessage `json:"tools"`
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request")
		}
		w.Header().Set("Content-Type", "application/json")
		if len(body.Tools) == 0 {
			summaries++
			_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"用户在整理已核验的巡检结果，原始记录已保留。"}]}`))
			return
		}
		answers++
		found := false
		for _, message := range body.Messages {
			var parts []struct {
				Type   string `json:"type"`
				Text   string `json:"text"`
				Source *struct {
					Data string `json:"data"`
				} `json:"source"`
			}
			if message.Role == "user" && json.Unmarshal(message.Content, &parts) == nil {
				for _, part := range parts {
					if part.Type == "image" && part.Source != nil && part.Source.Data == data {
						found = true
					}
				}
			}
		}
		if !found {
			t.Error("current screenshot lost or changed during compaction")
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"截图已收到，可以继续对话。"}]}`))
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ContextWindow: 8192, MaxOutputTokens: 1024, ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	previousKeys := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previousKeys })
	request, _ := json.Marshal(bridgeRequest{Type: "ask", ID: "continue", Prompt: "解释这张设置截图", Images: []store.ImageAttachment{{Name: "fixture.png", MIMEType: "image/png", Data: data}}})
	var output bytes.Buffer
	if err = runBridgeConversation(ctx, root, conversation.ID, strings.NewReader(string(request)+"\n"), &output); err != nil {
		t.Fatal(err)
	}
	if summaries < 2 || answers != 1 || !strings.Contains(output.String(), "截图已收到") || strings.Contains(output.String(), "input budget") {
		t.Fatalf("compaction did not recover: summary=%d answer=%d", summaries, answers)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 4 || turns[0].Answer != long || len(turns[3].Images) != 1 || turns[3].Images[0].Data != data || turns[3].Error != "" {
		t.Fatal("original history, image or final result lost")
	}
	summary, err := s.LatestConversationSummary(ctx, conversation.ID)
	if err != nil || summary == nil || len(summary.SourceEventIDs) != 6 || summary.ThroughSeq != 6 {
		t.Fatal("adaptive compaction provenance not persisted", err)
	}
}
