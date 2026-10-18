package ai

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// Only the trusted bridge may assert that resource execution never started.
// Arbitrary tool text and transport failures must retain unknown semantics.
type ToolNotExecutedError struct{ Err error }

func (e *ToolNotExecutedError) Error() string { return e.Err.Error() }
func (e *ToolNotExecutedError) Unwrap() error { return e.Err }

// The trusted terminal bridge timed out waiting, while the dispatched command
// still has a live terminal/entry handle. It is not a cancelled agent turn.
type ToolWaitTimeoutError struct{ Err error }

func (e *ToolWaitTimeoutError) Error() string { return e.Err.Error() }
func (e *ToolWaitTimeoutError) Unwrap() error { return e.Err }

func (e *Engine) checkSRECall(c Config, call Call, a map[string]any) error {
	if c.sre == nil {
		return nil
	}
	if c.sre.FullTools {
		return nil
	}
	if c.sre.Role == SRECoordinator {
		return errors.New("协调者不能直接操作资源")
	}
	if c.sre.Role == SREExecutor || c.sre.Role == SREVerifier && c.sre.Step.Action != nil {
		op := c.sre.Step.Action
		if op == nil || call.Name != op.Tool || js(a) != js(op.Arguments) {
			return errors.New("工具或参数与冻结的计划动作不一致")
		}
	}
	return nil
}

