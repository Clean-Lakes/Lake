package ai

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type StrategyEvidence struct {
	CallID     string `json:"callId"`
	Tool       string `json:"tool"`
	Status     string `json:"status"`
	ResultHash string `json:"resultHash"`
}
type StrategyTurnSnapshot struct {
	Deferred            bool               `json:"deferred,omitempty"`
	HistoryStart        int                `json:"historyStart,omitempty"`
	HistoryEnd          int                `json:"historyEnd,omitempty"`
	UserTextHash        string             `json:"userTextHash,omitempty"`
	UserMessageID       string             `json:"userMessageId"`
	SessionID           string             `json:"sessionId"`
	ProjectID           string             `json:"projectId"`
	TurnID              string             `json:"turnId"`
	StartedAt           string             `json:"startedAt"`
	FinishedAt          string             `json:"finishedAt"`
	GlobalEpoch         int64              `json:"globalEpoch"`
	ProjectEpoch        int64              `json:"projectEpoch"`
	Status              string             `json:"status"`
	Profile             string             `json:"profile"`
	UserText            string             `json:"userText"`
	AssistantText       string             `json:"assistantText"`
	Evidence            []StrategyEvidence `json:"evidence"`
	IgnoreProjectMemory bool               `json:"ignoreProjectMemory,omitempty"`
	Correction          bool               `json:"correction"`
	ModelRef            string             `json:"modelRef"`
	SnapshotHash        string             `json:"snapshotHash"`
}

func SealStrategySnapshot(s StrategyTurnSnapshot) StrategyTurnSnapshot {
	s.SnapshotHash = ""
	s.SnapshotHash = hash(js(s))
	return s
}
func ValidStrategySnapshot(s StrategyTurnSnapshot) bool {
	return s.UserMessageID != "" && s.SessionID != "" && s.ProjectID != "" && s.TurnID != "" && len(js(s)) <= 32768 && s.SnapshotHash == SealStrategySnapshot(s).SnapshotHash && (s.Status == "completed" || s.Status == "failed")
}

func (e *Engine) StrategyOutbox(id string) ([]StrategyTurnSnapshot, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]StrategyTurnSnapshot{}, s.state.StrategyOutbox...), nil
}

// The host commits a separate durable handoff receipt before acknowledging.
// Never rewrite the canonical session/projection for optional queue housekeeping.
func (e *Engine) AckStrategyOutbox(id, turn, digest string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, item := range s.state.StrategyOutbox {
		if item.TurnID == turn {
			if item.SnapshotHash != digest {
				return errors.New("strategy snapshot conflict")
			}
			s.state.StrategyOutbox = append(s.state.StrategyOutbox[:i], s.state.StrategyOutbox[i+1:]...)
			break
		}
	}
	return nil
}
func (e *Engine) PendingStrategySessions() []string {
	e.mu.Lock()
	sessions := make([]*session, 0, len(e.sessions))
	for _, s := range e.sessions {
		sessions = append(sessions, s)
	}
	e.mu.Unlock()
	ids := []string{}
	for _, s := range sessions {
		if !s.mu.TryLock() {
			continue
		}
		if s.cancel == nil && !s.finalizing && len(s.state.StrategyOutbox) > 0 {
			ids = append(ids, s.state.View.Session)
		}
		s.mu.Unlock()
	}
	return ids
}
func (e *Engine) PersistedStrategyOutboxes() ([]StrategyTurnSnapshot, error) {
	entries, err := os.ReadDir(e.Dir)
	if err != nil {
		return nil, err
	}
	out := []StrategyTurnSnapshot{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !identifier.MatchString(strings.TrimSuffix(entry.Name(), ".json")) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(e.Dir, entry.Name()))
		if err != nil {
			continue
		}
		var state struct {
			StrategyOutbox []StrategyTurnSnapshot `json:"strategyOutbox"`
		}
		if json.Unmarshal(raw, &state) == nil {
			out = append(out, state.StrategyOutbox...)
		}
	}
	return out, nil
}

// One auxiliary completion, without session, tools or feedback into learning.
func StrategyLearningInputBytes(messages []Message) int { return historyCost(messages) }
