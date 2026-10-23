package web

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func strategyHandoffFixture(t *testing.T) (*Server, *httptest.Server, string, string) {
	t.Helper()
	b, h := fixture(t)
	id, ref := newSession(t, h)
	enableStrategyFixture(t, b.Store)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		emitModel(w, "本轮答复已完成，候选可在后台整理。", nil)
	}))
	t.Cleanup(provider.Close)
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "handoff", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "纠正一下，以后请先列证据再给结论。"}, 202)
	b.workers.Wait()
	view, _ := b.Engine.Snapshot(id)
	if view.Status != "completed" {
		t.Fatal("fixture main task failed")
	}
	return b, h, id, stringOf(b.Store.Session(id)["projectId"])
}

func TestStrategyHandoffFailureRetriesWithoutRewritingSessionOrDuplicateAfterRestart(t *testing.T) {
	b, _, id, _ := strategyHandoffFixture(t)
	events, err := b.Engine.StrategyOutbox(id)
	if err != nil || len(events) != 1 || !events[0].Deferred || len(jsonText(events[0])) > 1024 || events[0].UserText != "" || len(events[0].Evidence) > 0 {
		t.Fatal("foreground did not capture minimal durable event", events, err)
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyLearningTurns")["n"]) != 0 {
		t.Fatal("foreground performed source delivery")
	}
	cache := filepath.Join(b.Engine.Dir, id+".json")
	before, _ := os.ReadFile(cache)
	_, err = b.Store.db.Exec("CREATE TRIGGER fail_learning_source BEFORE INSERT ON strategySourceEvents WHEN NEW.kind='task_outcome' BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END")
	if err != nil {
		t.Fatal(err)
	}
	b.processStrategyOutboxes(context.Background())
	if b.strategyHandoffStatus.Load() != "handoff_pending_retry" {
		t.Fatal("source failure was not observable in background status")
	}
	if pending, _ := b.Engine.StrategyOutbox(id); len(pending) != 1 {
		t.Fatal("failed delivery lost durable event")
	}
	b.Store.db.Exec("DROP TRIGGER fail_learning_source")
	if err = b.reconcileStrategyOutboxForSession(id); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(cache)
	if !bytes.Equal(before, after) {
		t.Fatal("background acknowledgement rewrote canonical conversation")
	}
	if acked, err := b.Store.strategyHandoffAcknowledged(events[0]); err != nil || !acked {
		t.Fatal("durable handoff receipt missing", err)
	}
	// The unchanged JSON/projection still contains the original event. Reopening
	// the real engine must consult the separate receipt and not requeue it.
	dir, runtimeDir := b.Engine.Dir, b.Engine.RuntimeDir
	b.Engine.Shutdown()
	b.Engine, err = ai.New(dir, b.bridge, b.event)
	if err != nil {
		t.Fatal(err)
	}
	b.Engine.RuntimeDir = runtimeDir
	if err = b.reconcileStrategyOutboxForSession(id); err != nil {
		t.Fatal(err)
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyLearningTurns")["n"]) != 1 || integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyJobs WHERE kind='proposal'")["n"]) != 1 {
		t.Fatal("restart duplicated delivered source or job")
	}
	view, _ := b.Engine.Snapshot(id)
	if view.Status != "completed" {
		t.Fatal("learning failure changed main status", view.Status)
	}
}

func TestStrategyHandoffQueueCapacityDefersWithoutDroppingSource(t *testing.T) {
	b, _, id, project := strategyHandoffFixture(t)
	ctx := StrategyContext{ProjectID: project}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}
	source := learningSource(t, b.Store, ctx)
	first := ""
	for i := 0; i < strategy.DefaultLearningLimits().MaxProjectQueued; i++ {
		q, err := b.Store.QueueStrategyJob(ctx, fmt.Sprintf("backlog-%d", i), StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}})
		if err != nil {
			t.Fatal(err)
		}
		if first == "" {
			first = q.JobID
		}
	}
	if err := b.reconcileStrategyOutboxForSession(id); err == nil || strategyPermanentError(err) {
		t.Fatal("queue-full was treated as permanent", err)
	}
	if events, _ := b.Engine.StrategyOutbox(id); len(events) != 1 {
		t.Fatal("full queue lost source event")
	}
	if _, err := b.Store.CancelStrategyJob(ctx, first, "make-room"); err != nil {
		t.Fatal(err)
	}
	if err := b.reconcileStrategyOutboxForSession(id); err != nil {
		t.Fatal(err)
	}
	if events, _ := b.Engine.StrategyOutbox(id); len(events) != 0 {
		t.Fatal("source not delivered after capacity returned")
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyLearningTurns WHERE sessionId=?", id)["n"]) != 1 {
		t.Fatal("queue retry duplicated source registration")
	}
}

func TestStrategyHandoffOptOutFencesOldEventAcrossReenable(t *testing.T) {
	b, _, id, _ := strategyHandoffFixture(t)
	global := strategy.Scope{Kind: strategy.UserScope}
	_, err := b.Store.SetStrategySettings(StrategyContext{}, global, "off", 1, StrategySettingsInput{Budget: strategy.DefaultBudget()})
	if err != nil {
		t.Fatal(err)
	}
	if err = b.reconcileStrategyOutboxForSession(id); err != nil {
		t.Fatal(err)
	}
	_, err = b.Store.SetStrategySettings(StrategyContext{}, global, "reenable", 2, StrategySettingsInput{MasterEnabled: true, LearnEnabled: true, Budget: strategy.DefaultBudget()})
	if err != nil {
		t.Fatal(err)
	}
	if err = b.reconcileStrategyOutboxForSession(id); err != nil {
		t.Fatal(err)
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyLearningTurns")["n"]) != 0 {
		t.Fatal("old revoked source revived on reenable")
	}
}

func TestStrategyHandoffLearningDoesNotWaitForProjectMemory(t *testing.T) {
	b, _, id, project := strategyHandoffFixture(t)
	if b.Store.row("SELECT 1 FROM projectMemoryJobs WHERE status='queued'") == nil {
		t.Fatal("memory task not queued")
	}
	if err := b.reconcileStrategyOutboxForSession(id); err != nil {
		t.Fatal(err)
	}
	job, err := b.Store.claimStrategyJob(StrategyContext{ProjectID: project}, "proposal")
	if err != nil || job == nil {
		t.Fatal("learning waited on unrelated memory queue", err)
	}
}
