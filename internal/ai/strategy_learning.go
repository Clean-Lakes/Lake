package ai

import (
	"context"
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

func StrategyCorrectionSignal(text string) bool {
	text = strings.TrimSpace(text)
	for _, p := range []string{"纠正一下", "请纠正", "更正一下", "请记住", "以后请", "以后不要", "下次请", "下次不要", "Correction:", "Please remember ", "Next time, "} {
		if strings.HasPrefix(text, p) {
			return true
		}
	}
	return false
}
func SealStrategySnapshot(s StrategyTurnSnapshot) StrategyTurnSnapshot {
	s.SnapshotHash = ""
	s.SnapshotHash = hash(js(s))
	return s
}
func ValidStrategySnapshot(s StrategyTurnSnapshot) bool {
	return s.UserMessageID != "" && s.SessionID != "" && s.ProjectID != "" && s.TurnID != "" && len(js(s)) <= 32768 && s.SnapshotHash == SealStrategySnapshot(s).SnapshotHash && (s.Status == "completed" || s.Status == "failed")
}
func (e *Engine) collectStrategySnapshot(s *session, c Config, input TurnInput, status string) {
	if input.StrategyMessageID == "" || e.worker != nil || !c.StrategyLearnEnabled || c.workflowMode || c.sreCoordinator || c.agentRole != "" || c.MemoryProjectID == "" || len(s.state.StrategyOutbox) >= 20 || len(s.state.View.PendingApprovals) > 0 || (status != "completed" && status != "failed") || redact(input.UserText, c) != input.UserText || len(input.UserText) > 8192 {
		return
	}
	snapshot := StrategyTurnSnapshot{UserMessageID: input.StrategyMessageID, SessionID: s.state.View.Session, ProjectID: c.MemoryProjectID, TurnID: s.state.View.RootTurnID, StartedAt: s.state.View.TurnStartedAt, FinishedAt: s.state.View.TurnFinishedAt, GlobalEpoch: c.StrategyGlobalEpoch, ProjectEpoch: c.StrategyProjectEpoch, Status: status, Profile: c.Profile, UserText: input.UserText, IgnoreProjectMemory: input.IgnoreProjectMemory, Correction: StrategyCorrectionSignal(input.UserText), ModelRef: ModelIdentity(c.Model), Evidence: []StrategyEvidence{}}
	start := 0
	if len(s.state.Checkpoints) > 0 {
		start = s.state.Checkpoints[len(s.state.Checkpoints)-1]
	}
	if start < 0 || start > len(s.state.History) {
		return
	}
	paired := map[string]string{}
	failed := false
	for _, msg := range s.state.History[start:] {
		for _, call := range msg.Calls {
			paired[call.ID] = call.Name
		}
		if msg.Role == "assistant" && len(msg.Calls) == 0 {
			snapshot.AssistantText, _ = memoryUTF8Prefix(redact(msg.Content, c), 8192)
		}
		if msg.Role != "tool" || msg.Name == onlineRevisionTool || paired[msg.CallID] != msg.Name || msg.CallID == "" || len(snapshot.Evidence) >= 24 {
			continue
		}
		status := "unverified"
		var result map[string]any
		if json.Unmarshal([]byte(msg.Content), &result) == nil {
			switch str(result["status"]) {
			case "failed", "unknown", "cancelled", "not_executed":
				status = str(result["status"])
			}
			if strings.HasPrefix(str(result["outcome"]), "unknown") {
				status = "unknown"
			} else if status == "unverified" && result["error"] != nil && result["error"] != false && result["error"] != "" {
				status = "failed"
			}
		}
		failed = failed || status == "failed"
		snapshot.Evidence = append(snapshot.Evidence, StrategyEvidence{CallID: msg.CallID, Tool: msg.Name, Status: status, ResultHash: hash(msg.Content)})
	}
	// Explicit correction or a real paired tool failure, never sentiment alone.
	if !snapshot.Correction && !failed {
		return
	}
	s.state.StrategyOutbox = append(s.state.StrategyOutbox, SealStrategySnapshot(snapshot))
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
func (e *Engine) AckStrategyOutbox(id, turn, digest string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	for i, item := range s.state.StrategyOutbox {
		if item.TurnID == turn {
			if item.SnapshotHash != digest {
				s.mu.Unlock()
				return errors.New("strategy snapshot conflict")
			}
			s.state.StrategyOutbox = append(s.state.StrategyOutbox[:i], s.state.StrategyOutbox[i+1:]...)
			err = e.save(s)
			break
		}
	}
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return e.persistNativeProjection(context.Background(), s)
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
func (e *Engine) ExtractStrategyProposal(ctx context.Context, m Model, messages []Message) (string, Usage, error) {
	if len(messages) != 2 || messages[0].Role != "system" || messages[1].Role != "user" {
		return "", Usage{}, errors.New("invalid strategy extraction input")
	}
	return e.sideCompletion(ctx, m, messages, "strategy context budget exceeded")
}
