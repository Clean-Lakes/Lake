package ai

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type MemoryEvidence struct {
	CallID    string                 `json:"callId"`
	Name      string                 `json:"name"`
	Excerpt   string                 `json:"excerpt"`
	Completed bool                   `json:"completed"`
	Truncated bool                   `json:"truncated,omitempty"`
	Context   *MemoryEvidenceContext `json:"context,omitempty"`
}

type MemoryResourceBinding struct {
	ResourceID string `json:"resourceId"`
	Generation int    `json:"generation"`
}

// Constructed by the executor after target resolution, never decoded from model
// arguments or tool stdout. Completed execution does not establish semantic truth.
type MemoryEvidenceContext struct {
	CallID           string                  `json:"callId"`
	EvidenceID       string                  `json:"evidenceId,omitempty"`
	ResourceBindings []MemoryResourceBinding `json:"resourceBindings"`
	StartedAt        string                  `json:"startedAt"`
	FinishedAt       string                  `json:"finishedAt"`
	Outcome          string                  `json:"outcome"`
	ExitCode         *int                    `json:"exitCode,omitempty"`
	Truncated        bool                    `json:"truncated,omitempty"`
	ClaimSupport     string                  `json:"claimSupport"`
	Excerpt          string                  `json:"excerpt,omitempty"`
	Claims           []MemoryClaim           `json:"claims,omitempty"`
}

type MemoryTurnSnapshot struct {
	SchemaVersion         int                     `json:"schemaVersion,omitempty"`
	SourceMessageID       string                  `json:"sourceMessageId,omitempty"`
	TargetBindings        []MemoryResourceBinding `json:"targetBindings,omitempty"`
	ProjectID             string                  `json:"projectId"`
	SessionID             string                  `json:"sessionId"`
	TurnID                string                  `json:"turnId"`
	Epoch                 int                     `json:"epoch"`
	KnowledgeBaseRevision int                     `json:"knowledgeBaseRevision"`
	UserText              string                  `json:"userText"`
	RecentUserInputs      []string                `json:"recentUserInputs,omitempty"`
	AssistantText         string                  `json:"assistantText"`
	Evidence              []MemoryEvidence        `json:"evidence,omitempty"`
	ModelRef              string                  `json:"modelRef"`
	CapturedAt            string                  `json:"capturedAt"`
	SnapshotHash          string                  `json:"snapshotHash"`
}

func memorySignal(text string) bool {
	count := 0
	for _, r := range strings.TrimSpace(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			count++
		}
	}
	if count < 4 {
		return false
	}
	if IsBriefConversation(text) {
		for _, prefix := range []string{"记住", "请记住", "以后", "忘记", "remember", "forget"} {
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(text)), prefix) {
				return true
			}
		}
		return false
	}
	return true
}

func memoryUTF8Prefix(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit], true
}

