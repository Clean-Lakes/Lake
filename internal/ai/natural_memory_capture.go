package ai

import (
	"context"
	"errors"
	"sort"
)

// Lake Memory's host-only source journal. No instructions or model credentials.
// Captured means handed to the durable outbox, never successfully learned.
type MemoryCaptureState struct {
	Version int                  `json:"version"`
	Turns   []*MemoryCaptureTurn `json:"turns,omitempty"`
	Gap     bool                 `json:"gap,omitempty"`
}
type MemoryCaptureTurn struct {
	Source        MemoryTurnSnapshot             `json:"source"`
	Results       map[string]MemoryCaptureResult `json:"results,omitempty"`
	Seen          map[string]bool                `json:"seen,omitempty"`
	SnapshotIDs   []string                       `json:"snapshotIds,omitempty"`
	UserCaptured  bool                           `json:"userCaptured,omitempty"`
	Finished      bool                           `json:"finished,omitempty"`
	DirectWritten bool                           `json:"directWritten,omitempty"`
	Gap           bool                           `json:"gap,omitempty"`
	Deferred      bool                           `json:"deferred,omitempty"`
}
type MemoryCaptureResult struct {
	Name      string                 `json:"name"`
	Hash      string                 `json:"hash"`
	At        string                 `json:"at"`
	Completed bool                   `json:"completed"`
	Excerpt   string                 `json:"excerpt,omitempty"`
	Truncated bool                   `json:"truncated,omitempty"`
	Context   *MemoryEvidenceContext `json:"context,omitempty"`
}

const memoryCaptureTurnLimit = 8
const memoryCaptureByteLimit = 128 * 1024

// Caller owns s.mu. Invoked only when accepting a genuine host user turn.
func (e *Engine) beginMemoryCapture(s *session, c Config, input TurnInput) {
	legacy := c.MemoryEnabled && c.MemoryExtractionEnabled
	natural := c.NaturalMemory != nil && (c.NaturalMemory.GlobalEnabled || c.NaturalMemory.ProjectEnabled) && NaturalMemorySignal(input.UserText)
	if e.worker != nil || c.ConversationMode == ModePlan || input.IgnoreProjectMemory || c.MemoryProjectID == "" || input.StrategyMessageID == "" || (!legacy && !natural) || (!natural && !memorySignal(input.UserText)) {
		return
	}
	if len(input.UserText) > 64*1024 {
		s.state.View.MemoryStatus = "capture_gap"
		return
	}
	if s.state.MemoryCapture == nil {
		s.state.MemoryCapture = &MemoryCaptureState{Version: 1}
	}
	journal := s.state.MemoryCapture
	if journal.Version != 1 {
		s.state.View.MemoryStatus = "capture_gap"
		return
	}
	// Retain unresolved gaps; discard only completed sources whose outboxes were acked.
	pending := map[string]bool{}
	for _, v := range s.state.MemoryOutbox {
		pending[v.TurnID] = true
	}
	kept := []*MemoryCaptureTurn{}
	for _, turn := range journal.Turns {
		if turn == nil {
			continue
		}
		if turn.Source.TurnID != s.state.View.RootTurnID {
			turn.Finished = true
		}
		outstanding := false
		for _, id := range turn.SnapshotIDs {
			outstanding = outstanding || pending[id]
		}
		if !turn.Finished || turn.Gap || outstanding || memoryCapturePending(turn) {
			kept = append(kept, turn)
		}
	}
	journal.Turns = kept
	if len(kept) >= memoryCaptureTurnLimit || len(js(journal))+len(input.UserText) > memoryCaptureByteLimit {
		journal.Gap = true
		s.state.View.MemoryStatus = "capture_gap"
		return
	}
	base := MemoryTurnSnapshot{ProjectID: c.MemoryProjectID, SessionID: s.state.View.Session, SourceMessageID: input.StrategyMessageID, TurnID: s.state.View.RootTurnID, UserText: redact(input.UserText, c), Epoch: c.MemoryEpoch, KnowledgeBaseRevision: c.MemoryKnowledgeRevision, ModelRef: ModelIdentity(c.Model), CapturedAt: s.state.View.TurnStartedAt, LegacyExtraction: legacy, RecentUserInputs: append([]string(nil), s.state.MemoryRecentUserInputs...)}
	if natural {
		consent := *c.NaturalMemory
		base.Natural = &consent
	}
	if c.MemorySchemaVersion == 2 {
		base.SchemaVersion = 2
		refs := c.ReferencedAssets
		if c.targetScope != nil {
			refs = c.targetScope.ResourceIDs
			if c.targetScope.NeedsClarification {
				refs = nil
			}
		}
		for _, ref := range refs {
			if generation := c.MemoryResourceGenerations[ref]; generation > 0 {
				base.TargetBindings = append(base.TargetBindings, MemoryResourceBinding{ResourceID: ref, Generation: generation})
			}
		}
	}
	base = SealMemorySnapshot(base)
	journal.Turns = append(journal.Turns, &MemoryCaptureTurn{Source: base, Results: map[string]MemoryCaptureResult{}, Seen: map[string]bool{}})
	current, _ := memoryUTF8Prefix(base.UserText, 2048)
	s.state.MemoryRecentUserInputs = append(s.state.MemoryRecentUserInputs, current)
	if len(s.state.MemoryRecentUserInputs) > 3 {
		s.state.MemoryRecentUserInputs = s.state.MemoryRecentUserInputs[len(s.state.MemoryRecentUserInputs)-3:]
	}
}
func currentMemoryCapture(s *session) *MemoryCaptureTurn {
	if j := s.state.MemoryCapture; j != nil && j.Version == 1 {
		for _, turn := range j.Turns {
			if turn == nil {
				continue
			}
			if turn.Source.TurnID == s.state.View.RootTurnID {
				return turn
			}
		}
	}
	return nil
}

