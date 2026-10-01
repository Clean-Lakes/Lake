package model

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

type OpenAIChat struct{ Config }

func encodeChatMessages(input []*schema.Message) ([]map[string]any, error) {
	result := make([]map[string]any, 0, len(input))
	for _, msg := range input {
		if msg == nil {
			continue
		}
		switch msg.Role {
		case schema.System:
			result = append(result, map[string]any{"role": "system", "content": msg.Content})
		case schema.User:
			content := any(msg.Content)
			if len(msg.UserInputMultiContent) != 0 {
				parts := make([]any, 0, len(msg.UserInputMultiContent))
				for _, part := range msg.UserInputMultiContent {
					switch part.Type {
					case schema.ChatMessagePartTypeText:
						parts = append(parts, map[string]any{"type": "text", "text": part.Text})
					case schema.ChatMessagePartTypeImageURL:
						if part.Image == nil || part.Image.Base64Data == nil || part.Image.MIMEType == "" {
							return nil, errors.New("图片消息缺少内容或格式")
						}
						parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + part.Image.MIMEType + ";base64," + *part.Image.Base64Data}})
					default:
						return nil, fmt.Errorf("不支持的用户消息内容类型 %q", part.Type)
					}
				}
				content = parts
			}
			result = append(result, map[string]any{"role": "user", "content": content})
		case schema.Assistant:
			item := map[string]any{"role": "assistant", "content": msg.Content}
			if len(msg.ToolCalls) != 0 {
				calls := make([]any, 0, len(msg.ToolCalls))
				for _, call := range msg.ToolCalls {
					if !json.Valid([]byte(call.Function.Arguments)) {
						return nil, fmt.Errorf("无效的工具调用参数: %s", call.Function.Name)
					}
					calls = append(calls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Function.Name, "arguments": call.Function.Arguments}})
				}
				item["tool_calls"] = calls
			}
			result = append(result, item)
		case schema.Tool:
			result = append(result, map[string]any{"role": "tool", "tool_call_id": msg.ToolCallID, "content": msg.Content})
		default:
			return nil, fmt.Errorf("不支持的模型消息角色 %q", msg.Role)
		}
	}
	return result, nil
}

