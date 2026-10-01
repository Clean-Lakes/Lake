package main

import (
	"context"
	"errors"
	"sync"

	"github.com/cloudwego/eino/lake/store"
)

type commandReply struct {
	Record store.ExecutionRecord `json:"record"`
	Error  string                `json:"error,omitempty"`
}

// Command proposals are serialized. Taking control leaves this request waiting;
// returning a verified execution result continues the very same model/tool turn.
type bridgeCommandGate struct {
	serial   sync.Mutex
	mu       sync.Mutex
	id       string
	response chan commandReply
	closed   chan struct{}
	once     sync.Once
}

func newBridgeCommandGate() *bridgeCommandGate {
	return &bridgeCommandGate{closed: make(chan struct{})}
}
func (g *bridgeCommandGate) request(ctx context.Context, kind, target, command string, emit func(string)) (store.ExecutionRecord, error) {
	g.serial.Lock()
	defer g.serial.Unlock()
	id, err := store.NewActionID()
	if err != nil {
		return store.ExecutionRecord{}, err
	}
	ch := make(chan commandReply, 1)
	g.mu.Lock()
	g.id, g.response = id, ch
	g.mu.Unlock()
	defer func() { g.mu.Lock(); g.id, g.response = "", nil; g.mu.Unlock() }()
	select {
	case <-g.closed:
		return store.ExecutionRecord{}, errors.New("命令通道已关闭")
	default:
	}
	emit(id)
	select {
	case reply := <-ch:
		if reply.Error != "" {
			return reply.Record, errors.New(reply.Error)
		}
		return reply.Record, nil
	case <-ctx.Done():
		return store.ExecutionRecord{}, ctx.Err()
	case <-g.closed:
		return store.ExecutionRecord{}, errors.New("命令通道已关闭")
	}
}
func (g *bridgeCommandGate) respond(id string, reply commandReply) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if id == "" || g.id != id || g.response == nil {
		return false
	}
	select {
	case g.response <- reply:
		return true
	default:
		return false
	}
}
func (g *bridgeCommandGate) close() { g.once.Do(func() { close(g.closed) }) }

func errorStringForCommand(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
