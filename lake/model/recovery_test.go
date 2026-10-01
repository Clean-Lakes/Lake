package model

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

type recoveryFixture struct {
	protocol, empty, answer, emptyStream, answerStream, partialStream, refusal, invalidTool string
}

var recoveryFixtures = []recoveryFixture{
	{
		protocol:      "anthropic",
		empty:         `{"content":[],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":1}}`,
		answer:        `{"content":[{"type":"text","text":"已恢复"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}`,
		emptyStream:   "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n\ndata: {\"type\":\"message_stop\"}\n\n",
		answerStream:  "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"已恢复\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n",
		partialStream: "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"部分内容\"}}\n\n",
		refusal:       `{"content":[],"stop_reason":"refusal"}`,
		invalidTool:   `{"content":[{"type":"tool_use","id":"invalid","name":"inspect","input":[]}],"stop_reason":"tool_use"}`,
	},
	{
		protocol:      "openai_chat",
		empty:         `{"choices":[{"message":{"content":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`,
		answer:        `{"choices":[{"message":{"content":"已恢复"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`,
		emptyStream:   "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n",
		answerStream:  "data: {\"choices\":[{\"delta\":{\"content\":\"已恢复\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n",
		partialStream: "data: {\"choices\":[{\"delta\":{\"content\":\"部分内容\"}}]}\n\n",
		refusal:       `{"choices":[{"message":{"content":null,"refusal":"fixture refusal"},"finish_reason":"stop"}]}`,
		invalidTool:   `{"choices":[{"message":{"tool_calls":[{"id":"invalid","function":{"name":"inspect","arguments":"[]"}}]},"finish_reason":"tool_calls"}]}`,
	},
	{
		protocol:      "openai_responses",
		empty:         `{"output":[],"status":"completed","usage":{"input_tokens":2,"output_tokens":1}}`,
		answer:        `{"output":[{"type":"message","content":[{"type":"output_text","text":"已恢复"}]}],"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}`,
		emptyStream:   "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n\n",
		answerStream:  "data: {\"type\":\"response.output_text.delta\",\"delta\":\"已恢复\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n",
		partialStream: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"部分内容\"}\n\n",
		refusal:       `{"output":[{"type":"message","content":[{"type":"refusal"}]}],"status":"completed"}`,
		invalidTool:   `{"output":[{"type":"function_call","call_id":"invalid","name":"inspect","arguments":"[]"}],"status":"completed"}`,
	},
}

