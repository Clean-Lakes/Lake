package ai

import (
	"context"
	"errors"
)

// ExtractMemory uses the ordinary provider adapter and model concurrency limit,
// but deliberately supplies no tools or conversation session.
func (e *Engine) ExtractMemory(ctx context.Context, model Model, messages []Message) (string, Usage, error) {
	if len(messages) < 2 || messages[0].Role != "system" || messages[1].Role != "user" {
		return "", Usage{}, errors.New("invalid memory extraction input")
	}
	model.SupportsImageOutput = false
	if model.ContextWindow <= 0 {
		model.ContextWindow = 64000
	}
	if model.MaxOutput <= 0 {
		model.MaxOutput = 8192
	}
	model.MaxOutput = min(model.MaxOutput, 4096, model.ContextWindow/4)
	if model.MaxOutput <= 0 || (historyCost(messages)+2)/3+model.MaxOutput >= model.ContextWindow {
		return "", Usage{}, errors.New("memory context budget exceeded")
	}
	result, err := e.stream(ctx, model, messages, nil, nil)
	if err != nil {
		return "", Usage{}, err
	}
	return result.Message.Content, result.Usage, nil
}
