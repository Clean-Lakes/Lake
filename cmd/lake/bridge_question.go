package main

import (
	"context"
	"errors"
	"sync"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
)

type bridgeQuestionReply struct {
	answer agent.UserQuestionAnswer
	err    error
}

type bridgeQuestionGate struct {
	serial   sync.Mutex
	mu       sync.Mutex
	turnID   string
	request  agent.UserQuestionRequest
	response chan bridgeQuestionReply
	answered bool
	closed   bool
}

func (g *bridgeQuestionGate) requestAnswer(ctx context.Context, turnID string, input agent.UserQuestionInput, emit func(agent.UserQuestionRequest) error) (agent.UserQuestionAnswer, error) {
	if err := input.Validate(); err != nil {
		return agent.UserQuestionAnswer{}, err
	}
	g.serial.Lock()
	defer g.serial.Unlock()
	if err := ctx.Err(); err != nil {
		return agent.UserQuestionAnswer{}, err
	}
	id, err := store.NewActionID()
	if err != nil {
		return agent.UserQuestionAnswer{}, err
	}
	request := agent.UserQuestionRequest{ID: id, UserQuestionInput: input}
	response := make(chan bridgeQuestionReply, 1)
	g.mu.Lock()
	if g.closed || turnID == "" {
		g.mu.Unlock()
		return agent.UserQuestionAnswer{}, errors.New("用户问题通道已关闭或运行已结束")
	}
	g.turnID, g.request, g.response, g.answered = turnID, request, response, false
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		g.turnID, g.request, g.response = "", agent.UserQuestionRequest{}, nil
		g.mu.Unlock()
	}()
	if err := emit(request); err != nil {
		return agent.UserQuestionAnswer{}, err
	}
	select {
	case reply := <-response:
		return reply.answer, reply.err
	case <-ctx.Done():
		return agent.UserQuestionAnswer{}, ctx.Err()
	}
}

func (g *bridgeQuestionGate) respond(turnID, questionID string, answer agent.UserQuestionAnswer, persist func(agent.UserQuestionRequest, agent.UserQuestionAnswer) error) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed || g.response == nil || g.answered || g.turnID != turnID || g.request.ID != questionID {
		return errors.New("这个问题已结束或不属于当前运行")
	}
	if err := g.request.ValidateAnswer(answer); err != nil {
		return err
	}
	copy := agent.UserQuestionAnswer{Answers: make(map[string]string, len(answer.Answers))}
	for id, text := range answer.Answers {
		copy.Answers[id] = text
	}
	if err := persist(g.request, copy); err != nil {
		return err
	}
	g.answered = true
	g.response <- bridgeQuestionReply{answer: copy}
	return nil
}

func (g *bridgeQuestionGate) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	if g.response != nil && !g.answered {
		g.answered = true
		g.response <- bridgeQuestionReply{err: context.Canceled}
	}
}