// Metadata is constructed at the actual executor completion, not inferred from
// a summary, a recovered tool error, or a successful-looking stdout string.
func (e *Engine) captureMemoryToolResult(s *session, call Call, payload string, value any, toolErr error) {
	turn := currentMemoryCapture(s)
	if e.worker != nil || turn == nil {
		return
	}
	if (call.Name == "save_project_memory" || call.Name == "forget_project_memory") && toolErr == nil && obj(value)["error"] == nil && obj(value)["key"] != nil {
		turn.DirectWritten = true
		e.withdrawMemoryCapture(s, turn.Source.TurnID)
		return
	}
	if turn.Results == nil {
		turn.Results = map[string]MemoryCaptureResult{}
	}
	if !turn.Source.LegacyExtraction {
		return
	}
	total := 0
	for _, t := range s.state.MemoryCapture.Turns {
		total += len(t.Results)
	}
	if total >= 64 {
		turn.Gap = true
		s.state.View.MemoryStatus = "capture_gap"
		return
	}
	excerpt, truncated := memoryUTF8Prefix(payload, 2048)
	result := MemoryCaptureResult{Name: call.Name, Hash: hash(payload), At: timestamp(), Completed: toolErr == nil && memoryEvidenceEligible(value, nil) == "completed_success" && call.Name != "call_mcp_tool", Excerpt: excerpt, Truncated: truncated}
	if trusted, ok := s.state.MemoryEvidenceContexts[call.ID]; ok {
		result.Context = &trusted
	}
	if result.Truncated || result.Context != nil && result.Context.Truncated {
		turn.Gap = true
		s.state.View.MemoryStatus = "capture_gap"
	}
	turn.Results[call.ID] = result
}
func captureConsentAvailable(source MemoryTurnSnapshot, c Config) bool {
	if source.ProjectID != c.MemoryProjectID {
		return false
	}
	if source.LegacyExtraction && (!c.MemoryEnabled || !c.MemoryExtractionEnabled || c.MemoryEpoch != source.Epoch) {
		return false
	}
	if source.Natural != nil {
		old, current := source.Natural, c.NaturalMemory
		if current == nil || old.GlobalEnabled && (!current.GlobalEnabled || old.GlobalEpoch != current.GlobalEpoch) || old.ProjectEnabled && (!current.ProjectEnabled || old.ProjectEpoch != current.ProjectEpoch) {
			return false
		}
	}
	return true
}