func (e *Engine) PrepareSREOperation(c Config, call Call, risk string) error {
	if !sreTrackedCall(c, call) {
		return nil
	}
	_, err := e.sreRepository.MutateSRETask(e.worker.parentID, c.sre.TaskID, 0, "operation_prepared", func(t *SRETask) error {
		for i := range t.Attempts {
			a := &t.Attempts[i]
			if a.ID != c.sre.AttemptID {
				continue
			}
			for _, op := range a.Operations {
				if op.Digest == hash(call.Name+call.Arguments) {
					if op.Call.ID != call.ID && op.Risk == "readonly" && risk == "readonly" && op.Status == "unknown" {
						continue // Fresh sampling, with a new durable call identity.
					}
					if op.Call.ID == call.ID && (op.Status == "prepared" || op.Status == "waiting_approval") {
						return nil
					}
					return sreError(409, "该操作已派发或结果未明，不能再次执行")
				}
			}
			if !c.sre.FullTools && len(a.Operations) > 0 {
				return sreError(409, "一个执行步骤只能派发一个冻结动作")
			}

			resource := c.AssetRef
			var arguments map[string]any
			_ = decodeSREJSON(call.Arguments, &arguments)
			if ref := str(arguments["asset_ref"]); ref != "" {
				resource = ref
			}
			if as, ae := asset(c, resource); ae == nil {
				resource = as.ID
			} else if len(c.sre.Step.ResourceIDs) > 0 {
				resource = c.sre.Step.ResourceIDs[0]
			}
			if c.sre.FullTools && risk != "readonly" {
				for _, previous := range t.Attempts {
					for _, op := range previous.Operations {
						if SREOperationBlocksResume(op) {
							return sreOperationBlockError(op)
						}
					}
				}
			}
			a.Operations = append(a.Operations, SREOperation{ID: uid(), Call: call, Digest: hash(call.Name + call.Arguments), ResourceID: resource, Risk: risk, Status: "prepared", PreparedAt: timestamp()})
			return nil
		}
		return sreError(409, "操作没有绑定到实际执行步骤")
	})
	return err
}
func (e *Engine) DispatchSREOperation(ctx context.Context, c Config, call Call) error {
	if !sreTrackedCall(c, call) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	resource := c.sre.Step.ResourceIDs[0]
	if c.sre.FullTools {
		var arguments map[string]any
		_ = decodeSREJSON(call.Arguments, &arguments)
		ref := str(arguments["asset_ref"])
		if ref == "" {
			ref = c.AssetRef
		}
		if ref != "" {
			as, err := asset(c, ref)
			if err != nil {
				return err
			}
			resource = as.ID
		}
	}
	value, _ := e.worker.parent.sreResourceLocks.LoadOrStore(resource, make(chan struct{}, 1))
	lock := value.(chan struct{})
	select {
	case lock <- struct{}{}:
	default:
		e.setSREActivity("waiting_resource", call.Name)
		select {
		case lock <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	e.setSREActivity("tool", call.Name)
	if err := ctx.Err(); err != nil {
		<-lock
		return err
	}
	_, err := e.sreRepository.MutateSRETask(e.worker.parentID, c.sre.TaskID, 0, "operation_dispatched", func(t *SRETask) error {
		if t.Status != "active" && t.Status != "waiting_approval" {
			return sreError(409, "任务已暂停或结束")
		}
		risk := "write"
		for _, attempt := range t.Attempts {
			if attempt.ID == c.sre.AttemptID {
				for _, op := range attempt.Operations {
					if op.Call.ID == call.ID {
						risk = op.Risk
					}
				}
			}
		}
		for _, attempt := range t.Attempts {
			for _, op := range attempt.Operations {
				if risk != "readonly" && SREOperationBlocksResume(op) {
					return sreOperationBlockError(op)
				}
			}
		}
		for i := range t.Attempts {
			a := &t.Attempts[i]
			if a.ID != c.sre.AttemptID {
				continue
			}
			for j := range a.Operations {
				op := &a.Operations[j]
				if op.Call.ID == call.ID && op.Digest == hash(call.Name+call.Arguments) {
					if op.Status != "prepared" && op.Status != "waiting_approval" {
						return sreError(409, "操作已派发，不会自动重放")
					}
					op.Status = "dispatched"
					op.ResourceID = resource
					op.DispatchedAt = timestamp()
					t.Status = "active"
					return nil
				}
			}
		}
		return sreError(409, "未登记的操作不能派发")
	})
	if err != nil {
		<-lock
	} else {
		c.sre.dispatchRelease = func() { <-lock }
	}
	return err
}
func (e *Engine) finishSREOperation(c Config, call Call, result any, toolErr error) {
	if !sreTrackedCall(c, call) {
		return
	}
	if release := c.sre.dispatchRelease; release != nil {
		defer release()
		c.sre.dispatchRelease = nil
	}
	_, _ = e.sreRepository.MutateSRETask(e.worker.parentID, c.sre.TaskID, 0, "operation_result", func(t *SRETask) error {
		for i := range t.Attempts {
			a := &t.Attempts[i]
			if a.ID != c.sre.AttemptID {
				continue
			}
			for j := range a.Operations {
				op := &a.Operations[j]
				if op.Call.ID != call.ID || op.Digest != hash(call.Name+call.Arguments) || op.Status != "dispatched" {
					continue
				}
				op.FinishedAt = timestamp()
				op.Result = utf8Prefix(redact(js(result), c), 8192)
				op.Status = "succeeded"
				if toolErr != nil {
					op.Status = "unknown"
					op.Result = redact(toolErr.Error(), c)
					var notExecuted *ToolNotExecutedError
					if errors.As(toolErr, &notExecuted) {
						op.Status = "not_executed"
					}
				}
				r := obj(result)
				if r["exitCode"] != nil && num(r["exitCode"], 0) != 0 {
					op.Status = "failed"
				}
				if r["status"] == "running" || r["status"] == "unknown" || r["running"] == true || r["shell_id"] != nil && r["exitCode"] == nil {
					op.Status = "unknown"
				}
				if toolErr == nil && r["status"] == "running" && str(r["terminal_id"]) != "" && str(r["entry_id"]) != "" {
					op.Status, op.FinishedAt = "dispatched", ""
				}
				if SREOperationNeedsVerification(*op) {
					t.Error = "操作结果不明，请核实实际状态；不会自动重放。"
				}
			}
		}
		return nil
	})
}

func (e *Engine) SREEvidence(sessionID, taskID, evidenceID string, offset, limit int) (map[string]any, error) {
	if limit < 4 || limit > 4096 || offset < 0 {
		return nil, sreError(400, "证据分页参数无效")
	}
	t, err := e.sreRepository.LoadSRETask(sessionID, taskID)
	if err != nil {
		return nil, err
	}
	s, err := e.get(sessionID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	c := s.state.Config
	c.ReferencedAssets = validRemembered(c, append(c.ReferencedAssets, s.state.ReferencedAssetIDs...))
	s.mu.Unlock()
	for _, a := range t.Attempts {
		for _, ev := range a.Evidence {
			if ev.ID != evidenceID {
				continue
			}
			if !assetVisible(c, ev.ResourceID) {
				return nil, sreError(403, "证据资源已不在当前引用范围")
			}
			if _, err := asset(c, ev.ResourceID); err != nil {
				return nil, sreError(403, "证据资源已不在当前授权范围")
			}
			if c.Permissions != nil && c.Permissions.DenyLocalExecution {
				as, _ := asset(c, ev.ResourceID)
				if as.Kind == "local" {
					return nil, sreError(403, "当前会话禁止访问本机证据")
				}
			}
			path, err := e.evidencePath(ev)
			if err != nil {
				return nil, err
			}
			data, err := readSREEvidenceFile(path)
			if err != nil {
				return nil, err
			}
			if offset > len(data) {
				return nil, sreError(400, "证据偏移超出原文")
			}
			if offset < len(data) && !utf8.RuneStart(data[offset]) {
				return nil, sreError(400, "证据偏移需在 UTF-8 字符边界")
			}
			end := min(len(data), offset+limit)
			for end > offset && end < len(data) && !utf8.RuneStart(data[end]) {
				end--
			}
			next := any(nil)
			if end < len(data) {
				next = end
			}
			return map[string]any{"id": ev.ID, "source": redact(string(data[offset:end]), c), "offset": offset, "nextCursor": next, "sourceBytes": len(data), "sourceTruncated": ev.SourceTruncated, "collectedAt": ev.CollectedAt}, nil
		}
	}
	return nil, sreError(404, "本任务中不存在该证据")
}

func IsSRERejection(err error) bool {
	return err != nil && strings.Contains(err.Error(), "user rejected")
}

// Tool errors may be followed by another model response. Persist the dispatch
// fact independently so prose can never turn a rejection into an execution.
func (e *Engine) finishSREPreparation(c Config, call Call, toolErr error) {
	if !sreTrackedCall(c, call) || toolErr == nil || errors.Is(toolErr, errADKApprovalPending) {
		return
	}
	_, _ = e.sreRepository.MutateSRETask(e.worker.parentID, c.sre.TaskID, 0, "operation_not_dispatched", func(t *SRETask) error {
		for i := range t.Attempts {
			if t.Attempts[i].ID != c.sre.AttemptID {
				continue
			}
			for j := range t.Attempts[i].Operations {
				op := &t.Attempts[i].Operations[j]
				if op.Call.ID != call.ID || op.Digest != hash(call.Name+call.Arguments) || (op.Status != "prepared" && op.Status != "waiting_approval") {
					continue
				}
				op.Status = "not_executed"
				if IsSRERejection(toolErr) {
					op.Status = "rejected"
				}
				op.Result = redact(toolErr.Error(), c)
				op.FinishedAt = timestamp()
			}
		}
		return nil
	})
}

// Ordinary conversations can inspect a tool-local deadline and keep chatting.
// A specialist must instead yield on a recorded unknown resource outcome; live
// persistent commands remain dispatched and can still be polled by their handle.
func (e *Engine) unknownSREOperation(c Config, call Call) error {
	if !sreTrackedCall(c, call) {
		return nil
	}
	task, err := e.sreRepository.LoadSRETask(e.worker.parentID, c.sre.TaskID)
	if err != nil {
		return err
	}
	for _, attempt := range task.Attempts {
		if attempt.ID != c.sre.AttemptID {
			continue
		}
		for _, op := range attempt.Operations {
			if op.Digest == hash(call.Name+call.Arguments) && SREOperationNeedsVerification(op) {
				return errors.New("操作结果不明，请核实实际状态；不会自动重放。")
			}
		}
	}
	return nil
}

func SREExecutionSummary(attempt SREStepAttempt) string {
	for _, op := range attempt.Operations {
		if SREOperationNeedsVerification(op) {
			return "操作结果待核实，任务已暂停；不会自动重放。"
		}
	}
	for _, op := range attempt.Operations {
		if op.Status == "dispatched" {
			return "原操作仍在执行，等待原命令结果；不会重复派发。"
		}
	}
	if sreReadCheckIncomplete(attempt) {
		return "只读检查未完成，可重新检查；尚未取得完整结果。"
	}
	for _, op := range attempt.Operations {
		if op.Status == "rejected" {
			return "本次操作已拒绝，未执行变更；任务已暂停。"
		}
	}
	for _, op := range attempt.Operations {
		if op.Status == "failed" {
			return "操作返回失败，任务已暂停；尚未通过验收。"
		}
	}
	if len(attempt.Operations) > 0 {
		all := true
		for _, op := range attempt.Operations {
			all = all && op.Status == "succeeded"
		}
		if all {
			return "绑定操作已执行成功；是否满足验收条件由独立验证结果确定。"
		}
	}
	return "未完成绑定的实际操作；任务已暂停，未通过验收。"
}
