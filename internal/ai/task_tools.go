package ai

import (
	"context"
	"encoding/json"
	"errors"
)

func (e *Engine) taskTool(ctx context.Context, s *session, c Config, call Call, a map[string]any) (result any, err error) {
	defer func() {
		if err != nil || call.Name != "task_output" {
			return
		}
		_, hasOffset := a["offset"]
		_, hasLimit := a["limit"]
		if !hasOffset && !hasLimit {
			return
		}
		payload := redact(js(result), c)
		offset, limit := num(a["offset"], 0), num(a["limit"], 8192)
		if offset < 0 || offset > len(payload) || limit < 1 || limit > 32768 || offset < len(payload) && payload[offset]&0xc0 == 0x80 {
			result = nil
			err = errors.New("invalid task page")
			return
		}
		var meta map[string]any
		_ = json.Unmarshal([]byte(payload), &meta)
		piece := utf8Prefix(payload[offset:], limit)
		page := map[string]any{"task_id": a["task_id"], "status": meta["status"], "content": piece, "offset": offset, "complete": offset+len(piece) == len(payload)}
		if offset+len(piece) < len(payload) {
			page["next_offset"] = offset + len(piece)
		}
		result = page
	}()
	s.mu.Lock()
	id := s.state.View.Session
	var found *AgentRun
	for _, r := range s.state.View.AgentRuns {
		if r.ID == str(a["task_id"]) {
			copy := r
			found = &copy
			break
		}
	}
	s.mu.Unlock()
	taskID, kind := str(a["task_id"]), str(a["type"])
	if _, ok := e.shells.Load(id + ":" + taskID); ok && (kind == "" || kind == "shell") {
		method := "shell_output"
		if call.Name == "task_stop" {
			method = "kill_shell"
			if c.Permissions != nil && !c.Permissions.SilentCommands {
				if err := e.sessionApproval(ctx, s, call, "command"); err != nil {
					return nil, err
				}
			}
		}
		return e.shellJob(ctx, id, method, map[string]any{"shell_id": taskID})
	}
	if found != nil && (kind == "" || kind == "agent") {
		if call.Name == "task_stop" {
			return map[string]any{"task_id": taskID, "cancel_requested": true}, e.CancelAgent(id, taskID)
		}
		return found, nil
	}
	if kind == "shell" || kind == "agent" || e.Bridge == nil {
		return nil, errors.New("task unavailable in this session")
	}
	if call.Name == "task_stop" && c.Permissions != nil && !c.Permissions.SilentCommands {
		if err := e.sessionApproval(ctx, s, call, "command"); err != nil {
			return nil, err
		}
	}
	return e.bridgeCall(ctx, id, call.Name, a, call.Name == "task_stop")
}