// Caller owns s.mu. Bounded incremental capture, shared by completion and ALL
// compaction paths. No model, tools, history scan of prior unregistered users.
func (e *Engine) captureMemoryIncrement(s *session, c Config, only ...*MemoryCaptureTurn) bool {
	journal := s.state.MemoryCapture
	if e.worker != nil || journal == nil || journal.Version != 1 || c.ConversationMode == ModePlan {
		return false
	}
	changed := false
	for _, turn := range journal.Turns {
		if len(only) > 0 && turn != only[0] {
			continue
		}
		if turn == nil {
			continue
		}
		if e.MemoryCaptureAllowed != nil && !e.captureSourceAllowed(s, turn) {
			continue
		}
		if turn.DirectWritten || !ValidMemorySnapshot(turn.Source) || !captureConsentAvailable(turn.Source, c) {
			continue
		}
		if len(s.state.MemoryOutbox) >= 20 {
			s.state.View.MemoryStatus = "backlog_full"
			continue
		}
		fresh := []MemoryEvidence{}
		seenNow := []string{}
		used := 0
		// Only executor-registered records, ordered independently of model history.
		keys := []string{}
		for id := range turn.Results {
			keys = append(keys, id)
		}
		sort.Slice(keys, func(i, j int) bool {
			a, b := turn.Results[keys[i]], turn.Results[keys[j]]
			if a.At == b.At {
				return keys[i] < keys[j]
			}
			return a.At < b.At
		})
		for _, id := range keys {
			result := turn.Results[id]
			if turn.Seen[id] || !result.Completed {
				continue
			}
			if len(fresh) >= 24 || used+len(result.Excerpt) > 24*1024 {
				break
			}
			ev := MemoryEvidence{CallID: id, Name: result.Name, Excerpt: result.Excerpt, Completed: true, Truncated: result.Truncated, ObservedAt: result.At}
			if turn.Source.SchemaVersion == 2 {
				if result.Context == nil || result.Context.Outcome != "completed_success" {
					continue
				}
				ev.Context = result.Context
				ev.ObservedAt = result.Context.FinishedAt
			}
			used += len(result.Excerpt)
			fresh = append(fresh, ev)
			seenNow = append(seenNow, id)
		}
		// No legacy facts are inferred from arbitrary assistant prose or summaries.
		userNeeded := !turn.UserCaptured && (turn.Source.Natural != nil || memorySignal(turn.Source.UserText))
		if !userNeeded && len(fresh) == 0 {
			continue
		}
		if !turn.Source.LegacyExtraction {
			fresh = nil
			seenNow = nil
			if !userNeeded {
				continue
			}
		}
		if len(fresh) == 0 {
			fresh = nil
		}
		snapshot := turn.Source
		snapshot.Evidence = fresh
		snapshot.AssistantText = ""
		snapshot.TurnID = hash(js(map[string]any{"root": turn.Source.TurnID, "source": turn.Source.SourceMessageID, "evidence": fresh, "user": userNeeded}))
		snapshot = SealMemorySnapshot(snapshot)
		if len(js(snapshot)) > 128*1024 {
			turn.Gap = true
			s.state.View.MemoryStatus = "capture_gap"
			continue
		}
		s.state.MemoryOutbox = append(s.state.MemoryOutbox, snapshot)
		if turn.Seen == nil {
			turn.Seen = map[string]bool{}
		}
		for _, id := range seenNow {
			turn.Seen[id] = true
		}
		turn.UserCaptured = true
		turn.SnapshotIDs = append(turn.SnapshotIDs, snapshot.TurnID)
		changed = true
	}
	return changed
}

