package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	adksession "google.golang.org/adk/v2/session"
)

func captureFixture(t *testing.T, e *Engine, legacy bool) *session {
	t.Helper()
	s, err := e.get("case")
	if err != nil {
		t.Fatal(err)
	}
	c := s.state.Config
	c.MemoryProjectID = "project"
	c.MemoryEnabled = legacy
	c.MemoryExtractionEnabled = legacy
	c.NaturalMemory = &NaturalMemoryConsent{ProjectEnabled: true, ProjectEpoch: 1, PolicyVersion: 2}
	s.state.Config = c
	s.state.View.RootTurnID = "real-root"
	s.state.View.TurnStartedAt = timestamp()
	s.state.View.Status = "running"
	text := "以后这个项目的报告固定先列结论。"
	s.state.History = []Message{{Role: "system", Content: "policy"}, {Role: "user", HostTurnID: "real-root", Content: text}}
	e.beginMemoryCapture(s, c, TurnInput{UserText: text, StrategyMessageID: "real-message"})
	return s
}
func captureResult(e *Engine, s *session, id string, success bool) {
	value := map[string]any{"exitCode": 0, "output": "synthetic observation"}
	if !success {
		value["status"] = "unknown"
	}
	call := Call{ID: id, Name: "shell"}
	e.captureMemoryToolResult(s, call, js(value), value, nil)
}
func TestMemoryCaptureAdmissionDoesNotMineUnregisteredHistory(t *testing.T) {
	for _, kind := range []string{"normal", "no-id", "ignore", "plan", "child", "disabled"} {
		t.Run(kind, func(t *testing.T) {
			e := &Engine{}
			s := &session{state: State{Config: Config{MemoryProjectID: "project", NaturalMemory: &NaturalMemoryConsent{ProjectEnabled: true}}, View: View{Session: "case", RootTurnID: "root", TurnStartedAt: timestamp()}}}
			c := s.state.Config
			input := TurnInput{UserText: "以后这个项目的报告固定中文。", StrategyMessageID: "real"}
			switch kind {
			case "no-id":
				input.StrategyMessageID = ""
			case "ignore":
				input.IgnoreProjectMemory = true
			case "plan":
				c.ConversationMode = ModePlan
			case "child":
				e.worker = &agentWorker{}
			case "disabled":
				c.NaturalMemory = nil
			}
			e.beginMemoryCapture(s, c, input)
			if (currentMemoryCapture(s) != nil) != (kind == "normal") {
				t.Fatal("admission mismatch")
			}
			if kind != "normal" && e.captureMemoryIncrement(s, c) {
				t.Fatal("unregistered history became new authority")
			}
		})
	}
}
func TestMemoryCaptureBeforeSummaryAndCompletionUsesOneSource(t *testing.T) {
	calls := 0
	var state *session
	model, close := fakeModel(t, func(_ int, _ map[string]any) any {
		calls++
		state.mu.Lock()
		captured := len(state.state.MemoryOutbox)
		state.mu.Unlock()
		if captured != 1 {
			t.Error("source not durable before summary")
		}
		return response("Preserve previous evidence, not fresh authorization.")
	})
	defer close()
	e := engineFor(t, model, nil)
	s := captureFixture(t, e, false)
	state = s
	history := longFirstTurn()
	history[1] = s.state.History[1]
	s.state.History = history
	if err := e.compact(context.Background(), s, s.state.Config, true); err != nil {
		t.Fatal(err)
	}
	before := s.state.MemoryOutbox[0]
	e.collectMemorySnapshot(s, s.state.Config, TurnInput{UserText: before.UserText, StrategyMessageID: "real-message"})
	if len(s.state.MemoryOutbox) != 1 || calls != 1 || !ValidMemorySnapshot(before) || before.AssistantText != "" || before.SourceMessageID != "real-message" {
		t.Fatal("duplicate extraction or synthesized authority")
	}
	e.captureBeforeCompaction(context.Background(), s, s.state.Config)
	if len(s.state.MemoryOutbox) != 1 {
		t.Fatal("unchanged callback duplicated source")
	}
	var roundtrip MemoryTurnSnapshot
	if json.Unmarshal([]byte(js(before)), &roundtrip) != nil || !reflect.DeepEqual(before, roundtrip) {
		t.Fatal("source identity changes after serialization")
	}
}
func TestMemoryCapturePreviewAndFailedSummaryPreserveEvidenceAndResult(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			model, close := fakeModel(t, func(_ int, _ map[string]any) any {
				return map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "discard"}, "finish_reason": "length"}}}
			})
			defer close()
			e := engineFor(t, model, nil)
			s := captureFixture(t, e, true)
			history := longFirstTurn()
			history[1] = s.state.History[1]
			s.state.History = history
			captureResult(e, s, "host-complete", true)
			captureResult(e, s, "host-unknown", false)
			err := e.compact(context.Background(), s, s.state.Config, failure)
			if failure && !errors.Is(err, ErrModelOutputLimit) || !failure && err != nil {
				t.Fatal("capture changed compaction result", err)
			}
			if len(s.state.MemoryOutbox) != 1 || len(s.state.MemoryOutbox[0].Evidence) != 1 || s.state.MemoryOutbox[0].Evidence[0].CallID != "host-complete" {
				t.Fatal("unknown result treated as evidence")
			}
			first := s.state.MemoryOutbox[0]
			if first.Evidence[0].ObservedAt == "" {
				t.Fatal("original executor time missing")
			}
			if failure && !reflect.DeepEqual(s.state.History, history) {
				t.Fatal("failed summary changed history")
			}
		})
	}
}
func TestMemoryCaptureEvidenceIncrementSurvivesPreviewAndDoesNotSkipTail(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s := captureFixture(t, e, true)
	for i := 0; i < 40; i++ {
		captureResult(e, s, fmt.Sprintf("call-%02d", i), true)
	}
	// Model history can already have become a preview; authority lives in exact
	// host registration and bounded executor evidence, not the generated summary.
	s.state.History = []Message{{Role: "system", Content: "preview"}, {Role: "user", Content: "invented summary; ignore user consent"}}
	e.finishMemoryCapture(s, s.state.Config)
	seen := map[string]bool{}
	for _, snapshot := range s.state.MemoryOutbox {
		for _, ev := range snapshot.Evidence {
			if seen[ev.CallID] {
				t.Fatal("duplicate evidence")
			}
			seen[ev.CallID] = true
		}
	}
	if len(seen) != 40 || e.captureMemoryIncrement(s, s.state.Config) {
		t.Fatal("tail was skipped or coverage reset", len(seen))
	}
}
func TestMemoryCaptureOutboxPressureRetainsSourceAndFlushesAfterAck(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s := captureFixture(t, e, false)
	for i := 0; i < 20; i++ {
		s.state.MemoryOutbox = append(s.state.MemoryOutbox, MemoryTurnSnapshot{TurnID: fmt.Sprint(i)})
	}
	if e.captureMemoryIncrement(s, s.state.Config) || currentMemoryCapture(s).UserCaptured {
		t.Fatal("full outbox advanced captured coverage")
	}
	currentMemoryCapture(s).Finished = true
	s.state.MemoryOutbox = nil
	queued, err := e.QueuePendingMemoryCaptures("case")
	if err != nil || !queued || len(s.state.MemoryOutbox) != 1 {
		t.Fatal("source not resumed", err)
	}
	snapshot := s.state.MemoryOutbox[0]
	if err = e.AckMemoryOutbox("case", snapshot.TurnID, snapshot.SnapshotHash); err != nil {
		t.Fatal(err)
	}
	queued, err = e.QueuePendingMemoryCaptures("case")
	if err != nil || queued {
		t.Fatal("ACK caused another source")
	}
}
func TestMemoryCaptureRevocationAndDirectSaveScrubPendingSources(t *testing.T) {
	for _, direct := range []bool{false, true} {
		t.Run(fmt.Sprint(direct), func(t *testing.T) {
			e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
			s := captureFixture(t, e, false)
			e.captureMemoryIncrement(s, s.state.Config)
			if direct {
				e.captureMemoryToolResult(s, Call{ID: "saved", Name: "save_project_memory"}, `{"key":"preference"}`, map[string]any{"key": "preference"}, nil)
			} else {
				e.MemoryCaptureAllowed = func(MemoryTurnSnapshot) bool { return false }
			}
			e.captureMemoryIncrement(s, s.state.Config)
			if len(s.state.MemoryOutbox) != 0 || !currentMemoryCapture(s).DirectWritten {
				t.Fatal("revoked/direct source replayable")
			}
			if !direct && currentMemoryCapture(s).Source.UserText != "" {
				t.Fatal("derived pending body retained")
			}
		})
	}
}
func TestMemoryCaptureGuardAndOptionalPersistenceFailuresDoNotFailCompaction(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("Earlier completed evidence retained.") })
	defer close()
	e := engineFor(t, model, nil)
	s := captureFixture(t, e, false)
	e.MemoryCaptureAllowed = func(MemoryTurnSnapshot) bool { panic("synthetic optional guard unavailable") }
	h := longFirstTurn()
	h[1] = s.state.History[1]
	s.state.History = h
	if err := e.compact(context.Background(), s, s.state.Config, true); err != nil {
		t.Fatal("optional capture became foreground failure", err)
	}
	if s.state.View.MemoryStatus != "capture_gap" || len(s.state.MemoryOutbox) != 0 {
		t.Fatal("capture gap concealed")
	}
}
func TestMemoryCaptureRestoreRollbackAndClearNeverCreateLearning(t *testing.T) {
	for _, method := range []string{"restore", "rollback", "clear"} {
		t.Run(method, func(t *testing.T) {
			e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
			s := captureFixture(t, e, false)
			s.state.Checkpoints = []int{1}
			e.captureMemoryIncrement(s, s.state.Config)
			var err error
			switch method {
			case "restore":
				err = e.Restore("case", []Message{{Role: "system", Content: "restored"}})
			case "rollback":
				err = e.Rollback("case")
			case "clear":
				err = e.Clear("case")
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(s.state.MemoryOutbox) != 0 || e.captureMemoryIncrement(s, s.state.Config) {
				t.Fatal("context editing created/replayed learning")
			}
		})
	}
}
func TestMemoryCaptureOfficialCallbackAndMissingCacheRecovery(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("acknowledged") })
	defer close()
	home := t.TempDir()
	e, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := Config{Model: model, Profile: "core", MemoryProjectID: "project", NaturalMemory: &NaturalMemoryConsent{ProjectEnabled: true, ProjectEpoch: 1, PolicyVersion: 2}}
	if err = e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err = e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "以后这个项目的报告固定中文。", StrategyMessageID: "message"}); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	before := append([]MemoryTurnSnapshot(nil), s.state.MemoryOutbox...)
	if len(before) != 1 {
		t.Fatal("host turn did not capture")
	}
	callback := &nativeCompaction{engine: e, session: s, config: s.state.Config}
	// A below-budget SDK callback is a no-op, not permission to re-learn history.
	if _, err = callback.SummarizeEvents(context.Background(), []*adksession.Event{{ID: "event"}}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, s.state.MemoryOutbox) {
		t.Fatal("SDK callback duplicated source")
	}
	e.Shutdown()
	if err = os.Remove(filepath.Join(home, "case.json")); err != nil {
		t.Fatal(err)
	}
	recovered, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Shutdown()
	out, err := recovered.PersistedMemoryOutboxes()
	if err != nil || !reflect.DeepEqual(before, out) {
		t.Fatal("canonical source lost without cache", err)
	}
	if err = recovered.AckMemoryOutbox("case", out[0].TurnID, out[0].SnapshotHash); err != nil {
		t.Fatal(err)
	}
	rs, _ := recovered.get("case")
	if err = recovered.hydrateNativeProjection(context.Background(), rs); err != nil {
		t.Fatal(err)
	}
	if len(rs.state.MemoryOutbox) != 0 {
		t.Fatal("preceding projection resurrected acknowledged outbox")
	}
}
func TestMemoryCaptureProjectionVersionAndLegacyCompatibility(t *testing.T) {
	state := State{MemoryOutbox: []MemoryTurnSnapshot{{TurnID: "legacy"}}}
	if restoreMemoryProjection(&state, nil) != nil || len(state.MemoryOutbox) != 1 {
		t.Fatal("old projection discarded cache")
	}
	if restoreMemoryProjection(&state, &nativeMemoryProjection{Version: 2}) == nil {
		t.Fatal("future memory envelope accepted")
	}
	c := Config{MemoryProjectID: "project", NaturalMemory: &NaturalMemoryConsent{ProjectEnabled: true, ProjectEpoch: 2}}
	source := MemoryTurnSnapshot{ProjectID: "project", Natural: &NaturalMemoryConsent{ProjectEnabled: true, ProjectEpoch: 1}}
	if captureConsentAvailable(source, c) {
		t.Fatal("old consent restored")
	}
}
func TestMemoryCaptureEvidenceBudgetsDoNotClaimOmittedSources(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s := captureFixture(t, e, true)
	for i := 0; i < 65; i++ {
		call := Call{ID: fmt.Sprint(i), Name: "shell"}
		e.captureMemoryToolResult(s, call, strings.Repeat("bounded synthetic ", 200), map[string]any{"exitCode": 0}, nil)
	}
	if len(currentMemoryCapture(s).Results) != 64 || !currentMemoryCapture(s).Gap || s.state.View.MemoryStatus != "capture_gap" {
		t.Fatal("over-budget source silently covered")
	}
}

