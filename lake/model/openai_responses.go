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

type OpenAIResponses struct{ Config }

func encodeResponseInput(input []*schema.Message) ([]any, error) {
	result := make([]any, 0, len(input))
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
						parts = append(parts, map[string]any{"type": "input_text", "text": part.Text})
					case schema.ChatMessagePartTypeImageURL:
						if part.Image == nil || part.Image.Base64Data == nil || part.Image.MIMEType == "" {
							return nil, errors.New("图片消息缺少内容或格式")
						}
						parts = append(parts, map[string]any{"type": "input_image", "image_url": "data:" + part.Image.MIMEType + ";base64," + *part.Image.Base64Data})
					default:
						return nil, fmt.Errorf("不支持的用户消息内容类型 %q", part.Type)
					}
				}
				content = parts
			}
			result = append(result, map[string]any{"role": "user", "content": content})
		case schema.Assistant:
			if msg.Content != "" {
				result = append(result, map[string]any{"role": "assistant", "content": msg.Content})
			}
			for _, call := range msg.ToolCalls {
				if !json.Valid([]byte(call.Function.Arguments)) {
					return nil, fmt.Errorf("无效的工具调用参数: %s", call.Function.Name)
				}
				result = append(result, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Function.Name, "arguments": call.Function.Arguments})
			}
		case schema.Tool:
			result = append(result, map[string]any{"type": "function_call_output", "call_id": msg.ToolCallID, "output": msg.Content})
		default:
			return nil, fmt.Errorf("不支持的模型消息角色 %q", msg.Role)
		}
	}
	return result, nil
}

