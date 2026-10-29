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
	ObservedAt string                 `json:"observedAt,omitempty"`
	CallID     string                 `json:"callId"`
	Name       string                 `json:"name"`
	Excerpt    string                 `json:"excerpt"`
	Completed  bool                   `json:"completed"`
	Truncated  bool                   `json:"truncated,omitempty"`
	Context    *MemoryEvidenceContext `json:"context,omitempty"`
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

// Host-only consent snapshot; model arguments cannot populate this contract.
type NaturalMemoryConsent struct {
	GlobalEnabled  bool `json:"globalEnabled"`
	ProjectEnabled bool `json:"projectEnabled"`
	GlobalEpoch    int  `json:"globalEpoch"`
	ProjectEpoch   int  `json:"projectEpoch"`
	PolicyVersion  int  `json:"policyVersion"`
}
type MemoryTurnSnapshot struct {
	Natural               *NaturalMemoryConsent   `json:"natural,omitempty"`
	LegacyExtraction      bool                    `json:"legacyExtraction,omitempty"`
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

// A cheap admission signal only. It cannot authorize a write; a separate no-tool
// semantic result and the host's exact current-user source checks are required.
func NaturalMemorySignal(text string) bool {
	lower := strings.ToLower(text)
	for _, part := range []string{"以后", "今后", "后续", "长期", "固定", "偏好", "习惯", "每次", "每回", "一直", "惯例", "不再", "从现在", "always", "prefer", "every ", "from now", "default", "future", "no longer", "任何项目", "所有项目", "所有会话", "all projects", "across projects"} {
		if strings.Contains(lower, part) {
			return true
		}
	}
	return false
}

func (e *Engine) collectMemorySnapshot(s *session, c Config, input TurnInput) {
	if turn := currentMemoryCapture(s); turn != nil {
		e.finishMemoryCapture(s, c)
		return
	}
	legacy := c.MemoryEnabled && c.MemoryExtractionEnabled
	natural := c.NaturalMemory != nil && (c.NaturalMemory.GlobalEnabled || c.NaturalMemory.ProjectEnabled) && NaturalMemorySignal(input.UserText)
	if c.ConversationMode == ModePlan || e.worker != nil || (!legacy && !natural) || c.MemoryProjectID == "" || input.IgnoreProjectMemory || len(input.UserText) > 64*1024 {
		return
	}
	recent := append([]string(nil), s.state.MemoryRecentUserInputs...)
	current, _ := memoryUTF8Prefix(redact(input.UserText, c), 2048)
	s.state.MemoryRecentUserInputs = append(s.state.MemoryRecentUserInputs, current)
	if len(s.state.MemoryRecentUserInputs) > 3 {
		s.state.MemoryRecentUserInputs = s.state.MemoryRecentUserInputs[len(s.state.MemoryRecentUserInputs)-3:]
	}
	if !memorySignal(input.UserText) && !natural {
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
			if call.Name != "save_project_memory" && call.Name != "forget_project_memory" {
				continue
			}
			if !natural {
				return
			}
			// Failed direct-save attempts do not veto a separately authorized natural
			// preference. Successful direct writes still avoid a second representation.
			for _, result := range segment {
				if result.Role == "tool" && result.CallID == call.ID && result.Name == call.Name {
					var value map[string]any
					if json.Unmarshal([]byte(result.Content), &value) == nil && value["error"] == nil && value["key"] != nil {
						return
					}
				}
			}
		}
	}
	snapshot := MemoryTurnSnapshot{ProjectID: c.MemoryProjectID, SessionID: s.state.View.Session, TurnID: s.state.View.RootTurnID, Epoch: c.MemoryEpoch, KnowledgeBaseRevision: c.MemoryKnowledgeRevision, UserText: redact(input.UserText, c), RecentUserInputs: recent, ModelRef: ModelIdentity(c.Model), CapturedAt: s.state.View.TurnFinishedAt}
	if natural {
		consent := *c.NaturalMemory
		snapshot.Natural = &consent
		snapshot.LegacyExtraction = legacy
		snapshot.SourceMessageID = input.StrategyMessageID
	}
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
		if s.state.MemoryAcknowledged == nil {
			s.state.MemoryAcknowledged = map[string]string{}
		}
		for key := range s.state.MemoryAcknowledged {
			if len(s.state.MemoryAcknowledged) < 128 {
				break
			}
			delete(s.state.MemoryAcknowledged, key)
		}
		s.state.MemoryAcknowledged[turnID] = snapshotHash
		s.state.MemoryOutbox = append(s.state.MemoryOutbox[:i], s.state.MemoryOutbox[i+1:]...)
		return e.save(s)
	}
	return nil
}

func (e *Engine) PersistedMemoryOutboxes() ([]MemoryTurnSnapshot, error) {
	if err := e.restoreMissingMemoryCaches(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(e.Dir)
	if err != nil {
		return nil, err
	}
	var out []MemoryTurnSnapshot
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || !identifier.MatchString(strings.TrimSuffix(entry.Name(), ".json")) || !e.memoryCaptureSessionAvailable(strings.TrimSuffix(entry.Name(), ".json")) {
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
