package web

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func saveRecallPreference(t *testing.T, s *Store, ctx StrategyContext, session, text, topic, scope string) string {
	t.Helper()
	snap, job := naturalSource(t, s, ctx, session, text)
	r := naturalResult(text, topic, false, 0)
	r.Scope = scope
	if _, err := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, r); err != nil {
		t.Fatal(err)
	}
	key := "project:" + ctx.ProjectID
	if scope == "user" {
		key = "user"
	}
	var id string
	s.read(func() any {
		id = stringOf(s.row("SELECT id FROM naturalPreferenceEntries WHERE scopeKey=? AND topic=?", key, topic)["id"])
		return nil
	})
	return id
}
func TestNaturalRecallIndependentConsentAndScopePrecedence(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	if _, err := s.SetNaturalMemorySettings(StrategyContext{}, "global-auto", 0, true); err != nil {
		t.Fatal(err)
	}
	global := saveRecallPreference(t, s, ctx, session, "以后所有项目的回复固定用英文。", "response-language", "user")
	project := saveRecallPreference(t, s, ctx, session, "以后这个项目的回复固定用中文。", "response-language", "project")
	items, err := s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if err != nil || len(items) != 0 {
		t.Fatal("new recall silently opted in", items, err)
	}
	if _, err = s.SetNaturalRecallSettings(StrategyContext{}, "global-use", 0, true); err != nil {
		t.Fatal(err)
	}
	items, err = s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if err != nil || len(items) != 1 || items[0].ID != global {
		t.Fatal(items, err)
	}
	if _, err = s.SetNaturalRecallSettings(ctx, "project-use", 0, true); err != nil {
		t.Fatal(err)
	}
	items, err = s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if err != nil || len(items) != 1 || items[0].ID != project || items[0].Scope != "project" {
		t.Fatal("scope precedence", items, err)
	}
	if _, err = s.recallPreferences(ctx, ai.NaturalRecallQuery{ID: global, Revision: 1}); err == nil {
		t.Fatal("shadowed global direct read bypass")
	}
	other := StrategyContext{ProjectID: stringOf(s.CreateProject("Other synthetic")["id"])}
	items, err = s.recallPreferences(other, ai.NaturalRecallQuery{})
	if err != nil || len(items) != 1 || items[0].ID != global {
		t.Fatal("project leak", items, err)
	}
	if _, err = s.recallPreferences(other, ai.NaturalRecallQuery{ID: project, Revision: 1}); err == nil {
		t.Fatal("cross-project direct read bypass")
	}
	// Closing automatic capture must not implicitly stop separately consented use.
	if _, err = s.SetNaturalMemorySettings(ctx, "auto-off", 1, false); err != nil {
		t.Fatal(err)
	}
	items, _ = s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if len(items) != 1 {
		t.Fatal("capture toggle changed use")
	}
	if _, err = s.SetNaturalRecallSettings(ctx, "use-off", 1, false); err != nil {
		t.Fatal(err)
	}
	items, _ = s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if len(items) != 1 || items[0].ID != global {
		t.Fatal("per-scope stop changed global")
	}
	if _, err = s.SetNaturalRecallSettings(StrategyContext{}, "global-off", 1, false); err != nil {
		t.Fatal(err)
	}
	items, _ = s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if len(items) != 0 {
		t.Fatal(items)
	}
	if _, err = s.SetNaturalRecallSettings(ctx, "stale", 0, true); err == nil {
		t.Fatal("stale setting revision")
	}
}
func TestNaturalRecallConflictForgetDeletionAndPrivateGlobalGuard(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	id := saveRecallPreference(t, s, ctx, session, "以后这个项目的报告固定先列结论。", "report-order", "project")
	_, _ = s.SetNaturalRecallSettings(ctx, "on", 0, true)
	snap := consolidationSource(t, s, ctx, session, "以后这个项目的报告固定先列证据。", true)
	batch := consolidationItems(t, s, snap)
	batch[0].Result = naturalResult(snap.UserText, "report-order", false, 1)
	batch[0].Result.Relation = "conflict"
	if _, err := consolidationCommit(t, s, batch); err != nil {
		t.Fatal(err)
	}
	if items, err := s.recallPreferences(ctx, ai.NaturalRecallQuery{}); err != nil || len(items) != 0 {
		t.Fatal("conflicted preference injected", items, err)
	}
	conflicts, _ := s.NaturalConflicts(ctx, "", 20)
	c := objects(conflicts["items"])[0]
	if _, err := s.RejectNaturalConflict(ctx, stringOf(c["id"]), "reject", 1); err != nil {
		t.Fatal(err)
	}
	if items, _ := s.recallPreferences(ctx, ai.NaturalRecallQuery{}); len(items) != 1 {
		t.Fatal("original preference not restored")
	}
	if _, err := s.recallPreferences(ctx, ai.NaturalRecallQuery{ID: id, Revision: 2}); err == nil {
		t.Fatal("wrong version read")
	}
	if _, err := s.ForgetNaturalPreference(ctx, id, "forget", 1); err != nil {
		t.Fatal(err)
	}
	if items, _ := s.recallPreferences(ctx, ai.NaturalRecallQuery{}); len(items) != 0 {
		t.Fatal("forgotten preference read")
	}
	next := saveRecallPreference(t, s, ctx, session, "以后这个项目的回答固定用中文。", "response-language", "project")
	s.DeleteSession(session)
	if _, err := s.recallPreferences(ctx, ai.NaturalRecallQuery{ID: next, Revision: 1}); err == nil {
		t.Fatal("deleted source read")
	}
}
func TestNaturalRecallGlobalPayloadNeverContainsPrivateSourceMetadata(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	_, _ = s.SetNaturalMemorySettings(StrategyContext{}, "auto", 0, true)
	id := saveRecallPreference(t, s, ctx, session, "以后所有项目的回复固定用简短中文。", "response-language", "user")
	_, _ = s.SetNaturalRecallSettings(StrategyContext{}, "use", 0, true)
	items, err := s.recallPreferences(StrategyContext{}, ai.NaturalRecallQuery{})
	if err != nil || len(items) != 1 || items[0].ID != id {
		t.Fatal(items, err)
	}
	raw := jsonText(items)
	for _, secret := range []string{ctx.ProjectID, session, "sourceProject", "sourceMessage", "sourceHash"} {
		if strings.Contains(raw, secret) {
			t.Fatal("private provenance leaked")
		}
	}
	s.update(func() any { s.exec("UPDATE projects SET name=? WHERE id=?", "简短中文", ctx.ProjectID); return nil })
	items, err = s.recallPreferences(StrategyContext{}, ai.NaturalRecallQuery{})
	if err != nil || len(items) != 0 {
		t.Fatal("late private metadata leaked", items, err)
	}
}
func TestNaturalRecallMigrationKeepsOldRowsAndRejectsFutureSchema(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.CreateProject("synthetic")
	s.exec("DROP TABLE naturalRecallSettings")
	s.exec("DROP TABLE naturalRecallMeta")
	old := jsonText(s.rows("SELECT * FROM strategySettings"))
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if jsonText(s.rows("SELECT * FROM strategySettings")) != old {
		t.Fatal("legacy settings modified")
	}
	if boolOf(s.naturalRecallSettings(StrategyContext{})["useEnabled"]) {
		t.Fatal("default use enabled")
	}
	_, _ = s.SetNaturalRecallSettings(StrategyContext{}, "use", 0, true)
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !boolOf(s.naturalRecallSettings(StrategyContext{})["useEnabled"]) {
		t.Fatal("lost setting")
	}
	s.Close()
	backup, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-natural-recall-v1-*.sqlite"))
	if len(backup) != 1 {
		t.Fatal(backup)
	}
	stat, _ := os.Stat(backup[0])
	if !platform.Private(backup[0], stat) {
		t.Fatal("backup not private")
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.exec("UPDATE naturalRecallMeta SET schemaHash='future'")
	s.Close()
	if next, err := OpenStore(dir); err == nil {
		next.Close()
		t.Fatal("future schema accepted")
	}
}
func TestNaturalRecallHostCannotResolveDeletedBusinessSession(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	b.Store.DeleteSession(id)
	if _, err := b.naturalRecallProvider(context.Background(), id, ai.NaturalRecallQuery{}); err == nil {
		t.Fatal("deleted owner accepted")
	}
}

func TestNaturalRecallFreshSourceAfterForgetCanFormNewPreference(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	first := consolidationSource(t, s, ctx, session, "以后这个项目的回复固定用中文。", false)
	items := consolidationItems(t, s, first)
	items[0].Result = naturalResult(first.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	if _, err := consolidationCommit(t, s, items); err != nil {
		t.Fatal(err)
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	id := stringOf(objects(page["items"])[0]["id"])
	if _, err := s.ForgetNaturalPreference(ctx, id, "forget", 1); err != nil {
		t.Fatal(err)
	}
	if s.MemoryCaptureAllowed(first) {
		t.Fatal("old source authorized after forget")
	}
	next := consolidationSource(t, s, ctx, session, "以后这个项目的回复固定用简短中文。", false)
	items = consolidationItems(t, s, next)
	items[0].Result = naturalResult(next.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	if _, err := consolidationCommit(t, s, items); err != nil {
		t.Fatal("new genuine post-forget source blocked", err)
	}
	_, _ = s.SetNaturalRecallSettings(ctx, "use", 0, true)
	got, err := s.recallPreferences(ctx, ai.NaturalRecallQuery{})
	if err != nil || len(got) != 1 || got[0].Body != next.UserText || got[0].Revision != 3 {
		t.Fatal("old body revived", got, err)
	}
}
