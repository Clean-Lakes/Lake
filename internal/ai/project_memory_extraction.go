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
	return e.sideCompletion(ctx, model, messages, "memory context budget exceeded")
}
