package ai

import (
	"context"
	"errors"
)

// GenerateSessionTitle asks the model for a short topic title for one new
// conversation. It is a side task: no tools, no conversation session, and the
// caller owns sanitising the returned text.
func (e *Engine) GenerateSessionTitle(ctx context.Context, model Model, messages []Message) (string, Usage, error) {
	if len(messages) < 2 || messages[0].Role != "system" || messages[1].Role != "user" {
		return "", Usage{}, errors.New("invalid session title input")
	}
	return e.sideCompletion(ctx, model, messages, "session title context budget exceeded")
}