func (a *OpenAIResponses) requestBody(input []*schema.Message, streaming bool, opts ...einomodel.Option) ([]byte, error) {
	if a == nil {
		return nil, errors.New("模型未配置完整")
	}
	items, err := encodeResponseInput(input)
	if err != nil {
		return nil, err
	}
	modelName, maxTokens, options := a.modelAndLimit(opts)
	body := map[string]any{"model": modelName, "max_output_tokens": maxTokens, "input": items}
	if streaming {
		body["stream"] = true
	}
	if a.ReasoningEffort != "" && a.ReasoningEffort != "none" {
		body["reasoning"] = map[string]any{"effort": a.ReasoningEffort}
	}
	if len(options.Tools) != 0 {
		tools, err := toolDefinitions(options.Tools, true)
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

func (a *OpenAIResponses) Generate(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.Message, error) {
	return generateWithRecovery(ctx, func(*EmptyResponseError) (*schema.Message, error) {
		return a.generateOnce(ctx, input, opts...)
	})
}

func (a *OpenAIResponses) generateOnce(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.Message, error) {
	encoded, err := a.requestBody(input, false, opts...)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	resp, err := a.post(ctx, "/v1/responses", encoded)
	if err != nil {
		return nil, err
	}
	var result struct {
		Output []struct {
			Type      string `json:"type"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
			Content   []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Usage  *openAIUsage `json:"usage"`
		Status string       `json:"status"`
	}
	if err := readModelJSON(resp, &result); err != nil {
		return nil, err
	}
	output, _ := json.Marshal(result.Output)
	a.Usage.record(result.Usage.toWire(true), time.Since(started), estimateTokenBytes(len(encoded)), estimateTokenBytes(len(output)))
	if result.Status == "failed" || result.Status == "cancelled" {
		return nil, emptyResponse(result.Status, false)
	}
	var text strings.Builder
	var calls []schema.ToolCall
	reasoningOnly, refused := false, false
	for _, item := range result.Output {
		switch item.Type {
		case "message":
			for _, part := range item.Content {
				if part.Type == "output_text" {
					text.WriteString(part.Text)
				}
				refused = refused || part.Type == "refusal"
			}
		case "function_call":
			if item.CallID == "" || item.Name == "" || !json.Valid([]byte(item.Arguments)) || !strings.HasPrefix(strings.TrimSpace(item.Arguments), "{") {
				return nil, errors.New("模型返回无效工具调用")
			}
			calls = append(calls, schema.ToolCall{ID: item.CallID, Type: "function", Function: schema.FunctionCall{Name: item.Name, Arguments: item.Arguments}})
		case "reasoning":
			reasoningOnly = true
		}
	}
	if strings.TrimSpace(text.String()) == "" && len(calls) == 0 {
		stop := result.Status
		if refused {
			stop = "refusal"
		}
		return nil, emptyResponse(stop, reasoningOnly)
	}
	answer := schema.AssistantMessage(text.String(), calls)
	answer.ResponseMeta = responseMeta(result.Usage, true, result.Status)
	return answer, nil
}

func (a *OpenAIResponses) Stream(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.StreamReader[*schema.Message], error) {
	return streamWithRecovery(ctx, func(*EmptyResponseError) (*schema.StreamReader[*schema.Message], error) {
		return a.streamOnce(ctx, input, opts...)
	})
}

func (a *OpenAIResponses) streamOnce(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.StreamReader[*schema.Message], error) {
	encoded, err := a.requestBody(input, true, opts...)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	resp, err := a.post(ctx, "/v1/responses", encoded)
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
		status := "completed"
		hasText, reasoningOnly, refused := false, false, false
		usageRecorded := false
		recordUsage := func() {
			if usageRecorded {
				return
			}
			usageRecorded = true
			a.Usage.record(usage.toWire(true), time.Since(started), estimateTokenBytes(len(encoded)), estimateTokenBytes(textBytes))
		}
		defer recordUsage()
		sendError := func(sendErr error) { recordUsage(); writer.Send(nil, sendErr) }
		stopped, err := readSSE(resp.Body, func(payload []byte) (bool, error) {
			var event struct {
				Type        string `json:"type"`
				Delta       string `json:"delta"`
				OutputIndex int    `json:"output_index"`
				Arguments   string `json:"arguments"`
				Item        struct {
					Type      string `json:"type"`
					CallID    string `json:"call_id"`
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"item"`
				Response struct {
					Usage *openAIUsage `json:"usage"`
				} `json:"response"`
			}
			if err := json.Unmarshal(payload, &event); err != nil {
				return false, errors.New("解析模型流失败")
			}
			switch event.Type {
			case "response.output_text.delta":
				hasText = hasText || strings.TrimSpace(event.Delta) != ""
				textBytes += len(event.Delta)
				if event.Delta != "" && writer.Send(schema.AssistantMessage(event.Delta, nil), nil) {
					return true, nil
				}
			case "response.output_item.added", "response.output_item.done":
				reasoningOnly = reasoningOnly || event.Item.Type == "reasoning"
				if event.Item.Type == "function_call" {
					item := calls[event.OutputIndex]
					if item == nil {
						item = &pendingCall{}
						calls[event.OutputIndex] = item
					}
					if event.Item.CallID != "" {
						item.id = event.Item.CallID
					}
					if event.Item.Name != "" {
						item.name = event.Item.Name
					}
					if event.Item.Arguments != "" {
						item.args = event.Item.Arguments
					}
				}
			case "response.function_call_arguments.delta":
				item := calls[event.OutputIndex]
				if item == nil {
					item = &pendingCall{}
					calls[event.OutputIndex] = item
				}
				item.args += event.Delta
			case "response.function_call_arguments.done":
				item := calls[event.OutputIndex]
				if item == nil {
					item = &pendingCall{}
					calls[event.OutputIndex] = item
				}
				item.args = event.Arguments
			case "response.refusal.delta", "response.refusal.done":
				refused = true
			case "response.completed", "response.incomplete":
				if event.Type == "response.incomplete" {
					status = "incomplete"
				}
				usage = event.Response.Usage
				return true, nil
			case "response.failed", "error":
				return false, errors.New("模型流执行失败")
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
				status = "refusal"
			}
			sendError(emptyResponse(status, reasoningOnly))
			return
		}
		final := schema.AssistantMessage("", finalCalls)
		final.ResponseMeta = responseMeta(usage, true, status)
		recordUsage()
		writer.Send(final, nil)
	}()
	return reader, nil
}
