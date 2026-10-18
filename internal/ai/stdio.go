package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
)

type Frame struct {
	ID       string          `json:"id,omitempty"`
	Method   string          `json:"method,omitempty"`
	Session  string          `json:"session,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
	Result   any             `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
	Event    *Event          `json:"event,omitempty"`
	Callback string          `json:"callback,omitempty"`
	Approved bool            `json:"approved,omitempty"`
}

// Serve uses inherited pipes only; it never opens an unauthenticated network listener.
func Serve(ctx context.Context, dir string, in io.Reader, out io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var output sync.Mutex
	send := func(f Frame) {
		output.Lock()
		defer output.Unlock()
		if json.NewEncoder(out).Encode(f) != nil {
			cancel()
		}
	}
	var pending sync.Map
	bridge := func(ctx context.Context, session, name string, a map[string]any, approved bool) (any, error) {
		id := uid()
		ch := make(chan Frame, 1)
		pending.Store(id, ch)
		defer pending.Delete(id)
		b, _ := json.Marshal(a)
		send(Frame{Callback: id, Method: name, Session: session, Data: b, Approved: approved})
		select {
		case reply := <-ch:
			if reply.Error != "" {
				return nil, errors.New(reply.Error)
			}
			return reply.Result, nil
		case <-ctx.Done():
			send(Frame{Method: "callbackCancel", Callback: id})
			return nil, ctx.Err()
		}
	}
	engine, err := New(dir, bridge, func(event Event) { send(Frame{Event: &event}) })
	if err != nil {
		return err
	}
	defer engine.Shutdown()
	var workers sync.WaitGroup
	defer workers.Wait()
	scan := bufio.NewScanner(in)
	scan.Buffer(make([]byte, 65536), 32<<20)
	for scan.Scan() {
		var frame Frame
		if json.Unmarshal(scan.Bytes(), &frame) != nil {
			send(Frame{Error: "invalid protocol frame"})
			continue
		}
		if frame.Callback != "" {
			if c, ok := pending.LoadAndDelete(frame.Callback); ok {
				c.(chan Frame) <- frame
			}
			continue
		}
		if frame.ID == "" {
			continue
		}
		workers.Add(1)
		go func(f Frame) {
			defer workers.Done()
			result, err := engine.Handle(ctx, f.Method, f.Session, f.Data)
			reply := Frame{ID: f.ID, Result: result}
			if err != nil {
				reply.Error = err.Error()
			}
			send(reply)
		}(frame)
	}
	cancel()
	engine.Shutdown()
	return scan.Err()
}
func (e *Engine) Handle(ctx context.Context, method, id string, data json.RawMessage) (any, error) {
	decode := func(v any) error {
		if len(data) == 0 {
			data = []byte("{}")
		}
		if json.Unmarshal(data, v) != nil {
			return errors.New("invalid request data")
		}
		return nil
	}
	switch method {
	case "resolveOperation":
		var input struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Note   string `json:"note"`
		}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return nil, e.ResolveOperation(id, input.ID, input.Status, input.Note)
	case "configure":
		var c Config
		if err := decode(&c); err != nil {
			return nil, err
		}
		return nil, e.Configure(id, c)
	case "chat":
		var a TurnInput
		if err := decode(&a); err != nil {
			return nil, err
		}
		if a.validate() != nil {
			return nil, errors.New("invalid chat message")
		}
		err := e.ExecuteTurn(ctx, id, a)
		if err != nil {
			return nil, err
		}
		return e.Snapshot(id)
	case "waitShell", "shellOutput", "forceKillShell":
		var a map[string]any
		if err := decode(&a); err != nil {
			return nil, err
		}
		return e.shellJob(ctx, id, method, a)
	case "agentQuestionReply":
		var input struct {
			RunID   string              `json:"runId"`
			ID      string              `json:"id"`
			Answers map[string][]string `json:"answers"`
		}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return nil, e.AgentQuestionReply(id, input.RunID, input.ID, input.Answers)
	case "questionReply":
		var input struct {
			ID      string              `json:"id"`
			Answers map[string][]string `json:"answers"`
		}
		if err := decode(&input); err != nil {
			return nil, err
		}
		return nil, e.ReplyQuestion(id, input.ID, input.Answers)
	case "abort":
		return nil, e.Abort(id)
	case "cancelAgent", "agentDecision", "agentDetails":
		var input struct {
			RunID        string `json:"runId"`
			ID           string `json:"id"`
			Accept       bool   `json:"accept"`
			Confirmation string `json:"confirmation"`
		}
		if err := decode(&input); err != nil {
			return nil, err
		}
		switch method {
		case "cancelAgent":
			return nil, e.CancelAgent(id, input.RunID)
		case "agentDecision":
			return nil, e.AgentDecision(id, input.RunID, input.ID, input.Accept, input.Confirmation)
		default:
			return e.AgentDetails(id, input.RunID)
		}
	case "snapshot":
		var a struct {
			Before int `json:"before"`
			Limit  int `json:"limit"`
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		if a.Limit <= 0 {
			a.Limit = 300
		}
		return e.SnapshotPage(id, a.Before, a.Limit)
	case "history":
		return e.History(id)
	case "references":
		return e.ReferencedAssets(id)
	case "clearReferences":
		return nil, e.ClearReferences(id)
	case "clear":
		return nil, e.Clear(id)
	case "restore":
		var a struct {
			Messages []Message `json:"messages"`
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, e.Restore(id, a.Messages)
	case "rollback":
		return nil, e.Rollback(id)
	case "compact":
		return nil, e.Compact(ctx, id)
	case "undoFile":
		return e.UndoFile(ctx, id)
	case "decision", "shellApprovalReply", "fileApprovalReply":
		var a struct {
			ID           string `json:"id"`
			Accept       bool   `json:"accept"`
			Confirmation string `json:"confirmation"`
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		return nil, e.Decision(id, a.ID, a.Accept, a.Confirmation)
	case "presets":
		return e.Presets()
	case "savePreset", "deletePreset":
		var p Preset
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, e.SavePreset(p, method == "deletePreset")
	case "extractPreset":
		return e.ExtractPreset(ctx, id)
	case "tools":
		var a struct {
			Profile string `json:"profile"`
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		s, err := e.get(id)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		c := s.state.Config
		s.mu.Unlock()
		if a.Profile != "" {
			c.Profile = a.Profile
		}
		return e.sessionCatalog(ctx, id, c), nil
	case "validateImages":
		var a struct {
			Images []ImageAttachment `json:"images"`
		}
		if err := decode(&a); err != nil {
			return nil, err
		}
		return ValidateImages(a.Images)
	case "testModel":
		var m Model
		if err := decode(&m); err != nil {
			return nil, err
		}
		// Reasoning models need room for hidden thinking even for a short ping.
		m.MaxOutput = 1024
		m.ReasoningEffort = ""
		for _, effort := range reasoningLevels {
			if ValidReasoningEffort(m, effort) {
				m.ReasoningEffort = effort
				break
			}
		}
		m.SupportsImageOutput = false
		probe, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		_, err := Stream(probe, m, []Message{{Role: "user", Content: "Reply with only OK."}}, nil, nil)
		if errors.Is(err, ErrModelOutputLimit) {
			return map[string]any{"ok": true, "message": "连接成功，模型已响应；测试回复达到输出上限"}, nil
		}
		if err != nil {
			return map[string]any{"ok": false, "message": "模型连接测试失败：" + err.Error()}, nil
		}
		return map[string]any{"ok": true, "message": "连接成功，模型返回了有效响应"}, nil
	case "models":
		var m Model
		if err := decode(&m); err != nil {
			return nil, err
		}
		return Models(ctx, m)
	case "ping":
		return map[string]any{"runtime": "go", "version": "0.1.0", "protocols": []string{"openai", "azure-gpt", "openai-response", "claude", "gemini", "ollama"}, "recoveredTools": 24}, nil
	default:
		return nil, errors.New("AI method unavailable")
	}
}
