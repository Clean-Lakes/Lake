package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"iter"
	"strings"

	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// ProviderLLM adapts Lake's existing multi-protocol provider to ADK's model.LLM
// interface. It deliberately keeps Lake's Model (URL, protocol, headers, key)
// as the source of truth so the ADK migration does not introduce a second
// credential store.
type ProviderLLM struct {
	Model  Model
	stream func(context.Context, Model, []Message, []Tool, func(string, string)) (modelResult, error)
}

// NewProviderLLM creates an ADK model backed by Lake's provider layer.
func NewProviderLLM(m Model) *ProviderLLM {
	applyContextBudget(&m)
	if m.Protocol == "" {
		m.Protocol = "openai"
	}
	return &ProviderLLM{Model: m}
}

// Name implements model.LLM.
func (l *ProviderLLM) Name() string {
	if strings.TrimSpace(l.Model.Name) != "" {
		return l.Model.Name
	}
	return "lake-provider"
}

// GenerateContent implements model.LLM. Streaming mode yields partial text
// responses followed by one final response carrying tool calls and usage.
func (l *ProviderLLM) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		history, tools, err := ADKRequest(req)
		if err != nil {
			yield(nil, err)
			return
		}
		if !stream {
			result, err := l.providerStream(ctx, l.Model, history, tools, nil)
			if err != nil {
				yield(nil, err)
				return
			}
			resp, err := ADKResponse(result.Message, result.Usage, l.Model.Name)
			if err != nil {
				yield(nil, err)
				return
			}
			yield(resp, nil)
			return
		}

		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		type item struct {
			partial *model.LLMResponse
			final   *model.LLMResponse
			err     error
		}
		events := make(chan item, 128)
		go func() {
			defer close(events)
			result, err := l.providerStream(ctx, l.Model, history, tools, func(kind, delta string) {
				if delta == "" {
					return
				}
				partial := &model.LLMResponse{
					Content: &genai.Content{
						Role: "model",
						Parts: []*genai.Part{{
							Text:    delta,
							Thought: kind == "thinking",
						}},
					},
					Partial: true,
				}
				select {
				case events <- item{partial: partial}:
				case <-ctx.Done():
				}
			})
			if err != nil {
				select {
				case events <- item{err: err}:
				case <-ctx.Done():
				}
				return
			}
			final, err := ADKResponse(result.Message, result.Usage, l.Model.Name)
			if err != nil {
				select {
				case events <- item{err: err}:
				case <-ctx.Done():
				}
				return
			}
			select {
			case events <- item{final: final}:
			case <-ctx.Done():
			}
		}()

		for event := range events {
			if event.err != nil {
				if !yield(nil, event.err) {
					return
				}
				continue
			}
			if event.partial != nil && !yield(event.partial, nil) {
				return
			}
			if event.final != nil && !yield(event.final, nil) {
				return
			}
		}
	}
}

func ADKRequest(req *model.LLMRequest) ([]Message, []Tool, error) {
	if req == nil {
		return nil, nil, fmt.Errorf("nil model request")
	}
	history := []Message{}
	if req.Config != nil && req.Config.SystemInstruction != nil {
		if text := ADKContentText(req.Config.SystemInstruction); text != "" {
			history = append(history, Message{Role: "system", Content: text})
		}
	}
	for _, content := range req.Contents {
		if content == nil {
			continue
		}
		switch content.Role {
		case "user":
			texts := []string{}
			images := []ImageAttachment{}
			toolMessages := []Message{}
			for _, part := range content.Parts {
				if part == nil {
					continue
				}
				if part.Text != "" && !part.Thought {
					texts = append(texts, part.Text)
				}
				if part.InlineData != nil && len(part.InlineData.Data) > 0 {
					images = append(images, ImageAttachment{
						MimeType: part.InlineData.MIMEType,
						Base64:   base64.StdEncoding.EncodeToString(part.InlineData.Data),
					})
				}
				if part.FunctionResponse != nil {
					body, _ := json.Marshal(part.FunctionResponse.Response)
					toolMessages = append(toolMessages, Message{
						Role:    "tool",
						CallID:  part.FunctionResponse.ID,
						Name:    part.FunctionResponse.Name,
						Content: string(body),
					})
				}
			}
			if len(texts) > 0 || len(images) > 0 {
				history = append(history, Message{Role: "user", Content: strings.Join(texts, "\n"), Images: images})
			}
			history = append(history, toolMessages...)
		case "model", "assistant":
			texts := []string{}
			reasoning := []string{}
			calls := []Call{}
			for _, part := range content.Parts {
				if part == nil {
					continue
				}
				if part.Text != "" {
					if part.Thought {
						reasoning = append(reasoning, part.Text)
					} else {
						texts = append(texts, part.Text)
					}
				}
				if part.FunctionCall != nil {
					args, _ := json.Marshal(part.FunctionCall.Args)
					calls = append(calls, Call{
						ID:        part.FunctionCall.ID,
						Name:      part.FunctionCall.Name,
						Arguments: string(args),
					})
				}
			}
			if len(texts) > 0 || len(reasoning) > 0 || len(calls) > 0 {
				history = append(history, Message{
					Role:      "assistant",
					Content:   strings.Join(texts, "\n"),
					Reasoning: strings.Join(reasoning, "\n"),
					Calls:     calls,
				})
			}
		case "system":
			if text := ADKContentText(content); text != "" {
				history = append(history, Message{Role: "system", Content: text})
			}
		}
	}
	return history, ADKTools(req), nil
}

