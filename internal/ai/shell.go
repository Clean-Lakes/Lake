package ai

import (
	"context"
	"errors"
	"sync"
	"time"
)

type shellJob struct {
	mu                  sync.Mutex
	id, session         string
	cancel              context.CancelFunc
	done                chan struct{}
	result              any
	err                 error
	status              string
	terminalID, entryID string
}

func (e *Engine) startShell(c Config, a map[string]any, command string) (any, error) {
	e.shellMu.Lock()
	defer e.shellMu.Unlock()
	if e.shellsClosed {
		return nil, context.Canceled
	}
	id := uid()
	session := str(a["__session"])
	count := 0
	e.shells.Range(func(_, v any) bool {
		j := v.(*shellJob)
		j.mu.Lock()
		if j.status == "running" {
			count++
		}
		j.mu.Unlock()
		return true
	})
	if count >= 16 {
		return nil, errors.New("background shell limit reached")
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration(a))
	j := &shellJob{id: id, session: session, cancel: cancel, done: make(chan struct{}), status: "running"}
	e.shellCard(session, id, "", "background_running", true)
	e.shells.Store(session+":"+id, j)
	go func() {
		defer close(j.done)
		result, err := e.execRuntime(ctx, c, a, []string{"/bin/sh", "-c", command}, "")
		cancel()
		j.mu.Lock()
		j.result = result
		j.err = err
		j.status = "completed"
		if err != nil {
			j.status = "failed"
		}
		j.mu.Unlock()
		content := js(result)
		if err != nil {
			content = err.Error()
		}
		j.mu.Lock()
		status := j.status
		j.mu.Unlock()
		e.shellCard(session, id, redact(content, c), status, false)
	}()
	return map[string]any{"shell_id": id, "status": "running"}, nil
}
func (e *Engine) shellJob(ctx context.Context, id, method string, a map[string]any) (any, error) {
	v, ok := e.shells.Load(id + ":" + str(a["shell_id"]))
	if !ok {
		return nil, errors.New("shell unavailable in this session; restarted jobs are never replayed")
	}
	j := v.(*shellJob)
	if method == "kill_shell" || method == "forceKillShell" {
		if j.terminalID != "" && e.Bridge != nil {
			if _, err := e.Bridge(ctx, id, "terminal_kill_command", map[string]any{"terminal_id": j.terminalID, "entry_id": j.entryID}, true); err != nil {
				return nil, err
			}
		}
		j.cancel()
	}
	if method == "wait_shell" || method == "waitShell" {
		wait := duration(a)
		if wait > 5*time.Second {
			wait = 5 * time.Second
		}
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-j.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			// Expiry ends this bounded wait, not the command itself.
		}
	}
	j.mu.Lock()
	status, value, jobErr, terminal, entry := j.status, j.result, j.err, j.terminalID, j.entryID
	j.mu.Unlock()
	if status == "running" && terminal != "" && e.Bridge != nil {
		partial, err := e.Bridge(ctx, id, "terminal_command_status", map[string]any{"terminal_id": terminal, "entry_id": entry}, false)
		if err == nil {
			value = partial
			if obj(partial)["partial"] == false {
				status = "completed"
			}
		}
	}
	result := map[string]any{"shell_id": j.id, "status": status, "result": value}
	if status == "running" {
		result["poll_after_ms"] = 1000
	}
	if jobErr != nil {
		result["error"] = jobErr.Error()
	}
	return result, nil
}
func (e *Engine) cancelShells(id string) {
	e.shells.Range(func(_, v any) bool {
		j := v.(*shellJob)
		if id == "" || j.session == id {
			j.cancel()
		}
		return true
	})
}

// trackBridgeShell gives persistent PTY jobs the same wait/output/kill contract as container jobs.
func (e *Engine) trackBridgeShell(session string, result any, a map[string]any) (any, error) {
	e.shellMu.Lock()
	defer e.shellMu.Unlock()
	if e.shellsClosed {
		return nil, context.Canceled
	}
	data := obj(result)
	entryID, terminalID := str(data["entry_id"]), str(data["terminal_id"])
	if entryID == "" || terminalID == "" {
		return result, nil
	}
	id := uid()
	ctx, stopWaiting := context.WithCancel(context.Background())
	cancel := stopWaiting
	job := &shellJob{id: id, session: session, cancel: cancel, done: make(chan struct{}), status: "running", terminalID: terminalID, entryID: entryID}
	e.shells.Store(session+":"+id, job)
	e.shellCard(session, id, "", "background_running", true)
	go func() {
		defer close(job.done)
		result, err := e.Bridge(ctx, session, "terminal_wait_command", map[string]any{"terminal_id": terminalID, "entry_id": entryID}, false)
		if code, hasExit := obj(result)["exitCode"]; err == nil && hasExit && code == nil {
			err = errors.New("命令执行结果未确认，请核查终端实际状态")
		}
		stopWaiting()
		job.mu.Lock()
		job.result = result
		job.err = err
		job.status = "completed"
		if err != nil {
			job.status = "failed"
		}
		status := job.status
		job.mu.Unlock()
		content := js(result)
		if err != nil {
			content = err.Error()
		}
		e.shellCard(session, id, content, status, false)
	}()
	tracked := map[string]any{"shell_id": id, "terminal_id": terminalID, "entry_id": entryID, "status": "running", "poll_after_ms": 1000}
	if data["timed_out"] == true {
		tracked["timed_out"] = true
		tracked["result"] = result
		tracked["notice"] = "等待命令超时，命令尚未确认结束；使用 wait_shell 或 shell_output 读取此 shell_id 的状态，不要重复执行原命令。"
	}
	return tracked, nil
}

// Completion updates the original card, never the status or ordering of a later turn.
func (e *Engine) shellCard(session, id, content, status string, create bool) {
	s, err := e.get(session)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if create {
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: id, Type: "shell", Title: "后台命令", Status: status, At: timestamp()})
	} else {
		for i := range s.state.View.Cards {
			if s.state.View.Cards[i].ID == id {
				s.state.View.Cards[i].Content = redact(content, s.state.Config)
				s.state.View.Cards[i].Status = status
			}
		}
	}
	_ = e.save(s)
	e.notify(s, "shell", map[string]any{"shell_id": id})
}
