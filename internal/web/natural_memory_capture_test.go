package web

import (
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMemoryCaptureObservedTimeDoesNotRefreshDuringConsolidation(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	original := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	snap := testMemorySnapshot(project, session, ident(), 0, 0)
	snap.Evidence = []ai.MemoryEvidence{{CallID: "completed", Name: "inspect_host", Excerpt: `{"release":"synthetic"}`, Completed: true, ObservedAt: original}}
	snap = ai.SealMemorySnapshot(snap)
	if err := b.Store.EnqueueMemoryTurn(snap); err != nil {
		t.Fatal(err)
	}
	job := b.Store.ClaimMemoryJob()
	m := MemoryExtractMutation{Operation: "upsert", Key: "synthetic-release", Type: "project", Description: "虚构版本记录", Body: "Why: 虚构演示。How to apply: 使用前重新核实版本。", Verification: "observed", SourceIDs: []string{"evidence:completed"}}
	if _, err := b.Store.CommitMemoryExtraction(job, snap, []MemoryExtractMutation{m}, ai.Usage{}); err != nil {
		t.Fatal(err)
	}
	if b.Store.ReadProjectMemory(project, m.Key, false)["observedAt"] != original {
		t.Fatal("consolidation refreshed observation time")
	}
}
func TestMemoryCaptureLaterEvidenceCannotReapplyAnOldCorrection(t *testing.T) {
	s, ctx, first := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, first, "更正本项目长期偏好：以后固定中文。", true)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	if _, err := consolidationCommit(t, s, items); err != nil {
		t.Fatal(err)
	}
	second := stringOf(s.CreateSession(ctx.ProjectID, "new conflicting user", nil)["id"])
	b := consolidationSource(t, s, ctx, second, "以后这个项目固定英文。", true)
	items = consolidationItems(t, s, b)
	items[0].Result = naturalResult(b.UserText, "response-language", false, 1)
	items[0].Result.Relation = "conflict"
	if _, err := consolidationCommit(t, s, items); err != nil {
		t.Fatal(err)
	}
	later := a
	later.TurnID = ident()
	later.Evidence = []ai.MemoryEvidence{{CallID: "later-complete", Name: "inspect_host", Excerpt: "synthetic evidence", Completed: true}}
	later = ai.SealMemorySnapshot(later)
	if err := s.EnqueueMemoryTurn(later); err != nil {
		t.Fatal(err)
	}
	items = consolidationItems(t, s, later)
	items[0].Result = naturalResult(later.UserText, "response-language", true, 1)
	items[0].Result.Relation = "correction"
	if _, err := consolidationCommit(t, s, items); err != nil {
		t.Fatal(err)
	}
	prefs, _ := s.NaturalFormedPreferences(ctx, "", 20)
	p := objects(prefs["items"])[0]
	conflicts, _ := s.NaturalConflicts(ctx, "", 20)
	if p["state"] != "conflict" || integer(p["revision"]) != 1 || objects(conflicts["items"])[0]["status"] != "pending" {
		t.Fatal("old interval resolved a newer conflict", p, conflicts)
	}
}
func TestMemoryCaptureHostRevalidationRejectsWithdrawnConsentAndSource(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	if !s.MemoryCaptureAllowed(snap) {
		t.Fatal("new genuine source unavailable")
	}
	_, _ = s.SetNaturalMemorySettings(ctx, "off", 1, false)
	if s.MemoryCaptureAllowed(snap) {
		t.Fatal("serialized consent re-enabled capture")
	}
	_, _ = s.SetNaturalMemorySettings(ctx, "on-again", 2, true)
	if s.MemoryCaptureAllowed(snap) {
		t.Fatal("old consent epoch re-enabled capture")
	}
	s.DeleteSession(session)
	if s.MemoryCaptureAllowed(snap) {
		t.Fatal("removed message re-enabled capture")
	}
}
