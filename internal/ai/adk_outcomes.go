package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm"
)

type OperationOutcome struct {
	ID        string    `json:"id"`
	Tool      string    `json:"tool"`
	Target    string    `json:"target"`
	Status    string    `json:"status"`
	Handle    string    `json:"handle,omitempty"`
	Result    string    `json:"result,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

func (e *Engine) OperationOutcomes(id string) ([]OperationOutcome, error) {
	if !identifier.MatchString(id) {
		return nil, errors.New("invalid session id")
	}
	// Legacy/idle views do not open and migrate a database merely to poll UI.
	if _, err := os.Stat(filepath.Join(e.runtimeDirectory(), "sessions.sqlite")); os.IsNotExist(err) {
		return []OperationOutcome{}, nil
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := e.reconcileNativeOperations(ctx, id); err != nil {
		return nil, err
	}
	var rows []nativeOperation
	// Dispatched operations still have a live execution path and use the normal
	// progress UI. Only effects whose outcome is unknown need human verification.
	// The dispatch guard independently checks both states to prevent replay.
	if err = store.DB.Where("session_id = ? AND status = ? AND risk <> ?", id, "unknown", "readonly").Order("started_at").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]OperationOutcome, 0, len(rows))
	for _, row := range rows {
		out = append(out, OperationOutcome{ID: row.ID, Tool: row.Tool, Target: row.Target, Status: row.Status, Handle: row.Handle, Result: row.Result, StartedAt: row.StartedAt})
	}
	return out, nil
}

// ResolveOperation is a human-only host command; it is absent from every model
// tool catalog. Resolving a fact never executes or retries its original call.
func (e *Engine) ResolveOperation(id, operationID, status, note string) error {
	if status != "succeeded" && status != "failed" && status != "not_executed" {
		return errors.New("invalid verified operation outcome")
	}
	if strings.TrimSpace(note) == "" || len(note) > 4000 {
		return errors.New("填写实际核实依据，最多 4000 字节")
	}
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return errors.New("先停止当前运行，再核实原操作")
	}
	c := s.state.Config
	s.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var row nativeOperation
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&row, "id = ? AND session_id = ?", operationID, id).Error; err != nil {
			return err
		}
		if row.Status != "unknown" {
			return errors.New("操作仍在运行或已核实，不能覆盖结果")
		}
		now := time.Now()
		result := redact("用户核实："+note, c)
		updated := tx.Model(&nativeOperation{}).Where("id = ? AND status = ?", row.ID, "unknown").Updates(map[string]any{"status": status, "result": result, "finished_at": now})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return errors.New("操作状态已变化")
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{OperationID: row.ID, SessionID: id, CallID: row.CallID, Tool: row.Tool, Status: "resolved_" + status, Data: result, At: now})
	})
	if err != nil {
		return err
	}
	var identity RunIdentity
	_ = json.Unmarshal([]byte(row.Identity), &identity)
	if identity.TaskID != "" && e.sreRepository != nil {
		_, err = e.sreRepository.MutateSRETask(id, identity.TaskID, 0, "canonical_operation_resolved", func(t *SRETask) error {
			for i := range t.Attempts {
				for j := range t.Attempts[i].Operations {
					op := &t.Attempts[i].Operations[j]
					if op.ID == row.ID {
						op.Status = status
						op.Result = redact(note, c)
						op.ResolutionNote = redact(note, c)
						op.ResolvedBy = "user"
						op.ResolvedAt = timestamp()
						op.FinishedAt = timestamp()
					}
				}
			}
			return nil
		})
	}
	if err == nil && e.Emit != nil {
		e.Emit(Event{Session: id, Type: "operationResolved"})
	}
	return err
}

// Only an exact durable handle can reconcile a command. Command text or a new
// invocation is never used to infer that an older write succeeded.
func (e *Engine) reconcileNativeOperations(ctx context.Context, id string) error {
	if err := e.reconcilePreflightOutcomes(ctx, id); err != nil {
		return err
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var rows []nativeOperation
	if err = store.DB.Where("session_id = ? AND status IN ? AND handle <> ?", id, []string{"unknown", "dispatched"}, "").Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		var value any
		var observationErr error
		terminal, entry, ok := strings.Cut(row.Handle, ":")
		if ok && e.Bridge != nil {
			value, observationErr = e.Bridge(ctx, id, "terminal_command_status", map[string]any{"terminal_id": terminal, "entry_id": entry}, false)
		} else if job, ok := e.shells.Load(id + ":" + row.Handle); ok {
			j := job.(*shellJob)
			j.mu.Lock()
			if j.status != "running" {
				value, observationErr = j.result, j.err
			}
			j.mu.Unlock()
		}
		if observationErr != nil || value == nil {
			continue
		}
		result := obj(value)
		if result["running"] == true || result["status"] == "running" || result["exitCode"] == nil {
			continue
		}
		status := "succeeded"
		if num(result["exitCode"], 0) != 0 {
			status = "failed"
		}
		now := time.Now()
		if err = store.DB.Transaction(func(tx *gorm.DB) error {
			updated := tx.Model(&nativeOperation{}).Where("id = ? AND status IN ?", row.ID, []string{"unknown", "dispatched"}).Updates(map[string]any{"status": status, "finished_at": now})
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected == 0 {
				return nil
			}
			return e.appendNativeEvidence(tx, &nativeEvidence{OperationID: row.ID, SessionID: id, CallID: row.CallID, Tool: row.Tool, Status: "handle_reconciled_" + status, Data: js(map[string]any{"handle": row.Handle, "exitCode": result["exitCode"]}), At: now})
		}); err != nil {
			return err
		}
	}
	return nil
}

// Older versions classified rejected file preconditions and the trusted shell
// target check as unknown effects. These exact errors precede command dispatch.
// Never infer success, repair a generic process error, or release a live handle.
func (e *Engine) reconcilePreflightOutcomes(ctx context.Context, id string) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	return store.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rows []nativeOperation
		if err := tx.Where("session_id = ? AND status = ? AND handle = ?", id, "unknown", "").Where("(tool IN ? AND result IN ?) OR (tool = ? AND result = ?)", []string{"write", "edit", "multi_edit", "append", "delete"}, []string{"file changed since read; expected_hash mismatch", "file changed after preview; approval expired"}, "shell", "Shell runtime and asset do not match").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			var identity RunIdentity
			if json.Unmarshal([]byte(row.Identity), &identity) != nil || identity.TaskID != "" {
				continue
			}
			if row.Tool == "shell" && (identity.SessionID != row.SessionID || identity.RootTurnID == "" || identity.RootTurnID != row.RootTurnID) {
				continue
			}
			now := time.Now()
			updated := tx.Model(&nativeOperation{}).Where("id = ? AND status = ? AND handle = ? AND result = ?", row.ID, "unknown", "", row.Result).Updates(map[string]any{"status": "not_executed", "finished_at": now})
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected == 1 {
				if err := e.appendNativeEvidence(tx, &nativeEvidence{OperationID: row.ID, SessionID: row.SessionID, CallID: row.CallID, Tool: row.Tool, Status: "preflight_reconciled_not_executed", Data: js(map[string]any{"reason": row.Result, "effect_dispatched": false}), At: now}); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// Legacy SRE records have no canonical runtime row. New records share the
// canonical ID and must resolve both projections before writes can continue.
func (e *Engine) ResolveRecordedOperation(id, operationID, status, note string) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var row nativeOperation
	err = store.DB.First(&row, "id = ? AND session_id = ?", operationID, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.Status == status {
		return nil
	}
	return e.ResolveOperation(id, operationID, status, note)
}
