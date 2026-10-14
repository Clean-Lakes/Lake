package ai

import (
	"context"
	"errors"
)

// sideCompletion runs one tool-free, session-free model call for a background
// task, under the same output and context budgets the agent itself uses. It
// carries no conversation state: the caller supplies the whole prompt.
//
// The "context budget" wording is load-bearing. Callers branch on it to tell a
// prompt that cannot fit from a transient provider failure.
func (e *Engine) sideCompletion(ctx context.Context, model Model, messages []Message, budgetError string) (string, Usage, error) {
	model.SupportsImageOutput = false
	if model.ContextWindow <= 0 {
		model.ContextWindow = 64000
	}
	if model.MaxOutput <= 0 {
		model.MaxOutput = 8192
	}
	model.MaxOutput = min(model.MaxOutput, 4096, model.ContextWindow/4)
	if model.MaxOutput <= 0 || (historyCost(messages)+2)/3+model.MaxOutput >= model.ContextWindow {
		return "", Usage{}, errors.New(budgetError)
	}
	result, err := e.stream(ctx, model, messages, nil, nil)
	if err != nil {
		return "", Usage{}, err
	}
	return result.Message.Content, result.Usage, nil
}