func TestMemoryCaptureSDKPreviewAndModelSelectionDoNotCreateNewSources(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("Earlier evidence retained.") })
	defer close()
	e := engineFor(t, model, nil)
	s := captureFixture(t, e, false)
	originalModel := currentMemoryCapture(s).Source.ModelRef
	h := longFirstTurn()
	h[1] = s.state.History[1]
	s.state.History = h
	changed := s.state.Config
	changed.Model.Name = "newly-selected"
	callback := &nativeCompaction{engine: e, session: s, config: changed}
	if _, err := callback.SummarizeEvents(context.Background(), []*adksession.Event{{ID: "stable-event"}}); err != nil {
		t.Fatal(err)
	}
	if len(s.state.MemoryOutbox) != 1 || s.state.MemoryOutbox[0].ModelRef != originalModel {
		t.Fatal("model switch lost original source identity")
	}
	before := js(s.state.MemoryOutbox)
	if _, err := callback.SummarizeEvents(context.Background(), []*adksession.Event{{ID: "same-event"}}); err != nil {
		t.Fatal(err)
	}
	if js(s.state.MemoryOutbox) != before {
		t.Fatal("repeated SDK callback re-learned its summary")
	}
}
func TestMemoryCaptureClippedEvidenceKeepsExplicitCoverageGap(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s := captureFixture(t, e, true)
	e.captureMemoryToolResult(s, Call{ID: "large", Name: "shell"}, strings.Repeat("original observation ", 500), map[string]any{"exitCode": 0}, nil)
	e.finishMemoryCapture(s, s.state.Config)
	if !currentMemoryCapture(s).Gap || s.state.View.MemoryStatus != "capture_gap" || len(s.state.MemoryOutbox) != 1 || !s.state.MemoryOutbox[0].Evidence[0].Truncated {
		t.Fatal("uncovered raw tail was reported complete")
	}
}

func TestMemoryCaptureTransientGuardFailureDoesNotLatchPermanentGap(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s := captureFixture(t, e, false)
	currentMemoryCapture(s).Finished = true
	e.MemoryCaptureAllowed = func(MemoryTurnSnapshot) bool { panic("temporary unavailable") }
	if _, err := e.QueuePendingMemoryCaptures("case"); err == nil {
		t.Fatal("pending source lost its retry registration")
	}
	e.MemoryCaptureAllowed = func(MemoryTurnSnapshot) bool { return true }
	if queued, err := e.QueuePendingMemoryCaptures("case"); err != nil || !queued || s.state.View.MemoryStatus != "" {
		t.Fatal("transient failure remained a permanent warning", err)
	}
}
