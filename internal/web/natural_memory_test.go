package web

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/platform"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func naturalAdopt(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope) (StrategyMutationResult, StrategyRevisionView) {
	t.Helper()
	a, e := s.CreateStrategyAsset(ctx, scope, "legacy preference", StrategyAssetInput{Title: "结论与证据", Kind: strategy.UserPreference, Body: "先报告结论，再列证据。", Applicability: strategy.Applicability{}})
	if e != nil {
		t.Fatal(e)
	}
	v, e := s.GetStrategyRevision(ctx, a.AssetID, 1)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.BindStrategyAsset(ctx, scope, "adopt-"+a.AssetID, StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref, Priority: 13, ExclusionGroup: "report"})
	if e != nil {
		t.Fatal(e)
	}
	return a, v
}
func TestNaturalMemoryCarryUndoKeepsOneRuntimeAndExactLegacyData(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	a, v := naturalAdopt(t, s, ctx, scope)
	before := s.read(func() any { return jsonText(s.rows("SELECT * FROM strategyBindings")) })
	selected, e := s.resolveStrategyBindings(ctx, strategy.SelectionQuery{Profile: "core", ResourceKinds: []string{"local"}}, nil, nil)
	if e != nil || len(selected.Assets) != 1 {
		t.Fatal(selected, e)
	}
	preview, e := s.PreviewNaturalMemory(ctx, a.AssetID)
	if e != nil || preview["eligible"] != true {
		t.Fatal(preview, e)
	}
	r, e := s.CarryNaturalPreference(ctx, a.AssetID, "carry", stringOf(preview["previewToken"]), 0)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := s.CarryNaturalPreference(ctx, a.AssetID, "carry", stringOf(preview["previewToken"]), 0)
	if e != nil || replay["changeId"] != r["changeId"] || replay["replayed"] != true {
		t.Fatal(replay, e)
	}
	entry, e := s.ReadNaturalPreference(ctx, a.AssetID)
	if e != nil || entry["body"] != v.Value.Body || entry["state"] != "mapped" {
		t.Fatal(entry, e)
	}
	_, e = s.CarryNaturalPreference(ctx, a.AssetID, "again", stringOf(preview["previewToken"]), 1)
	strategyCheckError(t, e, 409)
	after := s.read(func() any { return jsonText(s.rows("SELECT * FROM strategyBindings")) })
	selected, e = s.resolveStrategyBindings(ctx, strategy.SelectionQuery{Profile: "core", ResourceKinds: []string{"local"}}, nil, nil)
	if before != after || e != nil || len(selected.Assets) != 1 || selected.Assets[0].Ref != v.Value.Ref {
		t.Fatal("carry changed runtime/bindings", e)
	}
	undo, e := s.UndoNaturalMemoryCarry(ctx, stringOf(r["changeId"]), "undo", 1)
	if e != nil || integer(undo["revision"]) != 2 {
		t.Fatal(undo, e)
	}
	entry, e = s.ReadNaturalPreference(ctx, a.AssetID)
	if e != nil || entry["state"] != "undone" {
		t.Fatal(entry, e)
	}
	after = s.read(func() any { return jsonText(s.rows("SELECT * FROM strategyBindings")) })
	if before != after {
		t.Fatal("undo changed user's existing application")
	}
}

