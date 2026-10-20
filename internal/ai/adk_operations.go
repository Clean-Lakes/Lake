package ai

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

type nativeOperation struct {
	ID          string `gorm:"primaryKey"`
	SessionID   string `gorm:"index"`
	RootTurnID  string
	CallID      string
	Tool        string
	ArgsHash    string
	Identity    string
	Target      string
	Fingerprint string
	Risk        string
	Status      string `gorm:"index"`
	Result      string
	Handle      string `gorm:"index"`
	StartedAt   time.Time
	FinishedAt  *time.Time
}

// nativeEvidence is append-only application audit data. It shares a transaction
// with each operation transition, so audit failure prevents dispatch.
type nativeEvidence struct {
	ID          uint64 `gorm:"primaryKey;autoIncrement"`
	OperationID string `gorm:"index"`
	SessionID   string `gorm:"index"`
	CallID      string
	Tool        string
	Status      string
	Data        string
	At          time.Time
}

type nativeOperationBlockedError struct {
	ID, Tool, Target, Status, Handle string
}

func (e *nativeOperationBlockedError) recovery() map[string]any {
	terminal, entry, ok := strings.Cut(e.Handle, ":")
	if e.Tool == "shell" && ok && terminal != "" && entry != "" {
		// shell_output is advertised to the model and accepts this exact
		// operation ID. terminal_command_status is an internal bridge API.
		return map[string]any{"tool": "shell_output", "arguments": map[string]any{"shell_id": e.ID}}
	}
	return nil
}

func (e *nativeOperationBlockedError) Error() string {
	hint := "请核实原操作实际结果"
	if e.recovery() != nil {
		hint = "可用 shell_output 读取 shell_id=" + e.ID + " 的原命令记录"
	}
	return fmt.Sprintf("操作未派发：原操作 %s（%s，目标：%s，状态：%s）仍需核实。可继续只读检查；%s。不要更换终端或入口重复尝试，调整权限不会解除此保护", e.ID, e.Tool, e.Target, e.Status, hint)
}

func (e *Engine) dispatchNativeOperation(ctx context.Context, s *session, c Config, call Call, risk, target, fingerprint string) (*nativeOperation, error) {
	if ctx.Value(adkToolContextKey{}) == nil {
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	identity := RunIdentity{SessionID: s.state.View.Session, RootTurnID: s.state.View.RootTurnID}
	if s.state.Runtime != nil {
		identity = s.state.Runtime.Identity
	}
	scopeID, turnID := s.state.View.Session, s.state.View.RootTurnID
	s.mu.Unlock()
	if err := e.reconcileNativeOperations(ctx, identity.SessionID); err != nil {
		return nil, err
	}
	if c.sre != nil && e.sreRepository != nil {
		task, err := e.sreRepository.LoadSRETask(identity.SessionID, c.sre.TaskID)
		if err != nil {
			return nil, err
		}
		for _, a := range task.Attempts {
			if a.ID == c.sre.AttemptID {
				for _, op := range a.Operations {
					if op.Call.ID == call.ID {
						identity.OperationID = op.ID
					}
				}
			}
		}
	}
	operation := &nativeOperation{ID: hash(identity.SessionID + "\x00" + identity.ScopeID + "\x00" + identity.RootTurnID + "\x00" + call.ID), SessionID: identity.SessionID, RootTurnID: identity.RootTurnID, CallID: call.ID, Tool: call.Name, ArgsHash: hash(call.Arguments), Identity: js(identity), Risk: risk, Target: target, Fingerprint: fingerprint, Status: "dispatched", StartedAt: time.Now()}
	if identity.OperationID != "" {
		operation.ID = identity.OperationID
	}
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		if risk != "readonly" {
			var blocking nativeOperation
			err := tx.Where("session_id = ? AND status IN ? AND risk <> ?", operation.SessionID, []string{"unknown", "dispatched"}, "readonly").Order("started_at, id").First(&blocking).Error
			if err == nil {
				return &nativeOperationBlockedError{ID: blocking.ID, Tool: blocking.Tool, Target: utf8Prefix(redact(blocking.Target, c), 120), Status: blocking.Status, Handle: blocking.Handle}
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
		}
		var prior nativeOperation
		query := tx.First(&prior, "id = ?", operation.ID)
		if query.Error == nil {
			return errors.New("操作已派发或结果未明，不能再次执行")
		}
		if !errors.Is(query.Error, gorm.ErrRecordNotFound) {
			return query.Error
		}
		approvalCallID := call.ID
		if original, ok := ctx.Value(adkApprovalCallKey{}).(string); ok {
			approvalCallID = original
		}
		if err := e.claimNativeApprovals(tx, scopeID, turnID, approvalCallID, operation.ID); err != nil {
			return err
		}
		if err := tx.Create(operation).Error; err != nil {
			return err
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{OperationID: operation.ID, SessionID: operation.SessionID, CallID: call.ID, Tool: call.Name, Status: "started", Data: js(map[string]any{"args_hash": operation.ArgsHash, "target": target, "risk": risk}), At: time.Now()})
	})
	return operation, err
}

func (e *Engine) finishNativeOperation(operation *nativeOperation, c Config, value any, toolErr error) error {
	if operation == nil {
		return nil
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	result := obj(value)
	status := "succeeded"
	if toolErr != nil {
		status = "unknown"
		var notExecuted *ToolNotExecutedError
		if errors.As(toolErr, &notExecuted) {
			status = "not_executed"
		}
	}
	if result["exitCode"] != nil && num(result["exitCode"], 0) != 0 {
		status = "failed"
	}
	handle := str(result["shell_id"])
	if id := str(result["terminal_id"]); id != "" && str(result["entry_id"]) != "" {
		handle = id + ":" + str(result["entry_id"])
	}
	if result["status"] == "running" || result["running"] == true {
		status = "unknown"
		if handle != "" {
			status = "dispatched"
		}
	}
	if result["status"] == "unknown" {
		status = "unknown"
	}
	body := utf8Prefix(redact(js(value), c), 32000)
	if toolErr != nil {
		body = utf8Prefix(redact(toolErr.Error(), c), 32000)
	}
	now := time.Now()
	updates := map[string]any{"status": status, "result": body, "handle": handle, "finished_at": now}
	if status == "dispatched" {
		updates["finished_at"] = nil
	}
	return store.DB.Transaction(func(tx *gorm.DB) error {
		updated := tx.Model(&nativeOperation{}).Where("id = ? AND status = ?", operation.ID, "dispatched").Updates(updates)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return errors.New("operation result did not match a dispatched operation")
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{OperationID: operation.ID, SessionID: operation.SessionID, CallID: operation.CallID, Tool: operation.Tool, Status: map[string]string{"succeeded": "completed", "dispatched": "running", "unknown": "unknown", "failed": "failed", "not_executed": "not_executed"}[status], Data: body, At: now})
	})
}
