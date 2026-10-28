package ai

import (
	"errors"
	"os"
	"path/filepath"
)

// Separate optional envelope distinguishes old projections from an intentionally
// empty outbox. Recovery never mines old user/history content for new consent.
type nativeMemoryProjection struct {
	Version      int                              `json:"version"`
	Outbox       []MemoryTurnSnapshot             `json:"outbox,omitempty"`
	Capture      *MemoryCaptureState              `json:"capture,omitempty"`
	Acknowledged map[string]string                `json:"acknowledged,omitempty"`
	Evidence     map[string]MemoryEvidenceContext `json:"evidence,omitempty"`
	Recent       []string                         `json:"recent,omitempty"`
}

func memoryProjection(state State) *nativeMemoryProjection {
	return &nativeMemoryProjection{Version: 1, Outbox: state.MemoryOutbox, Capture: state.MemoryCapture, Acknowledged: state.MemoryAcknowledged, Evidence: state.MemoryEvidenceContexts, Recent: state.MemoryRecentUserInputs}
}
func restoreMemoryProjection(state *State, p *nativeMemoryProjection) error {
	if p == nil {
		return nil
	}
	if p.Version != 1 || p.Capture != nil && p.Capture.Version != 1 {
		return errors.New("unsupported Lake Memory projection version")
	}
	// An idle outbox ACK updates the cache without reserving/blocking a foreground
	// turn. Retain exact local receipts while loading the preceding ADK projection.
	receipts := map[string]string{}
	for k, v := range p.Acknowledged {
		receipts[k] = v
	}
	for k, v := range state.MemoryAcknowledged {
		receipts[k] = v
	}
	state.MemoryOutbox = nil
	state.MemoryAcknowledged = map[string]string{}
	for _, snapshot := range p.Outbox {
		if receipts[snapshot.TurnID] == snapshot.SnapshotHash {
			state.MemoryAcknowledged[snapshot.TurnID] = snapshot.SnapshotHash
			continue
		}
		state.MemoryOutbox = append(state.MemoryOutbox, snapshot)
	}
	state.MemoryCapture = p.Capture
	state.MemoryEvidenceContexts = p.Evidence
	state.MemoryRecentUserInputs = p.Recent
	return nil
}

// Startup discovers missing caches by the existing ADK migration index, not by
// interpreting conversation events. Old projections without Memory remain old.
func (e *Engine) restoreMissingMemoryCaches() error {
	if _, err := os.Stat(filepath.Join(e.runtimeDirectory(), "sessions.sqlite")); os.IsNotExist(err) {
		return nil
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var ids []string
	if err = store.DB.Model(&nativeHistoryMigration{}).Where("status = ?", "complete").Distinct("session_id").Pluck("session_id", &ids).Error; err != nil {
		return err
	}
	for _, id := range ids {
		if !identifier.MatchString(id) {
			continue
		}
		if _, err := os.Stat(filepath.Join(e.Dir, id+".json")); !os.IsNotExist(err) {
			continue
		}
		// A corrupt/unavailable session must not prevent unrelated projects starting.
		_, _ = e.get(id)
	}
	return nil
}