func TestNaturalMemoryStalePreviewUndoAndSourceWithdrawal(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	a, _ := naturalAdopt(t, s, ctx, scope)
	p, _ := s.PreviewNaturalMemory(ctx, a.AssetID)
	input := StrategyAssetInput{Title: "结论与证据", Kind: strategy.UserPreference, Body: "以后报告先列待核实项。", Applicability: strategy.Applicability{}}
	_, e := s.ReviseStrategyAsset(ctx, a.AssetID, "edit", 1, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.CarryNaturalPreference(ctx, a.AssetID, "old-preview", stringOf(p["previewToken"]), 0)
	strategyCheckError(t, e, 409)
	p, _ = s.PreviewNaturalMemory(ctx, a.AssetID)
	r, e := s.CarryNaturalPreference(ctx, a.AssetID, "current", stringOf(p["previewToken"]), 0)
	if e != nil {
		t.Fatal(e)
	}
	v, _ := s.GetStrategyRevision(ctx, a.AssetID, 2)
	_, e = s.BindStrategyAsset(ctx, scope, "new-version", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref, ExpectedRevision: 1})
	if e != nil {
		t.Fatal(e)
	}
	entry, _ := s.ReadNaturalPreference(ctx, a.AssetID)
	if entry["state"] != "conflict" || integer(entry["contentRevision"]) != 1 {
		t.Fatal(entry)
	}
	_, e = s.UndoNaturalMemoryCarry(ctx, stringOf(r["changeId"]), "stale-undo", 1)
	strategyCheckError(t, e, 409)
	_, e = s.ForgetStrategySource(ctx, a.SourceID, "withdraw", true)
	if e != nil {
		t.Fatal(e)
	}
	entry, _ = s.ReadNaturalPreference(ctx, a.AssetID)
	if entry["state"] != "unavailable" || entry["body"] != "" || entry["title"] != "" {
		t.Fatal("withdrawal exposed old content", entry)
	}
	// An old successful carry receipt must not bypass current withdrawn dependencies.
	_, e = s.CarryNaturalPreference(ctx, a.AssetID, "current", stringOf(p["previewToken"]), 0)
	strategyCheckError(t, e, 409)
}

func TestNaturalMemoryCarryScopeEligibilityAndConcurrentCAS(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	a, _ := naturalAdopt(t, s, ctx, scope)
	other := StrategyContext{ProjectID: stringOf(s.CreateProject("other")["id"])}
	for _, foreign := range []StrategyContext{{}, other} {
		_, e := s.PreviewNaturalMemory(foreign, a.AssetID)
		strategyCheckError(t, e, 404)
		_, e = s.ReadNaturalPreference(foreign, a.AssetID)
		strategyCheckError(t, e, 404)
	}
	unused := createStrategyFixture(t, s, ctx, scope, "unadopted", "未采用偏好")
	p, _ := s.PreviewNaturalMemory(ctx, unused.AssetID)
	if p["eligible"] != false || p["reason"] != "not_adopted" {
		t.Fatal(p)
	}
	_, e := s.CarryNaturalPreference(ctx, unused.AssetID, "deny", stringOf(p["previewToken"]), 0)
	strategyCheckError(t, e, 409)
	p, _ = s.PreviewNaturalMemory(ctx, a.AssetID)
	results := make(chan error, 2)
	var group sync.WaitGroup
	for _, key := range []string{"one", "two"} {
		group.Add(1)
		go func(key string) {
			defer group.Done()
			_, e := s.CarryNaturalPreference(ctx, a.AssetID, key, stringOf(p["previewToken"]), 0)
			results <- e
		}(key)
	}
	group.Wait()
	close(results)
	ok, conflict := 0, 0
	for e := range results {
		if e == nil {
			ok++
		} else {
			strategyCheckError(t, e, 409)
			conflict++
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatal(ok, conflict)
	}
}

func TestNaturalMemorySettingsNeverInheritOldExecutionConsent(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	s.SetMemorySettings(ctx.ProjectID, false, true, 0)
	before := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemorySettings")) })
	s.update(func() any {
		v := s.strategySettings(strategy.Scope{Kind: strategy.UserScope})
		v.LearnEnabled, v.CorrectEnabled, v.OnlineCorrectEnabled = true, true, true
		s.strategySaveSettings("user", v)
		return nil
	})
	settings, e := s.NaturalMemorySettings(ctx)
	if e != nil || settings["autoEnabled"] != false || settings["automaticReady"] != true || object(settings["projectMemorySettings"])["useEnabled"] != false || object(settings["projectMemorySettings"])["extractionEnabled"] != true {
		t.Fatal(settings, e)
	}
	// Only a NEW explicit settings write opts in; legacy flags above did not.
	_, e = s.SetNaturalMemorySettings(ctx, "new-consent", 0, true)
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.SetNaturalMemorySettings(ctx, "disable", 1, false)
	if e != nil || integer(r["revision"]) != 2 {
		t.Fatal(r, e)
	}
	_, e = s.SetNaturalMemorySettings(ctx, "stale", 0, false)
	strategyCheckError(t, e, 409)
	if after := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemorySettings")) }); after != before {
		t.Fatal("natural settings changed original project settings")
	}
	old, _ := s.GetStrategySettings(ctx, scope)
	if old.Revision != 0 {
		t.Fatal("project scope was implicitly enabled", old)
	}
}

