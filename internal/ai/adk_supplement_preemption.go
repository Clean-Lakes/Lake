package ai

import (
	"context"
	"errors"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

var errUserSupplement = errors.New("provider request superseded by actual user supplement")

type supplementRequest struct{ cancel context.CancelCauseFunc }

// Register under the admission fence, including a supplement received between
// preparing the prompt and starting the provider request. No tool uses this ctx.
func (d *adkTurnDriver) supplementRequestContext(parent context.Context) (context.Context, func() bool, error) {
	if read, _ := d.engine.supplementHooks(); read == nil {
		return parent, func() bool { return false }, nil
	}
	ctx, cancel := context.WithCancelCause(parent)
	request := &supplementRequest{cancel: cancel}
	s := d.session
	s.mu.Lock()
	pending, err := d.engine.pendingSupplementsLocked(s)
	if err != nil {
		s.mu.Unlock()
		cancel(err)
		return parent, nil, err
	}
	s.supplementRequest = request
	if len(pending) > 0 {
		cancel(errUserSupplement)
	}
	s.mu.Unlock()
	return ctx, func() bool {
		s.mu.Lock()
		if s.supplementRequest == request {
			s.supplementRequest = nil
		}
		s.mu.Unlock()
		interrupted := errors.Is(context.Cause(ctx), errUserSupplement)
		cancel(nil)
		return interrupted
	}, nil
}

// Let the official ADK error/after-model callbacks dispatch the existing
// trusted supplement control tool and continue the same invocation. This is
// not a host-owned model/tool loop or a retry of an executed resource action.
func (d *adkTurnDriver) supplementModelError(ac agent.Context, _ *model.LLMRequest, err error) (*model.LLMResponse, error) {
	if !errors.Is(err, errUserSupplement) || ac.Err() != nil {
		return nil, nil
	}
	s := d.session
	s.mu.Lock()
	defer s.mu.Unlock()
	pending, readErr := d.engine.pendingSupplementsLocked(s)
	if readErr != nil {
		return nil, readErr
	}
	if len(pending) == 0 {
		return nil, err
	}
	return &model.LLMResponse{Content: &genai.Content{Role: "model"}, TurnComplete: true}, nil
}