// Capture failures are auxiliary. Existing compaction/canonical-write failures
// retain their normal error boundaries; no optional model request is added.
func (e *Engine) captureBeforeCompaction(ctx context.Context, s *session, c Config) {
	if ctx.Err() != nil {
		return
	}
	s.mu.Lock()
	changed := false
	for i := 0; i < 20; i++ {
		if !e.captureMemoryIncrement(s, c) {
			break
		}
		changed = true
	}
	if !changed {
		s.mu.Unlock()
		return
	}
	if e.save(s) != nil {
		s.state.View.MemoryStatus = "capture_gap"
	}
	e.notify(s, "memoryCapture", nil)
	s.mu.Unlock()
	if e.persistNativeProjection(ctx, s) != nil {
		s.mu.Lock()
		s.state.View.MemoryStatus = "capture_gap"
		s.mu.Unlock()
	}
}
func (e *Engine) finishMemoryCapture(s *session, c Config) {
	for i := 0; i < 20; i++ {
		if !e.captureMemoryIncrement(s, c) {
			break
		}
	}
	if turn := currentMemoryCapture(s); turn != nil {
		turn.Finished = true
	}
	e.notify(s, "memoryCapture", nil)
}
func (e *Engine) withdrawMemoryCapture(s *session, root string) {
	journal := s.state.MemoryCapture
	if journal == nil {
		return
	}
	ids := map[string]bool{}
	for _, turn := range journal.Turns {
		if root == "" || turn.Source.TurnID == root {
			for _, id := range turn.SnapshotIDs {
				ids[id] = true
			}
		}
	}
	out := s.state.MemoryOutbox[:0]
	for _, snapshot := range s.state.MemoryOutbox {
		if !ids[snapshot.TurnID] {
			out = append(out, snapshot)
		}
	}
	s.state.MemoryOutbox = out
	if root == "" {
		s.state.MemoryCapture = &MemoryCaptureState{Version: 1}
	}
}

func memoryCapturePending(turn *MemoryCaptureTurn) bool {
	if turn.DirectWritten {
		return false
	}
	if turn.Deferred {
		return true
	}
	if !turn.UserCaptured {
		return true
	}
	for id, r := range turn.Results {
		if r.Completed && !turn.Seen[id] {
			return true
		}
	}
	return false
}

// Flush ONLY previously authorized journal sources after queue space returns.
// The Store still independently rejects revoked consent, deleted messages and
// stale bindings before dispatch/commit. This does not discover old histories.
func (e *Engine) QueuePendingMemoryCaptures(id string) (bool, error) {
	s, err := e.get(id)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil || s.finalizing || s.state.MemoryCapture == nil || s.state.MemoryCapture.Version != 1 {
		return false, nil
	}
	changed, dirty := false, false
	for _, turn := range s.state.MemoryCapture.Turns {
		if turn == nil {
			continue
		}
		if e.MemoryCaptureAllowed != nil && !turn.DirectWritten {
			if !e.captureSourceAllowed(s, turn) {
				dirty = true
				continue
			}
		}
		if !turn.Finished || !memoryCapturePending(turn) {
			continue
		}
		c := s.state.Config
		c.MemoryProjectID = turn.Source.ProjectID
		c.MemoryEpoch = turn.Source.Epoch
		c.MemoryEnabled = turn.Source.LegacyExtraction
		c.MemoryExtractionEnabled = turn.Source.LegacyExtraction
		c.NaturalMemory = turn.Source.Natural
		for i := 0; i < 20; i++ {
			if !e.captureMemoryIncrement(s, c, turn) {
				break
			}
			changed = true
		}
	}
	gap := s.state.MemoryCapture.Gap
	deferred := false
	for _, turn := range s.state.MemoryCapture.Turns {
		if turn != nil {
			gap = gap || turn.Gap || turn.Deferred
			deferred = deferred || turn.Deferred
		}
	}
	if !gap && len(s.state.MemoryOutbox) < 20 && (s.state.View.MemoryStatus == "capture_gap" || s.state.View.MemoryStatus == "backlog_full") {
		s.state.View.MemoryStatus = ""
		dirty = true
	}
	if changed || dirty {
		err = e.save(s)
	}
	if err == nil && deferred {
		err = errors.New("memory source temporarily unavailable")
	}
	return changed, err
}

func (e *Engine) captureSourceAllowed(s *session, turn *MemoryCaptureTurn) (allowed bool) {
	if turn.DirectWritten {
		return false
	}
	defer func() {
		if recover() != nil {
			turn.Deferred = true
			s.state.View.MemoryStatus = "capture_gap"
			allowed = false
		}
	}()
	if e.MemoryCaptureAllowed(turn.Source) {
		turn.Deferred = false
		return true
	}
	e.withdrawMemoryCapture(s, turn.Source.TurnID)
	turn.Source.UserText = ""
	turn.Source.RecentUserInputs = nil
	turn.Source.Evidence = nil
	turn.Source.AssistantText = ""
	turn.Source = SealMemorySnapshot(turn.Source)
	turn.Results = nil
	turn.Seen = nil
	turn.DirectWritten = true
	turn.Deferred = false
	turn.Gap = false
	return false
}