func TestNaturalMemoryMigrationBackupRestartAndFutureGuard(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	ctx := StrategyContext{ProjectID: stringOf(s.CreateProject("old")["id"])}
	a, _ := naturalAdopt(t, s, ctx, naturalScope(ctx))
	s.exec("DROP TABLE naturalMemoryReceipts;DROP TABLE naturalMemoryChanges;DROP TABLE naturalMemoryLinks;DROP TABLE naturalMemorySettings;DROP TABLE naturalMemoryMeta")
	s.Close()
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	p, _ := s.PreviewNaturalMemory(ctx, a.AssetID)
	r, e := s.CarryNaturalPreference(ctx, a.AssetID, "carry", stringOf(p["previewToken"]), 0)
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-natural-memory-v1-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal(backups)
	}
	info, e := os.Stat(backups[0])
	if e != nil || !platform.Private(backups[0], info) {
		t.Fatal(info, e)
	}
	old, e := openSQLite(backups[0])
	if e != nil {
		t.Fatal(e)
	}
	var name string
	if e = old.QueryRow("SELECT name FROM sqlite_master WHERE name='naturalMemoryMeta'").Scan(&name); e != sql.ErrNoRows {
		t.Fatal("backup already migrated", e)
	}
	old.Close()
	for i := 0; i < 2; i++ {
		s, e = OpenStore(dir)
		if e != nil {
			t.Fatal(e)
		}
		entry, e := s.ReadNaturalPreference(ctx, a.AssetID)
		if e != nil || integer(entry["revision"]) != 1 || entry["state"] != "mapped" {
			t.Fatal(entry, e)
		}
		history, _ := s.NaturalMemoryChanges(ctx, "", 50)
		if len(objects(history["items"])) != 1 || objects(history["items"])[0]["id"] != r["changeId"] {
			t.Fatal(history)
		}
		s.Close()
	}
	db, e := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec("UPDATE naturalMemoryMeta SET schemaHash='future'")
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("future schema opened")
	}
}

func TestNaturalMemoryPromotedSourceRemainsPrivateAndRevocable(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	candidate, source := reviewCandidate(t, s, ctx, scope)
	v, _ := s.GetStrategyRevision(ctx, candidate.AssetID, 1)
	acceptReview(t, s, ctx, v.Value.Ref)
	public, e := s.PromoteStrategyRevision(ctx, candidate.AssetID, "public", v.Value.Ref, promotionDraft(), true)
	if e != nil {
		t.Fatal(e)
	}
	global := StrategyContext{}
	pv, _ := s.GetStrategyRevision(global, public.AssetID, 1)
	_, e = s.BindStrategyAsset(global, strategy.Scope{Kind: strategy.UserScope}, "adopt-public", StrategyBindingInput{Action: "adopt", Ref: pv.Value.Ref})
	if e != nil {
		t.Fatal(e)
	}
	p, e := s.PreviewNaturalMemory(global, public.AssetID)
	if e != nil || p["eligible"] != true {
		t.Fatal(p, e)
	}
	_, e = s.CarryNaturalPreference(global, public.AssetID, "carry-public", stringOf(p["previewToken"]), 0)
	if e != nil {
		t.Fatal(e)
	}
	entry, e := s.ReadNaturalPreference(global, public.AssetID)
	if e != nil {
		t.Fatal(e)
	}
	raw := jsonText(entry)
	for _, private := range []string{"PRIVATE_PROJECT_ONLY", ctx.ProjectID, source.SourceID, candidate.AssetID} {
		if strings.Contains(raw, private) {
			t.Fatal("private project provenance leaked")
		}
	}
	_, e = s.ForgetStrategySource(ctx, source.SourceID, "withdraw", true)
	if e != nil {
		t.Fatal(e)
	}
	entry, e = s.ReadNaturalPreference(global, public.AssetID)
	if e != nil || entry["body"] != "" || entry["state"] != "unavailable" {
		t.Fatal(entry, e)
	}
}