func ADKTools(req *model.LLMRequest) []Tool {
	if req.Config == nil {
		return nil
	}
	out := []Tool{}
	for _, t := range req.Config.Tools {
		if t == nil {
			continue
		}
		for _, decl := range t.FunctionDeclarations {
			if decl == nil || decl.Name == "" {
				continue
			}
			params := map[string]any{}
			switch {
			case decl.ParametersJsonSchema != nil:
				b, _ := json.Marshal(decl.ParametersJsonSchema)
				_ = json.Unmarshal(b, &params)
			case decl.Parameters != nil:
				b, _ := json.Marshal(decl.Parameters)
				_ = json.Unmarshal(b, &params)
			}
			if len(params) == 0 {
				params = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			out = append(out, Tool{
				Name:        decl.Name,
				Description: decl.Description,
				Parameters:  params,
			})
		}
	}
	return out
}

func ADKResponse(msg Message, usage Usage, modelName string) (*model.LLMResponse, error) {
	parts := []*genai.Part{}
	if msg.Reasoning != "" {
		parts = append(parts, &genai.Part{Text: msg.Reasoning, Thought: true})
	}
	if msg.Content != "" {
		parts = append(parts, &genai.Part{Text: msg.Content})
	}
	for _, call := range msg.Calls {
		args := map[string]any{}
		if call.Arguments != "" {
			if err := json.Unmarshal([]byte(call.Arguments), &args); err != nil {
				args = map[string]any{"_raw": call.Arguments}
			}
		}
		parts = append(parts, &genai.Part{FunctionCall: &genai.FunctionCall{
			ID:   call.ID,
			Name: call.Name,
			Args: args,
		}})
	}
	resp := &model.LLMResponse{
		Content:      &genai.Content{Role: "model", Parts: parts},
		TurnComplete: true,
		ModelVersion: modelName,
	}
	if usage.Input > 0 || usage.Output > 0 || usage.Total > 0 {
		meta := &genai.GenerateContentResponseUsageMetadata{
			PromptTokenCount:     int32(usage.Input),
			CandidatesTokenCount: int32(usage.Output),
			TotalTokenCount:      int32(usage.Total),
		}
		if usage.CachedInput != nil {
			meta.CachedContentTokenCount = int32(*usage.CachedInput)
		}
		resp.UsageMetadata = meta
	}
	return resp, nil
}

func ADKContentText(content *genai.Content) string {
	if content == nil {
		return ""
	}
	texts := []string{}
	for _, part := range content.Parts {
		if part != nil && part.Text != "" && !part.Thought {
			texts = append(texts, part.Text)
		}
	}
	return strings.Join(texts, "\n")
}

func (l *ProviderLLM) providerStream(ctx context.Context, m Model, h []Message, t []Tool, delta func(string, string)) (modelResult, error) {
	if l.stream != nil {
		return l.stream(ctx, m, h, t, delta)
	}
	return Stream(ctx, m, h, t, delta)
}