func TestEmptyModelRecoveryKeepsMessagesImagesToolsAndUsage(t *testing.T) {
	for _, fixture := range recoveryFixtures {
		for _, streaming := range []bool{false, true} {
			name := fixture.protocol + "/generate"
			if streaming {
				name = fixture.protocol + "/stream"
			}
			t.Run(name, func(t *testing.T) {
				var requests atomic.Int32
				var firstBody []byte
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					body, _ := io.ReadAll(r.Body)
					if requests.Add(1) == 1 {
						firstBody = body
						if streaming {
							w.Header().Set("Content-Type", "text/event-stream")
							io.WriteString(w, fixture.emptyStream)
						} else {
							io.WriteString(w, fixture.empty)
						}
						return
					}
					if !bytes.Equal(body, firstBody) {
						t.Error("empty recovery changed context, image, tools or options")
					}
					if streaming {
						w.Header().Set("Content-Type", "text/event-stream")
						io.WriteString(w, fixture.answerStream)
					} else {
						io.WriteString(w, fixture.answer)
					}
				}))
				defer server.Close()
				meter := &UsageMeter{}
				adapter, err := New(Config{WireAPI: fixture.protocol, BaseURL: server.URL, Model: "fixture", APIKey: []byte("test-key"), Usage: meter})
				if err != nil {
					t.Fatal(err)
				}
				data := "fixture-image"
				image := schema.UserMessage("添加 MCP，参考图片")
				image.UserInputMultiContent = []schema.MessageInputPart{{Type: schema.ChatMessagePartTypeText, Text: image.Content}, {Type: schema.ChatMessagePartTypeImageURL, Image: &schema.MessageInputImage{MessagePartCommon: schema.MessagePartCommon{Base64Data: &data, MIMEType: "image/png"}}}}
				input := []*schema.Message{schema.SystemMessage("保持当前任务"), image, schema.AssistantMessage("", []schema.ToolCall{{ID: "already-executed", Type: "function", Function: schema.FunctionCall{Name: "inspect", Arguments: `{}`}}}), schema.ToolMessage("已取得真实记录", "already-executed"), schema.UserMessage("继续")}
				options := []einomodel.Option{einomodel.WithTools([]*schema.ToolInfo{{Name: "inspect"}}), einomodel.WithMaxTokens(321)}
				var text string
				if streaming {
					stream, streamErr := adapter.Stream(context.Background(), input, options...)
					if streamErr != nil {
						t.Fatal(streamErr)
					}
					defer stream.Close()
					for {
						chunk, recvErr := stream.Recv()
						if recvErr == io.EOF {
							break
						}
						if recvErr != nil {
							t.Fatal(recvErr)
						}
						text += chunk.Content
					}
				} else {
					answer, generateErr := adapter.Generate(context.Background(), input, options...)
					if generateErr != nil {
						t.Fatal(generateErr)
					}
					text = answer.Content
				}
				if requests.Load() != 2 || text != "已恢复" || meter.Snapshot().Calls != 2 || meter.Snapshot().TotalTokens() != 8 || *image.UserInputMultiContent[1].Image.Base64Data != data {
					t.Fatalf("invalid recovery: calls=%d usage=%+v", requests.Load(), meter.Snapshot())
				}
			})
		}
	}
}

func TestEmptyModelRecoveryStopsAfterOneRetry(t *testing.T) {
	for _, fixture := range recoveryFixtures {
		for _, streaming := range []bool{false, true} {
			name := fixture.protocol + "/generate"
			if streaming {
				name = fixture.protocol + "/stream"
			}
			t.Run(name, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if streaming {
						w.Header().Set("Content-Type", "text/event-stream")
						io.WriteString(w, fixture.emptyStream)
					} else {
						io.WriteString(w, fixture.empty)
					}
				}))
				defer server.Close()
				meter := &UsageMeter{}
				adapter, _ := New(Config{WireAPI: fixture.protocol, BaseURL: server.URL, Model: "fixture", APIKey: []byte("test-key"), Usage: meter})
				var err error
				if streaming {
					stream, openErr := adapter.Stream(context.Background(), []*schema.Message{schema.UserMessage("继续")})
					if openErr != nil {
						t.Fatal(openErr)
					}
					defer stream.Close()
					_, err = stream.Recv()
				} else {
					_, err = adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("继续")})
				}
				var empty *EmptyResponseError
				if !errors.As(err, &empty) || empty.Attempts != 2 || !strings.Contains(err.Error(), "已自动重试1次") || calls.Load() != 2 || meter.Snapshot().Calls != 2 {
					t.Fatal("recovery was unbounded or failure was hidden", err)
				}
			})
		}
	}
}

func TestAnthropicThinkingExhaustionDisablesThinkingOnlyForRetry(t *testing.T) {
	var calls atomic.Int32
	var first map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		json.NewDecoder(r.Body).Decode(&body)
		if calls.Add(1) == 1 {
			first = body
			io.WriteString(w, `{"content":[{"type":"thinking","thinking":"hidden fixture thought"}],"stop_reason":"max_tokens","usage":{"input_tokens":5,"output_tokens":100}}`)
			return
		}
		if string(body["thinking"]) != `{"type":"disabled"}` || !bytes.Equal(body["messages"], first["messages"]) || !bytes.Equal(body["tools"], first["tools"]) || string(body["max_tokens"]) != "100" {
			t.Error("thinking recovery altered task or output limit")
		}
		io.WriteString(w, `{"content":[{"type":"tool_use","id":"new-call","name":"inspect","input":{}}],"stop_reason":"tool_use"}`)
	}))
	defer server.Close()
	adapter := &Anthropic{BaseURL: server.URL, Model: "fixture", APIKey: []byte("test-key"), ReasoningEffort: "high"}
	answer, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("处理原任务")}, einomodel.WithMaxTokens(100), einomodel.WithTools([]*schema.ToolInfo{{Name: "inspect"}}))
	if err != nil || len(answer.ToolCalls) != 1 || answer.Content != "" || adapter.ReasoningEffort != "high" || calls.Load() != 2 {
		t.Fatal("thinking-only reply was mistaken for a final answer", err)
	}
}