func TestNaturalMemoryExplicitRefreshAndUndoDoNotOverwriteLaterLegacyEdits(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	a, _ := naturalAdopt(t, s, ctx, scope)
	p, _ := s.PreviewNaturalMemory(ctx, a.AssetID)
	initial, e := s.CarryNaturalPreference(ctx, a.AssetID, "initial", stringOf(p["previewToken"]), 0)
	if e != nil {
		t.Fatal(e)
	}
	input := StrategyAssetInput{Title: "新偏好", Kind: strategy.UserPreference, Body: "先说明待核实项。", Applicability: strategy.Applicability{}}
	_, e = s.ReviseStrategyAsset(ctx, a.AssetID, "edit", 1, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	newer, _ := s.GetStrategyRevision(ctx, a.AssetID, 2)
	_, e = s.BindStrategyAsset(ctx, scope, "new-adoption", StrategyBindingInput{Action: "adopt", Ref: newer.Value.Ref, ExpectedRevision: 1})
	if e != nil {
		t.Fatal(e)
	}
	p, _ = s.PreviewNaturalMemory(ctx, a.AssetID)
	refreshed, e := s.CarryNaturalPreference(ctx, a.AssetID, "refresh", stringOf(p["previewToken"]), 1)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.UndoNaturalMemoryCarry(ctx, stringOf(initial["changeId"]), "old-undo", 2)
	strategyCheckError(t, e, 409)
	_, e = s.UndoNaturalMemoryCarry(ctx, stringOf(refreshed["changeId"]), "new-undo", 2)
	if e != nil {
		t.Fatal(e)
	}
	entry, _ := s.ReadNaturalPreference(ctx, a.AssetID)
	if integer(entry["contentRevision"]) != 1 || entry["state"] != "conflict" || integer(entry["revision"]) != 3 {
		t.Fatal(entry)
	}
	binding, e := s.GetStrategyBinding(ctx, scope, a.AssetID)
	if e != nil || binding.Revision != 2 {
		t.Fatal("undo overwrote legacy application", binding, e)
	}
}

func TestNaturalMemoryFailedDDLDoesNotPublishMigrationMarker(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	project := stringOf(s.CreateProject("keep")["id"])
	s.exec("DROP TABLE naturalMemoryReceipts;DROP TABLE naturalMemoryChanges;DROP TABLE naturalMemoryLinks;DROP TABLE naturalMemorySettings;DROP TABLE naturalMemoryMeta;CREATE TABLE naturalMemoryLinks(conflict INTEGER)")
	s.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("DDL collision accepted")
	}
	db, e := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var n int
	if e = db.QueryRow("SELECT count(*) FROM projects WHERE id=?", project).Scan(&n); e != nil || n != 1 {
		t.Fatal("existing project changed", n, e)
	}
	if e = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='naturalMemoryMeta'").Scan(&n); e != nil || n != 0 {
		t.Fatal("partial migration marker committed", n, e)
	}
}

func TestNaturalMemoryGlobalCarryPreservesProjectDisable(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	global := strategy.Scope{Kind: strategy.UserScope}
	a, v := naturalAdopt(t, s, StrategyContext{}, global)
	_, e := s.BindStrategyAsset(ctx, scope, "local-adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref})
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.BindStrategyAsset(ctx, scope, "local-disable", StrategyBindingInput{Action: "disable", Ref: v.Value.Ref, ExpectedRevision: 1})
	if e != nil {
		t.Fatal(e)
	}
	p, _ := s.PreviewNaturalMemory(StrategyContext{}, a.AssetID)
	_, e = s.CarryNaturalPreference(StrategyContext{}, a.AssetID, "global-carry", stringOf(p["previewToken"]), 0)
	if e != nil {
		t.Fatal(e)
	}
	for _, project := range []struct {
		ctx   StrategyContext
		count int
	}{{ctx, 0}, {StrategyContext{ProjectID: stringOf(s.CreateProject("other")["id"])}, 1}} {
		selected, e := s.resolveStrategyBindings(project.ctx, strategy.SelectionQuery{Profile: "core"}, nil, nil)
		if e != nil || len(selected.Assets) != project.count {
			t.Fatal("project override changed", selected, e)
		}
	}
	_, e = s.PreviewNaturalMemory(ctx, a.AssetID)
	strategyCheckError(t, e, 404)
}