func (e *Engine) collectMemorySnapshot(s *session, c Config, input TurnInput) {
	if c.ConversationMode == ModePlan || e.worker != nil || !c.MemoryEnabled || !c.MemoryExtractionEnabled || c.MemoryProjectID == "" || input.IgnoreProjectMemory || len(input.UserText) > 64*1024 {
		return
	}
	recent := append([]string(nil), s.state.MemoryRecentUserInputs...)
	current, _ := memoryUTF8Prefix(redact(input.UserText, c), 2048)
	s.state.MemoryRecentUserInputs = append(s.state.MemoryRecentUserInputs, current)
	if len(s.state.MemoryRecentUserInputs) > 3 {
		s.state.MemoryRecentUserInputs = s.state.MemoryRecentUserInputs[len(s.state.MemoryRecentUserInputs)-3:]
	}
	if !memorySignal(input.UserText) {
		return
	}
	if len(s.state.MemoryOutbox) >= 20 {
		s.state.View.MemoryStatus = "backlog_full"
		return
	}
	s.state.View.MemoryStatus = ""
	start := 0
	if len(s.state.Checkpoints) > 0 {
		start = s.state.Checkpoints[len(s.state.Checkpoints)-1]
	}
	if start < 0 || start > len(s.state.History) {
		return
	}
	segment := s.state.History[start:]
	for _, message := range segment {
		for _, call := range message.Calls {
			if call.Name == "save_project_memory" || call.Name == "forget_project_memory" {
				return
			}
		}
	}
	snapshot := MemoryTurnSnapshot{ProjectID: c.MemoryProjectID, SessionID: s.state.View.Session, TurnID: s.state.View.RootTurnID, Epoch: c.MemoryEpoch, KnowledgeBaseRevision: c.MemoryKnowledgeRevision, UserText: redact(input.UserText, c), RecentUserInputs: recent, ModelRef: ModelIdentity(c.Model), CapturedAt: s.state.View.TurnFinishedAt}
	if c.MemorySchemaVersion == 2 {
		snapshot.SchemaVersion = 2
		snapshot.SourceMessageID = input.StrategyMessageID
		refs := c.ReferencedAssets
		if c.targetScope != nil {
			if c.targetScope.NeedsClarification {
				refs = nil
			} else {
				refs = c.targetScope.ResourceIDs
			}
		}
		for _, ref := range refs {
			if generation := c.MemoryResourceGenerations[ref]; generation > 0 {
				snapshot.TargetBindings = append(snapshot.TargetBindings, MemoryResourceBinding{ResourceID: ref, Generation: generation})
			}
		}
	}
	for i := len(segment) - 1; i >= 0; i-- {
		if segment[i].Role == "assistant" && len(segment[i].Calls) == 0 {
			snapshot.AssistantText, _ = memoryUTF8Prefix(redact(segment[i].Content, c), 24*1024)
			break
		}
	}
	if snapshot.AssistantText == "" {
		return
	}
	usedEvidence := 0
	for _, message := range segment {
		if message.Role != "tool" || len(snapshot.Evidence) >= 24 || usedEvidence >= 24*1024 {
			continue
		}
		text := redact(message.Content, c)
		excerpt, truncated := memoryUTF8Prefix(text, min(2048, 24*1024-usedEvidence))
		usedEvidence += len(excerpt)
		var result map[string]any
		valid := json.Unmarshal([]byte(text), &result) == nil && result != nil
		completed := valid && memoryEvidenceEligible(result, nil) == "completed_success"
		evidence := MemoryEvidence{CallID: message.CallID, Name: message.Name, Excerpt: excerpt, Completed: completed, Truncated: truncated}
		if snapshot.SchemaVersion == 2 {
			if trusted, ok := s.state.MemoryEvidenceContexts[message.CallID]; ok {
				evidence.Context = &trusted
				evidence.Completed = trusted.Outcome == "completed_success"
			} else {
				evidence.Completed = false
			}
		}
		snapshot.Evidence = append(snapshot.Evidence, evidence)
	}
	if snapshot.SchemaVersion == 2 {
		keys := []string{}
		for key := range s.state.MemoryEvidenceContexts {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			trusted := s.state.MemoryEvidenceContexts[key]
			if trusted.EvidenceID == "" || len(snapshot.Evidence) >= 24 || usedEvidence >= 24*1024 {
				continue
			}
			excerpt, truncated := memoryUTF8Prefix(trusted.Excerpt, min(2048, 24*1024-usedEvidence))
			usedEvidence += len(excerpt)
			snapshot.Evidence = append(snapshot.Evidence, MemoryEvidence{CallID: key, Name: "recorded_observation", Excerpt: excerpt, Completed: trusted.Outcome == "completed_success", Truncated: truncated, Context: &trusted})
		}
	}
	bytes, _ := json.Marshal(snapshot)
	if len(bytes) > 128*1024 {
		return
	}
	snapshot.SnapshotHash = hash(string(bytes))
	s.state.MemoryOutbox = append(s.state.MemoryOutbox, snapshot)
}

func (e *Engine) MemoryOutbox(id string) ([]MemoryTurnSnapshot, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]MemoryTurnSnapshot(nil), s.state.MemoryOutbox...), nil
}

func (e *Engine) AckMemoryOutbox(id, turnID, snapshotHash string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, snapshot := range s.state.MemoryOutbox {
		if snapshot.TurnID != turnID {
			continue
		}
		if snapshot.SnapshotHash != snapshotHash {
			return errors.New("memory snapshot conflict")
		}
		s.state.MemoryOutbox = append(s.state.MemoryOutbox[:i], s.state.MemoryOutbox[i+1:]...)
		return e.save(s)
	}
	return nil
}

func (e *Engine) PersistedMemoryOutboxes() ([]MemoryTurnSnapshot, error) {
	entries, err := os.ReadDir(e.Dir)
	if err != nil {
		return nil, err
	}
	var out []MemoryTurnSnapshot
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !identifier.MatchString(strings.TrimSuffix(entry.Name(), ".json")) {
			continue
		}
		bytes, err := os.ReadFile(filepath.Join(e.Dir, entry.Name()))
		if err != nil {
			continue
		}
		var state struct {
			MemoryOutbox []MemoryTurnSnapshot `json:"memoryOutbox"`
		}
		if json.Unmarshal(bytes, &state) == nil {
			out = append(out, state.MemoryOutbox...)
		}
	}
	return out, nil
}

func ValidMemorySnapshot(snapshot MemoryTurnSnapshot) bool {
	if snapshot.ProjectID == "" || snapshot.SessionID == "" || snapshot.TurnID == "" || snapshot.SnapshotHash == "" {
		return false
	}
	claimed := snapshot.SnapshotHash
	snapshot.SnapshotHash = ""
	bytes, err := json.Marshal(snapshot)
	return err == nil && claimed == hash(string(bytes))
}

func SealMemorySnapshot(snapshot MemoryTurnSnapshot) MemoryTurnSnapshot {
	snapshot.SnapshotHash = ""
	bytes, _ := json.Marshal(snapshot)
	snapshot.SnapshotHash = hash(string(bytes))
	return snapshot
}
