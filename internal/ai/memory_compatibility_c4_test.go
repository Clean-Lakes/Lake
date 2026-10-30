package ai

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Exercise one restored session containing all three legacy data channels.
// Reading history must never restore a controller or block an unrelated turn.
func TestC4RestoredHistoryKeepsUnknownOutboxAndManifestWithoutExecution(t *testing.T) {
	var requests atomic.Int32
	model, closeProvider := fakeModel(t, func(_ int, body map[string]any) any {
		requests.Add(1)
		if strings.Contains(js(body), onlineRevisionTool) {
			t.Error("retired controller reached provider")
		}
		return response("Current ordinary task completed.")
	})
	defer closeProvider()
	e := engineFor(t, model, nil)
	if err := e.Chat(context.Background(), "case", "First synthetic ordinary request.", nil); err != nil {
		t.Fatal(err)
	}
	manifest := readPromptManifest(t, e, "case")
	rawManifest, _ := manifest.CanonicalJSON()
	event := SealStrategySnapshot(StrategyTurnSnapshot{UserMessageID: "legacy-user", SessionID: "case", ProjectID: "legacy-project", TurnID: "legacy-turn", Status: "failed", Deferred: true, UserTextHash: hash("not materialized")})
	s, _ := e.get("case")
	s.mu.Lock()
	config := s.state.Config
	s.state.StrategyOutbox = []StrategyTurnSnapshot{event}
	err := e.save(s)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	report := strategy.OnlineReport{Retired: true, ID: "legacy-unknown", TurnID: "legacy-turn", StopReason: strategy.AwaitingReconciliation, Requests: 3, TokensCharged: 777, Budget: strategy.DefaultBudget(), InFlightRequest: true, InFlightCall: "original-dispatch", UsageUnknown: true}
	original := js(report)
	if err := store.DB.Create(&nativeCorrection{ID: report.ID, SessionID: "case", Body: original}).Error; err != nil {
		t.Fatal(err)
	}
	// Seed the authoritative ADK projection, not only the replaceable JSON cache.
	if err := e.persistNativeProjection(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	e.Shutdown()
	if err := os.Remove(filepath.Join(e.Dir, "case.json")); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Shutdown()
	view, err := restarted.Snapshot("case")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, card := range view.Cards {
		if card.ID != "correction_legacy-unknown" {
			continue
		}
		raw, _ := json.Marshal(card.Data)
		var restored strategy.OnlineReport
		if json.Unmarshal(raw, &restored) != nil || restored.StopReason != strategy.AwaitingReconciliation || restored.InFlightCall != "original-dispatch" || restored.TokensCharged != 777 {
			t.Fatal("historical unknown changed")
		}
		found = true
	}
	outbox, err := restarted.StrategyOutbox("case")
	if !found || err != nil || len(outbox) != 1 || outbox[0].SnapshotHash != event.SnapshotHash || requests.Load() != 1 {
		t.Fatal("restoring history executed or lost data", found, err, requests.Load())
	}
	after, _ := readPromptManifest(t, restarted, "case").CanonicalJSON()
	if string(after) != string(rawManifest) {
		t.Fatal("old manifest changed")
	}
	// A missing UI cache recovers history, never model credentials/configuration.
	if err := restarted.Configure("case", config); err != nil {
		t.Fatal(err)
	}
	if err := restarted.Chat(context.Background(), "case", "A separate new ordinary request without operations.", nil); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 2 {
		t.Fatal("old correction replayed or stopped current task", requests.Load())
	}
	store, err = restarted.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var row nativeCorrection
	if err := store.DB.First(&row, "id = ?", report.ID).Error; err != nil || row.Body != original {
		t.Fatal("new task rewrote old unknown", err)
	}
	var count int64
	if err := store.DB.Model(&nativeArtifact{}).Where("file_name LIKE 'prompt-manifest-%'").Count(&count).Error; err != nil || count != 1 {
		t.Fatal("new task wrote an experimental manifest", count, err)
	}
	outbox, _ = restarted.StrategyOutbox("case")
	if len(outbox) != 1 || outbox[0].SnapshotHash != event.SnapshotHash {
		t.Fatal("new task mined or discarded old source")
	}
}
