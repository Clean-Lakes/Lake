package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"sort"
)

func (e *Engine) RecordedMemoryEvidenceAvailable(sessionID, evidenceID string) bool {
	path, err := e.evidencePath(AgentEvidence{SessionID: sessionID, ID: evidenceID})
	if err != nil {
		return false
	}
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

type MemoryAccess struct {
	Key            string `json:"key"`
	Revision       int    `json:"revision"`
	Kind           string `json:"kind"`
	At             string `json:"at"`
	ObservedAt     string `json:"observedAt,omitempty"`
	Historical     bool   `json:"historical,omitempty"`
	ScopeSignature string `json:"scopeSignature"`
	OffsetLine     int    `json:"offsetLine,omitempty"`
	ByteOffset     int    `json:"byteOffset,omitempty"`
	BytesRead      int    `json:"bytesRead,omitempty"`
}

type MemoryReadContext struct {
	TurnID             string
	ResourceIDs        []string
	NeedsClarification bool
	InputBudget        int
	Enabled            bool
}

func (e *Engine) MemoryReadContext(id string) (MemoryReadContext, error) {
	s, err := e.get(id)
	if err != nil {
		return MemoryReadContext{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.state.Config
	out := MemoryReadContext{TurnID: s.state.View.RootTurnID, ResourceIDs: append([]string{}, s.state.ReferencedAssetIDs...), InputBudget: max(0, c.Model.ContextWindow-c.Model.MaxOutput), Enabled: c.MemoryEnabled}
	if scope := s.state.TargetScope; scope != nil {
		out.ResourceIDs = append([]string{}, scope.ResourceIDs...)
		out.NeedsClarification = scope.NeedsClarification
	}
	sort.Strings(out.ResourceIDs)
	return out, nil
}

func (e *Engine) RecordMemoryAccess(id string, entries []MemoryAccess, expectedTurns ...string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(expectedTurns) > 0 && s.state.View.RootTurnID != expectedTurns[0] {
		return errors.New("memory turn changed")
	}
	refs := append([]string{}, s.state.ReferencedAssetIDs...)
	if scope := s.state.TargetScope; scope != nil {
		refs = append([]string{}, scope.ResourceIDs...)
	}
	sort.Strings(refs)
	digest := sha256.Sum256([]byte(js(map[string]any{"project": s.state.Config.MemoryProjectID, "resources": refs, "generations": s.state.Config.MemoryResourceGenerations})))
	signature := hex.EncodeToString(digest[:])
	for _, entry := range entries {
		entry.ScopeSignature = signature
		found := false
		for _, old := range s.state.View.MemoryAccess {
			if old.Key == entry.Key && old.Revision == entry.Revision && old.Kind == entry.Kind && old.ScopeSignature == signature && old.OffsetLine == entry.OffsetLine && old.ByteOffset == entry.ByteOffset {
				found = true
			}
		}
		if !found && len(s.state.View.MemoryAccess) < 64 {
			entry.At = timestamp()
			s.state.View.MemoryAccess = append(s.state.View.MemoryAccess, entry)
		}
	}
	if len(s.state.View.MemoryAccess) > 0 {
		cardID := "memory-access-" + s.state.View.RootTurnID
		found := false
		for i := range s.state.View.Cards {
			if s.state.View.Cards[i].ID == cardID {
				s.state.View.Cards[i].Content = js(s.state.View.MemoryAccess)
				found = true
				break
			}
		}
		if !found {
			s.state.View.Cards = append(s.state.View.Cards, Card{ID: cardID, Type: "memory_access", Title: "项目记忆", Content: js(s.state.View.MemoryAccess), Status: "completed", At: timestamp()})
		}
	}
	return e.save(s)
}
