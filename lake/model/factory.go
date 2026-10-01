package model

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	einomodel "github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

func readSSE(body io.ReadCloser, onData func([]byte) (bool, error)) (bool, error) {
	defer body.Close()
	scanner := bufio.NewScanner(io.LimitReader(body, 16<<20))
	scanner.Buffer(make([]byte, 4096), 4<<20)
	var data strings.Builder
	flush := func() (bool, error) {
		if data.Len() == 0 {
			return false, nil
		}
		payload := strings.TrimSpace(data.String())
		data.Reset()
		if payload == "[DONE]" {
			return true, nil
		}
		return onData([]byte(payload))
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			stop, err := flush()
			if err != nil || stop {
				return stop, err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() != 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		return false, fmt.Errorf("读取模型流失败: %w", err)
	}
	return flush()
}

type Config struct {
	WireAPI         string
	BaseURL         string
	Model           string
	APIKey          []byte
	Client          *http.Client
	ReasoningEffort string
	MaxOutputTokens int
	Usage           *UsageMeter
}

func New(config Config) (einomodel.BaseChatModel, error) {
	if config.Model == "" || config.BaseURL == "" || len(config.APIKey) == 0 {
		return nil, errors.New("模型未配置完整")
	}
	if _, err := openAIURL(config.BaseURL, "/v1/responses"); err != nil {
		return nil, err
	}
	switch config.WireAPI {
	case "", "anthropic":
		return &Anthropic{BaseURL: config.BaseURL, Model: config.Model, APIKey: config.APIKey, Client: config.Client, ReasoningEffort: config.ReasoningEffort, MaxOutputTokens: config.MaxOutputTokens, Usage: config.Usage}, nil
	case "openai_chat":
		return &OpenAIChat{Config: config}, nil
	case "openai_responses":
		return &OpenAIResponses{Config: config}, nil
	default:
		return nil, fmt.Errorf("不支持的模型协议 %q", config.WireAPI)
	}
}

func openAIURL(base, endpoint string) (string, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("无效的模型 Base URL")
	}
	if u.Scheme == "http" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" {
		return "", errors.New("远程模型 Base URL 必须使用 HTTPS")
	}
	path := strings.TrimRight(u.Path, "/")
	if !strings.HasSuffix(path, endpoint) {
		if strings.HasSuffix(path, "/v1") {
			path += strings.TrimPrefix(endpoint, "/v1")
		} else {
			path += endpoint
		}
	}
	u.Path = path
	return u.String(), nil
}

func (c Config) post(ctx context.Context, endpoint string, body []byte) (*http.Response, error) {
	u, err := openAIURL(c.BaseURL, endpoint)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+string(c.APIKey))
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 180 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("模型请求失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("模型服务返回 HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

func (c Config) modelAndLimit(opts []einomodel.Option) (string, int, *einomodel.Options) {
	options := einomodel.GetCommonOptions(nil, opts...)
	modelName := c.Model
	if options.Model != nil {
		modelName = *options.Model
	}
	limit := c.MaxOutputTokens
	if limit <= 0 {
		limit = 4096
	}
	if options.MaxTokens != nil {
		limit = *options.MaxTokens
	}
	return modelName, limit, options
}

func toolDefinitions(infos []*schema.ToolInfo, responses bool) ([]any, error) {
	tools := make([]any, 0, len(infos))
	for _, info := range infos {
		parameters := any(map[string]any{"type": "object", "properties": map[string]any{}})
		if info.ParamsOneOf != nil {
			value, err := info.ParamsOneOf.ToJSONSchema()
			if err != nil {
				return nil, fmt.Errorf("工具 %s 的参数定义无效: %w", info.Name, err)
			}
			parameters = value
		}
		definition := map[string]any{"name": info.Name, "description": info.Desc, "parameters": parameters}
		if responses {
			definition["type"] = "function"
			tools = append(tools, definition)
		} else {
			tools = append(tools, map[string]any{"type": "function", "function": definition})
		}
	}
	return tools, nil
}

func readModelJSON(resp *http.Response, out any) error {
	defer resp.Body.Close()
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("解析模型响应: %w", err)
	}
	return nil
}

type openAIUsage struct {
	PromptTokens     int64 `json:"prompt_tokens"`
	CompletionTokens int64 `json:"completion_tokens"`
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	TotalTokens      int64 `json:"total_tokens"`
	PromptDetails    struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	InputDetails struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}

func (u *openAIUsage) toWire(responses bool) *wireUsage {
	if u == nil {
		return nil
	}
	if responses {
		return &wireUsage{InputTokens: u.InputTokens - u.InputDetails.CachedTokens, OutputTokens: u.OutputTokens, CacheReadInputTokens: u.InputDetails.CachedTokens}
	}
	return &wireUsage{InputTokens: u.PromptTokens - u.PromptDetails.CachedTokens, OutputTokens: u.CompletionTokens, CacheReadInputTokens: u.PromptDetails.CachedTokens}
}

func responseMeta(usage *openAIUsage, responses bool, finish string) *schema.ResponseMeta {
	meta := &schema.ResponseMeta{FinishReason: finish}
	if usage == nil {
		return meta
	}
	input, output, cached := usage.PromptTokens, usage.CompletionTokens, usage.PromptDetails.CachedTokens
	if responses {
		input, output, cached = usage.InputTokens, usage.OutputTokens, usage.InputDetails.CachedTokens
	}
	meta.Usage = &schema.TokenUsage{PromptTokens: int(input), CompletionTokens: int(output), TotalTokens: int(input + output), PromptTokenDetails: schema.PromptTokenDetails{CachedTokens: int(cached)}}
	return meta
}
