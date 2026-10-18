package ai

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"gorm.io/gorm"
)

func (e *Engine) runtimeDirectory() string {
	if e.worker != nil {
		return e.worker.parent.runtimeDirectory()
	}
	if e.RuntimeDir != "" {
		return e.RuntimeDir
	}
	return filepath.Join(e.Dir, "adk")
}

// appendNativeEvidence writes canonical audit data and its append-only export.
// The caller owns the database transaction, serializing the file append with
// operation/approval transitions. Failure before dispatch aborts that transition.
func (e *Engine) appendNativeEvidence(tx *gorm.DB, record *nativeEvidence) error {
	if err := tx.Create(record).Error; err != nil {
		return err
	}
	dir := filepath.Join(e.runtimeDirectory(), record.SessionID)
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return err
	}
	path := filepath.Join(dir, "evidence.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = platform.Chmod(path, 0600); err != nil {
		return err
	}
	event := map[string]any{"id": record.ID, "operation_id": record.OperationID, "call_id": record.CallID, "session_id": record.SessionID, "tool": record.Tool, "status": record.Status, "at": record.At, "data": record.Data}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err = f.Write(append(data, '\n')); err != nil {
		return err
	}
	return f.Sync()
}
