package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
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
		if method == "shell_output" || method == "shellOutput" || method == "wait_shell" || method == "waitShell" {
			return e.recordedShellOutput(ctx, id, str(a["shell_id"]))
		}
		return nil, errors.New("重启后仅能恢复原命令结果读取，不能通过丢失的任务句柄终止或重放命令")
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

// Read an exact durable command record. A canonical operation ID is accepted as
// an alias because error messages expose it; it never grants cross-session access
// or permits execution. A disconnected command remains unknown without an exit code.
func (e *Engine) recordedShellOutput(ctx context.Context, session, requested string) (any, error) {
	if e.Bridge == nil || requested == "" || len(requested) > 200 {
		return nil, errors.New("找不到此会话的原命令记录，不会重放原命令")
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	var rows []nativeOperation
	if err := store.DB.WithContext(ctx).Where("session_id = ? AND tool = ? AND (id = ? OR result LIKE ?)", session, "shell", requested, "%"+requested+"%").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		var recorded map[string]any
		_ = json.Unmarshal([]byte(row.Result), &recorded)
		shellID := str(recorded["shell_id"])
		if row.ID != requested && shellID != requested {
			continue
		}
		terminal, entry, ok := strings.Cut(row.Handle, ":")
		if !ok || terminal == "" || entry == "" {
			continue
		}
		value, err := e.Bridge(ctx, session, "terminal_command_status", map[string]any{"terminal_id": terminal, "entry_id": entry}, false)
		if err != nil {
			return nil, err
		}
		data := obj(value)
		status := "unknown"
		if data["status"] == "running" || data["running"] == true {
			status = "running"
		} else if data["exitCode"] != nil {
			status = "completed"
			if num(data["exitCode"], 0) != 0 {
				status = "failed"
			}
		}
		if shellID == "" {
			shellID = requested
		}
		result := map[string]any{"shell_id": shellID, "terminal_id": terminal, "entry_id": entry, "status": status, "result": value}
		if status == "running" {
			result["poll_after_ms"] = 1000
		}
		if status == "unknown" {
			result["notice"] = "已恢复原命令保存的输出，但没有确认退出结果；保留结果未知状态，不会重放原命令"
		}
		return result, nil
	}
	return nil, errors.New("找不到此会话中匹配的原命令记录，不会重放原命令")
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
