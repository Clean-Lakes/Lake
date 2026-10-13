package ai

import "context"

type shellPollingKey struct{}
type shellPollGuard struct {
	fingerprints map[string]string
	unchanged    map[string]int
}
type pollingPause struct{ status string }

func (p *pollingPause) Error() string { return "background query repeated without new information" }

func boundedShellPolling(ctx context.Context) context.Context {
	return context.WithValue(ctx, shellPollingKey{}, &shellPollGuard{fingerprints: map[string]string{}, unchanged: map[string]int{}})
}

func shellPollingProgress(ctx context.Context, call Call, value any) error {
	guard, _ := ctx.Value(shellPollingKey{}).(*shellPollGuard)
	if guard == nil {
		return nil
	}
	if call.Name != "wait_shell" && call.Name != "shell_output" {
		// Other tool work between polls is progress; only consecutive fruitless
		// polls on the same job count toward the no-progress bound.
		guard.fingerprints = map[string]string{}
		guard.unchanged = map[string]int{}
		return nil
	}
	a, err := args(call)
	if err != nil {
		return nil
	}
	id := str(a["shell_id"])
	data := obj(value)
	status := str(data["status"])
	if id == "" || status == "" {
		return nil
	}
	// Ignore polling hints and wait durations. Actual output or a status change
	// is progress; asking the same question with a different timeout is not.
	fingerprint := hash(js(map[string]any{"status": status, "result": data["result"], "error": data["error"]}))
	if guard.fingerprints[id] == fingerprint {
		guard.unchanged[id]++
	} else {
		guard.fingerprints[id] = fingerprint
		guard.unchanged[id] = 1
	}
	if guard.unchanged[id] >= 3 {
		return &pollingPause{status: status}
	}
	return nil
}

func (e *Engine) finishPolling(s *session, pause *pollingPause) error {
	s.mu.Lock()
	reconcile(&s.state, "remaining tool calls skipped after repeated background polling; not replayed")
	s.mu.Unlock()
	text := "命令仍在后台运行，暂时没有新的输出。我已停止重复等待；可以稍后查看结果，或在资源终端中停止命令。"
	if pause.status == "completed" {
		text = "后台命令已结束，已停止重复查询。可以查看上面的命令结果。"
	}
	if pause.status == "failed" {
		text = "后台命令未成功，已停止重复查询。可以查看上面的错误信息。"
	}
	return e.finishReply(s, text)
}