func (a *OpenAIChat) requestBody(input []*schema.Message, streaming bool, opts ...einomodel.Option) ([]byte, error) {
	if a == nil {
		return nil, errors.New("模型未配置完整")
	}
	messages, err := encodeChatMessages(input)
	if err != nil {
		return nil, err
	}
	modelName, maxTokens, options := a.modelAndLimit(opts)
	body := map[string]any{"model": modelName, "max_completion_tokens": maxTokens, "messages": messages}
	if streaming {
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if a.ReasoningEffort != "" && a.ReasoningEffort != "none" {
		body["reasoning_effort"] = a.ReasoningEffort
	}
	if len(options.Tools) != 0 {
		tools, err := toolDefinitions(options.Tools, false)
		if err != nil {
			return nil, err
		}
		body["tools"] = tools
	}
	if options.ToolChoice != nil {
		switch *options.ToolChoice {
		case schema.ToolChoiceForbidden:
			body["tool_choice"] = "none"
		case schema.ToolChoiceForced:
			body["tool_choice"] = "required"
		}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func (a *OpenAIChat) Generate(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.Message, error) {
	return generateWithRecovery(ctx, func(*EmptyResponseError) (*schema.Message, error) {
		return a.generateOnce(ctx, input, opts...)
	})
}

func (a *OpenAIChat) generateOnce(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.Message, error) {
	encoded, err := a.requestBody(input, false, opts...)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	resp, err := a.post(ctx, "/v1/chat/completions", encoded)
	if err != nil {
		return nil, err
	}
	var result struct {
		Choices []struct {
			Message struct {
				Content          string          `json:"content"`
				Refusal          string          `json:"refusal"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *openAIUsage `json:"usage"`
	}
	if err := readModelJSON(resp, &result); err != nil {
		return nil, err
	}
	output, _ := json.Marshal(result.Choices)
	a.Usage.record(result.Usage.toWire(false), time.Since(started), estimateTokenBytes(len(encoded)), estimateTokenBytes(len(output)))
	if len(result.Choices) == 0 {
		return nil, emptyResponse("", false)
	}
	choice := result.Choices[0]
	calls := make([]schema.ToolCall, 0, len(choice.Message.ToolCalls))
	for _, call := range choice.Message.ToolCalls {
		if call.ID == "" || call.Function.Name == "" || !json.Valid([]byte(call.Function.Arguments)) || !strings.HasPrefix(strings.TrimSpace(call.Function.Arguments), "{") {
			return nil, errors.New("模型返回无效工具调用")
		}
		calls = append(calls, schema.ToolCall{ID: call.ID, Type: "function", Function: schema.FunctionCall{Name: call.Function.Name, Arguments: call.Function.Arguments}})
	}
	if strings.TrimSpace(choice.Message.Content) == "" && len(calls) == 0 {
		stop := choice.FinishReason
		if choice.Message.Refusal != "" {
			stop = "refusal"
		}
		return nil, emptyResponse(stop, hasReasoningText(choice.Message.ReasoningContent))
	}
	answer := schema.AssistantMessage(choice.Message.Content, calls)
	answer.ResponseMeta = responseMeta(result.Usage, false, choice.FinishReason)
	return answer, nil
}

func (a *OpenAIChat) Stream(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.StreamReader[*schema.Message], error) {
	return streamWithRecovery(ctx, func(*EmptyResponseError) (*schema.StreamReader[*schema.Message], error) {
		return a.streamOnce(ctx, input, opts...)
	})
}

func (a *OpenAIChat) streamOnce(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.StreamReader[*schema.Message], error) {
	encoded, err := a.requestBody(input, true, opts...)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	resp, err := a.post(ctx, "/v1/chat/completions", encoded)
	if err != nil {
		return nil, err
	}
	reader, writer := schema.Pipe[*schema.Message](2)
	go func() {
		defer writer.Close()
		type pendingCall struct{ id, name, args string }
		calls := map[int]*pendingCall{}
		var usage *openAIUsage
		var textBytes int
		var stopReason string
		hasText, reasoningOnly, refused := false, false, false
		usageRecorded := false
		recordUsage := func() {
			if usageRecorded {
				return
			}
			usageRecorded = true
			a.Usage.record(usage.toWire(false), time.Since(started), estimateTokenBytes(len(encoded)), estimateTokenBytes(textBytes))
		}
		defer recordUsage()
		sendError := func(sendErr error) { recordUsage(); writer.Send(nil, sendErr) }
		stopped, err := readSSE(resp.Body, func(payload []byte) (bool, error) {
			var chunk struct {
				Choices []struct {
					FinishReason string `json:"finish_reason"`
					Delta        struct {
						Content          string          `json:"content"`
						Refusal          string          `json:"refusal"`
						ReasoningContent json.RawMessage `json:"reasoning_content"`
						ToolCalls        []struct {
							Index    int    `json:"index"`
							ID       string `json:"id"`
							Function struct {
								Name      string `json:"name"`
								Arguments string `json:"arguments"`
							} `json:"function"`
						} `json:"tool_calls"`
					} `json:"delta"`
				} `json:"choices"`
				Usage *openAIUsage `json:"usage"`
			}
			if err := json.Unmarshal(payload, &chunk); err != nil {
				return false, errors.New("解析模型流失败")
			}
			if chunk.Usage != nil {
				usage = chunk.Usage
			}
			for _, choice := range chunk.Choices {
				if choice.FinishReason != "" {
					stopReason = choice.FinishReason
				}
				refused = refused || choice.Delta.Refusal != ""
				reasoningOnly = reasoningOnly || hasReasoningText(choice.Delta.ReasoningContent)
				if choice.Delta.Content != "" {
					hasText = hasText || strings.TrimSpace(choice.Delta.Content) != ""
					textBytes += len(choice.Delta.Content)
					if writer.Send(schema.AssistantMessage(choice.Delta.Content, nil), nil) {
						return true, nil
					}
				}
				for _, call := range choice.Delta.ToolCalls {
					item := calls[call.Index]
					if item == nil {
						item = &pendingCall{}
						calls[call.Index] = item
					}
					if call.ID != "" {
						item.id = call.ID
					}
					if call.Function.Name != "" {
						item.name = call.Function.Name
					}
					item.args += call.Function.Arguments
				}
			}
			return false, nil
		})
		if err != nil {
			sendError(err)
			return
		}
		if !stopped {
			sendError(errors.New("模型流提前结束"))
			return
		}
		indexes := make([]int, 0, len(calls))
		for index := range calls {
			indexes = append(indexes, index)
		}
		sort.Ints(indexes)
		finalCalls := make([]schema.ToolCall, 0, len(indexes))
		for _, index := range indexes {
			call := calls[index]
			if call.id == "" || call.name == "" || !json.Valid([]byte(call.args)) || !strings.HasPrefix(strings.TrimSpace(call.args), "{") {
				sendError(errors.New("模型返回无效工具调用"))
				return
			}
			finalCalls = append(finalCalls, schema.ToolCall{ID: call.id, Type: "function", Function: schema.FunctionCall{Name: call.name, Arguments: call.args}})
			textBytes += len(call.args)
		}
		if !hasText && len(finalCalls) == 0 {
			if refused {
				stopReason = "refusal"
			}
			sendError(emptyResponse(stopReason, reasoningOnly))
			return
		}
		final := schema.AssistantMessage("", finalCalls)
		final.ResponseMeta = responseMeta(usage, false, stopReason)
		recordUsage()
		writer.Send(final, nil)
	}()
	return reader, nil
}