func TestModelRecoveryDoesNotRetryRefusalHTTPOrInvalidTool(t *testing.T) {
	for _, fixture := range recoveryFixtures {
		for _, failure := range []string{"refusal", "http", "invalid_tool", "invalid_json"} {
			t.Run(fixture.protocol+"/"+failure, func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					response := fixture.refusal
					if failure == "http" {
						w.WriteHeader(503)
						response = `{"error":"fixture-sensitive-provider-body"}`
					} else if failure == "invalid_tool" {
						response = fixture.invalidTool
					} else if failure == "invalid_json" {
						response = "{"
					}
					io.WriteString(w, response)
				}))
				defer server.Close()
				adapter, _ := New(Config{WireAPI: fixture.protocol, BaseURL: server.URL, Model: "fixture", APIKey: []byte("test-key")})
				_, err := adapter.Generate(context.Background(), []*schema.Message{schema.UserMessage("继续")})
				if err == nil || calls.Load() != 1 || strings.Contains(err.Error(), "fixture-sensitive-provider-body") || strings.Contains(err.Error(), "fixture refusal") {
					t.Fatal("non-recoverable reply was retried or provider body leaked", err)
				}
			})
		}
	}
}

func TestStreamRecoveryNeverRepeatsPartialOutput(t *testing.T) {
	for _, fixture := range recoveryFixtures {
		t.Run(fixture.protocol, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, fixture.partialStream)
			}))
			defer server.Close()
			adapter, _ := New(Config{WireAPI: fixture.protocol, BaseURL: server.URL, Model: "fixture", APIKey: []byte("test-key")})
			stream, err := adapter.Stream(context.Background(), []*schema.Message{schema.UserMessage("继续")})
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			chunk, err := stream.Recv()
			if err != nil || chunk.Content != "部分内容" {
				t.Fatal("lost partial output", err)
			}
			_, err = stream.Recv()
			if err == nil || err == io.EOF || calls.Load() != 1 {
				t.Fatal("partial stream was replayed or failure hidden", err)
			}
		})
	}
}

func TestModelRecoveryHonorsCancellationAndHidesUnknownStopReason(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_, err := generateWithRecovery(ctx, func(*EmptyResponseError) (*schema.Message, error) {
		calls++
		cancel()
		return nil, emptyResponse("", false)
	})
	if !errors.Is(err, context.Canceled) || calls != 1 {
		t.Fatal("cancelled generation retried", err)
	}
	err = emptyResponse("fixture-sensitive-provider-body", true)
	if strings.Contains(err.Error(), "fixture-sensitive-provider-body") || retryableEmpty(err) != nil {
		t.Fatal("unknown provider status leaked or was retried")
	}
	if hasReasoningText(json.RawMessage(`" "`)) || hasReasoningText(json.RawMessage(`null`)) || !hasReasoningText(json.RawMessage(`"fixture thought"`)) {
		t.Fatal("empty reasoning field misclassified as token exhaustion")
	}
	streamCtx, stop := context.WithCancel(context.Background())
	streamCalls := 0
	_, err = streamWithRecovery(streamCtx, func(*EmptyResponseError) (*schema.StreamReader[*schema.Message], error) {
		streamCalls++
		stop()
		return schema.StreamReaderFromArray([]*schema.Message{}), nil
	})
	if !errors.Is(err, context.Canceled) || streamCalls != 1 {
		t.Fatal("cancelled stream started recovery", err)
	}
}
