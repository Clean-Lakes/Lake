package model

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

// Anthropic is the Anthropic Messages protocol adapter used by Lake Agent.
// It keeps model credentials inside the transport and never exposes them to tools.
type Anthropic struct {
	BaseURL         string
	Model           string
	APIKey          []byte
	Client          *http.Client
	ReasoningEffort string
	MaxOutputTokens int
	Usage           *UsageMeter
}

type wireMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

type wireTool struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema any    `json:"input_schema"`
}

type wireBlock struct {
	Type      string           `json:"type"`
	Text      string           `json:"text,omitempty"`
	ID        string           `json:"id,omitempty"`
	Name      string           `json:"name,omitempty"`
	Input     json.RawMessage  `json:"input,omitempty"`
	ToolUseID string           `json:"tool_use_id,omitempty"`
	Content   string           `json:"content,omitempty"`
	Source    *wireImageSource `json:"source,omitempty"`
}

type wireImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

func (a *Anthropic) requestBody(input []*schema.Message, streaming bool, opts ...einomodel.Option) ([]byte, error) {
	if a == nil || a.Model == "" || a.BaseURL == "" || len(a.APIKey) == 0 {
		return nil, errors.New("模型未配置完整")
	}
	options := einomodel.GetCommonOptions(nil, opts...)
	system, messages, err := encodeMessages(input)
	if err != nil {
		return nil, err
	}
	maxTokens := 4096
	if a.MaxOutputTokens > 0 {
		maxTokens = a.MaxOutputTokens
	}
	if options.MaxTokens != nil {
		maxTokens = *options.MaxTokens
	}
	modelName := a.Model
	if options.Model != nil {
		modelName = *options.Model
	}
	requestBody := map[string]any{
		"model": modelName, "max_tokens": maxTokens, "system": system, "messages": messages,
	}
	if streaming {
		requestBody["stream"] = true
	}
	if a.ReasoningEffort != "" {
		switch a.ReasoningEffort {
		case "none":
			requestBody["thinking"] = map[string]string{"type": "disabled"}
		case "minimal", "low", "medium", "high", "xhigh", "max", "ultra":
			requestBody["thinking"] = map[string]string{"type": "enabled"}
		default:
			return nil, fmt.Errorf("不支持的 model_reasoning_effort %q", a.ReasoningEffort)
		}
	}
	if len(options.Tools) > 0 {
		tools := make([]wireTool, 0, len(options.Tools))
		for _, info := range options.Tools {
			inputSchema := any(map[string]any{"type": "object", "properties": map[string]any{}})
			if info.ParamsOneOf != nil {
				value, err := info.ParamsOneOf.ToJSONSchema()
				if err != nil {
					return nil, fmt.Errorf("工具 %s 的参数定义无效: %w", info.Name, err)
				}
				inputSchema = value
			}
			tools = append(tools, wireTool{Name: info.Name, Description: info.Desc, InputSchema: inputSchema})
		}
		requestBody["tools"] = tools
	}
	if options.ToolChoice != nil {
		switch *options.ToolChoice {
		case schema.ToolChoiceForbidden:
			requestBody["tool_choice"] = map[string]string{"type": "none"}
		case schema.ToolChoiceForced:
			requestBody["tool_choice"] = map[string]string{"type": "any"}
		}
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func (a *Anthropic) request(ctx context.Context, body []byte) (*http.Response, error) {
	endpoint, err := messagesURL(a.BaseURL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("x-api-key", string(a.APIKey))
	client := a.Client
	if client == nil {
		client = &http.Client{Timeout: 180 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("模型请求失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Avoid reflecting provider error bodies: some gateways echo request headers.
		resp.Body.Close()
		return nil, fmt.Errorf("模型服务返回 HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

func (a *Anthropic) Generate(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.Message, error) {
	return generateWithRecovery(ctx, func(previous *EmptyResponseError) (*schema.Message, error) {
		attempt := a
		if a != nil && previous != nil && previous.ReasoningOnly && previous.truncated() {
			copy := *a
			copy.ReasoningEffort = "none"
			attempt = &copy
		}
		return attempt.generateOnce(ctx, input, opts...)
	})
}

func (a *Anthropic) generateOnce(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.Message, error) {
	body, err := a.requestBody(input, false, opts...)
	if err != nil {
		return nil, err
	}
	requestStarted := time.Now()
	resp, err := a.request(ctx, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result struct {
		Content []json.RawMessage `json:"content"`
		Usage   *wireUsage        `json:"usage"`
		Stop    string            `json:"stop_reason"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&result); err != nil {
		return nil, fmt.Errorf("解析模型响应: %w", err)
	}
	estimatedOutput := 0
	for _, block := range result.Content {
		estimatedOutput += len(block)
	}
	a.Usage.record(result.Usage, time.Since(requestStarted), estimateTokenBytes(len(body)), estimateTokenBytes(estimatedOutput))
	var text strings.Builder
	var calls []schema.ToolCall
	reasoningOnly := len(result.Content) > 0
	hasReasoning := false
	for _, raw := range result.Content {
		var block wireBlock
		if err := json.Unmarshal(raw, &block); err != nil {
			return nil, fmt.Errorf("解析模型内容块: %w", err)
		}
		switch block.Type {
		case "text":
			text.WriteString(block.Text)
			reasoningOnly = reasoningOnly && strings.TrimSpace(block.Text) == ""
		case "tool_use":
			args := block.Input
			if len(args) == 0 {
				args = json.RawMessage("{}")
			}
			if block.ID == "" || block.Name == "" || !json.Valid(args) || !strings.HasPrefix(strings.TrimSpace(string(args)), "{") {
				return nil, errors.New("模型返回无效工具调用")
			}
			calls = append(calls, schema.ToolCall{
				ID: block.ID, Type: "function",
				Function: schema.FunctionCall{Name: block.Name, Arguments: string(args)},
			})
		case "thinking", "redacted_thinking":
			hasReasoning = true
		default:
			reasoningOnly = false
		}
	}
	if strings.TrimSpace(text.String()) == "" && len(calls) == 0 {
		return nil, emptyResponse(result.Stop, reasoningOnly && hasReasoning)
	}
	answer := schema.AssistantMessage(text.String(), calls)
	if result.Usage != nil {
		input := result.Usage.InputTokens + result.Usage.CacheReadInputTokens + result.Usage.CacheCreationInputTokens
		answer.ResponseMeta = &schema.ResponseMeta{
			FinishReason: result.Stop,
			Usage: &schema.TokenUsage{
				PromptTokens: int(input), CompletionTokens: int(result.Usage.OutputTokens),
				TotalTokens: int(input + result.Usage.OutputTokens),
				PromptTokenDetails: schema.PromptTokenDetails{
					CachedTokens:     int(result.Usage.CacheReadInputTokens),
					CacheWriteTokens: int(result.Usage.CacheCreationInputTokens),
				},
			},
		}
	} else if result.Stop != "" {
		answer.ResponseMeta = &schema.ResponseMeta{FinishReason: result.Stop}
	}
	// Preserve thinking/signature blocks exactly when a subsequent tool result
	// requires this assistant message to be sent back to MiMo.
	rawBlocks, err := json.Marshal(result.Content)
	if err == nil {
		answer.Extra = map[string]any{"anthropic_content": json.RawMessage(rawBlocks)}
	}
	return answer, nil
}

func estimateTokenBytes(bytes int) int64 {
	if bytes <= 0 {
		return 0
	}
	return int64((bytes + 3) / 4)
}

func (a *Anthropic) Stream(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.StreamReader[*schema.Message], error) {
	return streamWithRecovery(ctx, func(previous *EmptyResponseError) (*schema.StreamReader[*schema.Message], error) {
		attempt := a
		if a != nil && previous != nil && previous.ReasoningOnly && previous.truncated() {
			copy := *a
			copy.ReasoningEffort = "none"
			attempt = &copy
		}
		return attempt.streamOnce(ctx, input, opts...)
	})
}

func (a *Anthropic) streamOnce(ctx context.Context, input []*schema.Message, opts ...einomodel.Option) (*schema.StreamReader[*schema.Message], error) {
	body, err := a.requestBody(input, true, opts...)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	resp, err := a.request(ctx, body)
	if err != nil {
		return nil, err
	}
	reader, writer := schema.Pipe[*schema.Message](2)
	go func() {
		defer writer.Close()
		type block struct {
			kind, id, name, args, text, thinking, signature string
			raw                                             map[string]any
		}
		blocks := map[int]*block{}
		usage := &wireUsage{}
		hasUsage, stopped := false, false
		var stopReason string
		var outputBytes int
		usageRecorded := false
		recordUsage := func() {
			if usageRecorded {
				return
			}
			usageRecorded = true
			var recorded *wireUsage
			if hasUsage {
				recorded = usage
			}
			a.Usage.record(recorded, time.Since(started), estimateTokenBytes(len(body)), estimateTokenBytes(outputBytes))
		}
		defer recordUsage()
		sendError := func(sendErr error) { recordUsage(); writer.Send(nil, sendErr) }
		_, err := readSSE(resp.Body, func(payload []byte) (bool, error) {
			var event struct {
				Type         string          `json:"type"`
				Index        int             `json:"index"`
				ContentBlock json.RawMessage `json:"content_block"`
				Delta        struct {
					Type        string `json:"type"`
					Text        string `json:"text"`
					PartialJSON string `json:"partial_json"`
					Thinking    string `json:"thinking"`
					Signature   string `json:"signature"`
					StopReason  string `json:"stop_reason"`
				} `json:"delta"`
				Message struct {
					Usage *wireUsage `json:"usage"`
				} `json:"message"`
				Usage *wireUsage `json:"usage"`
			}
			if err := json.Unmarshal(payload, &event); err != nil {
				return false, errors.New("解析模型流失败")
			}
			switch event.Type {
			case "message_start":
				if event.Message.Usage != nil {
					*usage = *event.Message.Usage
					hasUsage = true
				}
			case "content_block_start":
				var raw map[string]any
				if err := json.Unmarshal(event.ContentBlock, &raw); err != nil {
					return false, errors.New("解析模型内容块失败")
				}
				item := &block{raw: raw}
				item.kind, _ = raw["type"].(string)
				item.id, _ = raw["id"].(string)
				item.name, _ = raw["name"].(string)
				item.text, _ = raw["text"].(string)
				item.thinking, _ = raw["thinking"].(string)
				blocks[event.Index] = item
				if item.kind == "text" && item.text != "" {
					outputBytes += len(item.text)
					if writer.Send(schema.AssistantMessage(item.text, nil), nil) {
						return true, nil
					}
				}
			case "content_block_delta":
				item := blocks[event.Index]
				if item == nil {
					return false, errors.New("模型内容块顺序无效")
				}
				switch event.Delta.Type {
				case "text_delta":
					item.text += event.Delta.Text
					outputBytes += len(event.Delta.Text)
					if event.Delta.Text != "" && writer.Send(schema.AssistantMessage(event.Delta.Text, nil), nil) {
						return true, nil
					}
				case "input_json_delta":
					item.args += event.Delta.PartialJSON
				case "thinking_delta":
					item.thinking += event.Delta.Thinking
				case "signature_delta":
					item.signature = event.Delta.Signature
				}
			case "message_delta":
				stopReason = event.Delta.StopReason
				if event.Usage != nil {
					usage.OutputTokens = event.Usage.OutputTokens
					hasUsage = true
				}
			case "message_stop":
				stopped = true
				return true, nil
			case "error":
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
		indexes := make([]int, 0, len(blocks))
		for index := range blocks {
			indexes = append(indexes, index)
		}
		sort.Ints(indexes)
		var rawBlocks []map[string]any
		var calls []schema.ToolCall
		hasText, hasReasoning, reasoningOnly := false, false, len(blocks) > 0
		for _, index := range indexes {
			item := blocks[index]
			switch item.kind {
			case "text":
				item.raw["text"] = item.text
				hasText = hasText || strings.TrimSpace(item.text) != ""
			case "tool_use":
				args := item.args
				if args == "" {
					args = "{}"
					if initial := item.raw["input"]; initial != nil {
						encoded, _ := json.Marshal(initial)
						args = string(encoded)
					}
				}
				if item.id == "" || item.name == "" || !json.Valid([]byte(args)) || !strings.HasPrefix(strings.TrimSpace(args), "{") {
					sendError(errors.New("模型返回无效工具调用"))
					return
				}
				var parsed any
				if err := json.Unmarshal([]byte(args), &parsed); err != nil {
					sendError(errors.New("模型返回无效工具调用"))
					return
				}
				item.raw["input"] = parsed
				calls = append(calls, schema.ToolCall{ID: item.id, Type: "function", Function: schema.FunctionCall{Name: item.name, Arguments: args}})
				outputBytes += len(args)
			case "thinking":
				hasReasoning = true
				item.raw["thinking"] = item.thinking
				outputBytes += len(item.thinking)
				if item.signature != "" {
					item.raw["signature"] = item.signature
				}
			case "redacted_thinking":
				hasReasoning = true
			}
			if item.kind != "thinking" && item.kind != "redacted_thinking" && (item.kind != "text" || strings.TrimSpace(item.text) != "") {
				reasoningOnly = false
			}
			rawBlocks = append(rawBlocks, item.raw)
		}
		if !hasText && len(calls) == 0 {
			sendError(emptyResponse(stopReason, reasoningOnly && hasReasoning))
			return
		}
		final := schema.AssistantMessage("", calls)
		if hasUsage {
			final.ResponseMeta = responseMetaFromAnthropic(usage, stopReason)
		} else {
			final.ResponseMeta = &schema.ResponseMeta{FinishReason: stopReason}
		}
		if raw, err := json.Marshal(rawBlocks); err == nil {
			final.Extra = map[string]any{"anthropic_content": json.RawMessage(raw)}
		}
		recordUsage()
		writer.Send(final, nil)
	}()
	return reader, nil
}

func responseMetaFromAnthropic(usage *wireUsage, stop string) *schema.ResponseMeta {
	input := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	return &schema.ResponseMeta{FinishReason: stop, Usage: &schema.TokenUsage{
		PromptTokens: int(input), CompletionTokens: int(usage.OutputTokens), TotalTokens: int(input + usage.OutputTokens),
		PromptTokenDetails: schema.PromptTokenDetails{CachedTokens: int(usage.CacheReadInputTokens), CacheWriteTokens: int(usage.CacheCreationInputTokens)},
	}}
}

func messagesURL(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", errors.New("无效的模型 Base URL")
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return "", errors.New("远程模型 Base URL 必须使用 HTTPS")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(u.Path, "/v1/messages") {
		u.Path += "/v1/messages"
	}
	return u.String(), nil
}

func encodeMessages(input []*schema.Message) (string, []wireMessage, error) {
	var system []string
	var messages []wireMessage
	var results []wireBlock
	flushResults := func() {
		if len(results) != 0 {
			messages = append(messages, wireMessage{Role: "user", Content: results})
			results = nil
		}
	}
	for _, msg := range input {
		if msg == nil {
			continue
		}
		if msg.Role == schema.Tool {
			results = append(results, wireBlock{Type: "tool_result", ToolUseID: msg.ToolCallID, Content: msg.Content})
			continue
		}
		flushResults()
		switch msg.Role {
		case schema.System:
			system = append(system, msg.Content)
		case schema.User:
			if len(msg.UserInputMultiContent) == 0 {
				messages = append(messages, wireMessage{Role: "user", Content: msg.Content})
				continue
			}
			blocks := make([]wireBlock, 0, len(msg.UserInputMultiContent))
			for _, part := range msg.UserInputMultiContent {
				switch part.Type {
				case schema.ChatMessagePartTypeText:
					blocks = append(blocks, wireBlock{Type: "text", Text: part.Text})
				case schema.ChatMessagePartTypeImageURL:
					if part.Image == nil || part.Image.Base64Data == nil || part.Image.MIMEType == "" {
						return "", nil, errors.New("图片消息缺少内容或格式")
					}
					blocks = append(blocks, wireBlock{Type: "image", Source: &wireImageSource{Type: "base64", MediaType: part.Image.MIMEType, Data: *part.Image.Base64Data}})
				default:
					return "", nil, fmt.Errorf("不支持的用户消息内容类型 %q", part.Type)
				}
			}
			messages = append(messages, wireMessage{Role: "user", Content: blocks})
		case schema.Assistant:
			if raw, ok := msg.Extra["anthropic_content"].(json.RawMessage); ok && len(raw) != 0 {
				messages = append(messages, wireMessage{Role: "assistant", Content: raw})
				continue
			}
			var blocks []wireBlock
			if msg.Content != "" {
				blocks = append(blocks, wireBlock{Type: "text", Text: msg.Content})
			}
			for _, call := range msg.ToolCalls {
				args := json.RawMessage(call.Function.Arguments)
				if !json.Valid(args) {
					return "", nil, fmt.Errorf("无效的工具调用参数: %s", call.Function.Name)
				}
				blocks = append(blocks, wireBlock{Type: "tool_use", ID: call.ID, Name: call.Function.Name, Input: args})
			}
			messages = append(messages, wireMessage{Role: "assistant", Content: blocks})
		default:
			return "", nil, fmt.Errorf("不支持的模型消息角色 %q", msg.Role)
		}
	}
	flushResults()
	return strings.Join(system, "\n\n"), messages, nil
}
