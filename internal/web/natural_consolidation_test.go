package web

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func consolidationSource(t *testing.T, s *Store, ctx StrategyContext, session, text string, legacy bool) ai.MemoryTurnSnapshot {
	t.Helper()
	m := s.AddMessage(session, "user", text, nil)
	settings := s.MemorySettings(ctx.ProjectID)
	snap := testMemorySnapshot(ctx.ProjectID, session, ident(), integer(settings["epoch"]), integer(settings["revision"]))
	snap.UserText = text
	snap.SourceMessageID = stringOf(m["id"])
	snap.Natural = s.NaturalConsent(ctx.ProjectID)
	snap.LegacyExtraction = legacy
	snap = ai.SealMemorySnapshot(snap)
	if e := s.EnqueueMemoryTurn(snap); e != nil {
		t.Fatal(e)
	}
	return snap
}
func consolidationItems(t *testing.T, s *Store, snap ai.MemoryTurnSnapshot) []naturalBatchItem {
	t.Helper()
	job := s.ClaimMemoryJob()
	if job == nil {
		t.Fatal("no job")
	}
	return s.claimNaturalPeers(job, snap)
}
func consolidationCommit(t *testing.T, s *Store, items []naturalBatchItem) (bool, error) {
	t.Helper()
	index := s.read(func() any { return s.naturalPreferenceIndex(items[0].Snapshot) }).([]Object)
	guard := s.read(func() any { return s.naturalBatchUserGuard(items) }).(string)
	return s.commitNaturalBatch(items, ai.Usage{}, index, guard, ident())
}
func TestNaturalConsolidationBatchMergeCorrectionAndOneNoticeGroup(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后这个项目的答复固定用中文。", false)
	consolidationSource(t, s, ctx, session, "本项目后续的答复都使用中文。", false)
	consolidationSource(t, s, ctx, session, "更正本项目长期偏好：以后答复固定英文。", false)
	consolidationSource(t, s, ctx, session, "以后本项目报告固定先列结论。", false)
	items := consolidationItems(t, s, a)
	if len(items) != 4 {
		t.Fatal("not batched", len(items))
	}
	for i := range items {
		r := naturalResult(items[i].Snapshot.UserText, "response-language", false, 0)
		r.Relation = "new"
		if i == 1 {
			r.Relation = "equivalent"
			r.ExpectedRevision = 1
		}
		if i == 2 {
			r.Relation = "correction"
			r.Replacement = true
			r.ExpectedRevision = 2
		}
		if i == 3 {
			r.Topic = "report-order"
		}
		items[i].Result = r
	}
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(page["items"])) != 2 {
		t.Fatal(page)
	}
	for _, p := range objects(page["items"]) {
		if p["topic"] == "response-language" && (integer(p["revision"]) != 3 || p["body"] != items[2].Snapshot.UserText) {
			t.Fatal(p)
		}
	}
	notices := objects(s.Snapshot(session)["naturalMemoryNotices"])
	if len(notices) != 2 || notices[0]["batchId"] == "" || notices[0]["batchId"] != notices[1]["batchId"] {
		t.Fatal("batch notice identities lost", notices)
	}
	status, _ := s.NaturalConsolidationStatus(ctx)
	if integer(status["processed"]) != 4 || integer(status["captured"]) != 0 {
		t.Fatal(status)
	}
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	merged := false
	for _, c := range objects(changes["items"]) {
		merged = merged || c["kind"] == "merge"
	}
	if !merged {
		t.Fatal("semantic merge history missing")
	}
}
func TestNaturalConsolidationSupportsRetainIndependentSourcesAndUndo(t *testing.T) {
	s, ctx, first := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, first, "以后本项目固定先列结论。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "report-order", false, 0)
	items[0].Result.Relation = "new"
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	second := stringOf(s.CreateSession(ctx.ProjectID, "second", nil)["id"])
	b := consolidationSource(t, s, ctx, second, "这个项目后续报告都先给结论。", false)
	items = consolidationItems(t, s, b)
	items[0].Result = naturalResult(b.UserText, "report-order", false, 1)
	items[0].Result.Relation = "equivalent"
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	p := objects(page["items"])[0]
	if len(objects(p["sources"])) != 2 || p["body"] != b.UserText {
		t.Fatal("source merge lost", p)
	}
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	var merge Object
	for _, c := range objects(changes["items"]) {
		if c["kind"] == "merge" {
			merge = c
		}
	}
	if _, e := s.UndoNaturalPreference(ctx, stringOf(merge["id"]), "undo-merge", 2); e != nil {
		t.Fatal(e)
	}
	v, _ := s.ReadNaturalFormedPreference(ctx, stringOf(p["id"]), 0)
	if v["body"] != a.UserText || len(objects(v["sources"])) != 1 {
		t.Fatal("merge undo lost exact source set", v)
	}
	s.DeleteSession(second)
	v, _ = s.ReadNaturalFormedPreference(ctx, stringOf(p["id"]), 0)
	if v["body"] != a.UserText {
		t.Fatal("unrelated source erased restored body")
	}
	s.DeleteSession(first)
	v, _ = s.ReadNaturalFormedPreference(ctx, stringOf(p["id"]), 0)
	if v["body"] != "" || v["state"] != "unavailable" {
		t.Fatal("deleted source resurrected")
	}
}
func TestNaturalConsolidationConflictAndExplicitCorrection(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后这个项目固定使用中文。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	b := consolidationSource(t, s, ctx, session, "以后这个项目固定使用英文。", false)
	items = consolidationItems(t, s, b)
	items[0].Result = naturalResult(b.UserText, "response-language", false, 1)
	items[0].Result.Relation = "conflict"
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	list, _ := s.NaturalFormedPreferences(ctx, "", 20)
	p := objects(list["items"])[0]
	if p["state"] != "conflict" || integer(p["revision"]) != 1 || p["body"] != a.UserText {
		t.Fatal("unclear contradiction overwrote existing", p)
	}
	c := consolidationSource(t, s, ctx, session, "更正这个项目的长期偏好：以后统一使用英文。", false)
	items = consolidationItems(t, s, c)
	items[0].Result = naturalResult(c.UserText, "response-language", true, 1)
	items[0].Result.Relation = "correction"
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	v, _ := s.ReadNaturalFormedPreference(ctx, stringOf(p["id"]), 0)
	if v["state"] != "active" || integer(v["revision"]) != 2 {
		t.Fatal(v)
	}
	conflicts, _ := s.NaturalConflicts(ctx, "", 20)
	if objects(conflicts["items"])[0]["status"] != "superseded" {
		t.Fatal(conflicts)
	}
}
func TestNaturalConsolidationRejectConflictAndSourceWithdrawal(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目的回复固定中文。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	_, _ = consolidationCommit(t, s, items)
	b := consolidationSource(t, s, ctx, session, "以后本项目的回复固定英文。", false)
	items = consolidationItems(t, s, b)
	items[0].Result = naturalResult(b.UserText, "response-language", false, 1)
	items[0].Result.Relation = "conflict"
	_, e := consolidationCommit(t, s, items)
	if e != nil {
		t.Fatal(e)
	}
	conflicts, _ := s.NaturalConflicts(ctx, "", 20)
	c := objects(conflicts["items"])[0]
	if _, e := s.RejectNaturalConflict(ctx, stringOf(c["id"]), "reject", 2); e == nil {
		t.Fatal("stale conflict rejection accepted")
	}
	if _, e := s.RejectNaturalConflict(ctx, stringOf(c["id"]), "reject-current", 1); e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		if s.naturalSnapshotValid(b) {
			t.Fatal("rejected source replayable")
		}
		return nil
	})
	v, _ := s.ReadNaturalFormedPreference(ctx, stringOf(c["entryId"]), 0)
	if v["state"] != "active" || v["body"] != a.UserText {
		t.Fatal(v)
	}
	s.DeleteSession(session)
	conflicts, _ = s.NaturalConflicts(ctx, "", 20)
	if objects(conflicts["items"])[0]["body"] != "" {
		t.Fatal("conflict content survived deletion")
	}
}
func TestNaturalConsolidationStableCoverageAndAtomicLateGuard(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	replay := a
	replay.TurnID = ident()
	replay.CapturedAt = now()
	replay.KnowledgeBaseRevision = 77
	replay = ai.SealMemorySnapshot(replay)
	if e := s.EnqueueMemoryTurn(replay); e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		if integer(s.row("SELECT count(*) n FROM projectMemoryJobs")["n"]) != 1 {
			t.Fatal("callback identity created duplicate job")
		}
		return nil
	})
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	guard := s.read(func() any { return s.naturalBatchUserGuard(items) }).(string)
	s.AddMessage(session, "user", "这次先不要处理这些。", nil)
	if _, e := s.commitNaturalBatch(items, ai.Usage{}, nil, guard, ident()); e == nil {
		t.Fatal("late result accepted after new message")
	}
	status, _ := s.NaturalConsolidationStatus(ctx)
	if integer(status["captured"]) != 1 || integer(status["processed"]) != 0 {
		t.Fatal("failed commit advanced coverage", status)
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(page["items"])) != 0 {
		t.Fatal("partial transaction committed")
	}
}
func TestNaturalConsolidationParserNeedsExactCompleteSourceSet(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	consolidationSource(t, s, ctx, session, "以后本项目固定先列结论。", false)
	items := consolidationItems(t, s, a)
	results := []Object{}
	for _, item := range items {
		results = append(results, Object{"sourceId": item.Job["jobId"], "relation": "new", "preference": naturalResult(item.Snapshot.UserText, "response-language", false, 0), "legacy": Object{"schemaVersion": 1, "mutations": []any{}}})
	}
	output := jsonText(Object{"schemaVersion": 1, "results": results})
	if _, e := parseNaturalConsolidation(output, items); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{jsonText(Object{"schemaVersion": 1, "results": results[:1]}), strings.Replace(output, stringOf(items[0].Job["jobId"]), "guessed-source", 1), strings.Replace(output, `"relation":"new"`, `"relation":"correction"`, 1)} {
		if _, e := parseNaturalConsolidation(bad, items); e == nil {
			t.Fatal("incomplete/forged consolidation accepted")
		}
	}
}
func TestNaturalConsolidationExactRepeatSkipsProviderAndKeepsSources(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	_, _ = consolidationCommit(t, s, items)
	b := consolidationSource(t, s, ctx, session, a.UserText, false)
	items = consolidationItems(t, s, b)
	local := s.read(func() any {
		r, ok := s.naturalLocalExact(items)
		if !ok {
			t.Fatal("identical explicit preference not recognized locally")
		}
		return r
	}).([]naturalBatchItem)
	if _, e := consolidationCommit(t, s, local); e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		if integer(s.row("SELECT count(*) n FROM naturalPreferenceDispatches")["n"]) != 0 {
			t.Fatal("local duplicate dispatched")
		}
		return nil
	})
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(objects(page["items"])[0]["sources"])) != 2 {
		t.Fatal("new independent confirmation lost")
	}
}
func TestNaturalConsolidationForgetPreventsAllSupportAndConflictReplay(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	_, _ = consolidationCommit(t, s, items)
	b := consolidationSource(t, s, ctx, session, "以后本项目固定英文。", false)
	items = consolidationItems(t, s, b)
	items[0].Result = naturalResult(b.UserText, "response-language", false, 1)
	items[0].Result.Relation = "conflict"
	_, _ = consolidationCommit(t, s, items)
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	p := objects(page["items"])[0]
	if _, e := s.ForgetNaturalPreference(ctx, stringOf(p["id"]), "forget", 1); e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		if s.naturalSnapshotValid(a) || s.naturalSnapshotValid(b) {
			t.Fatal("forgotten merged source eligible")
		}
		if integer(s.row("SELECT count(*) n FROM naturalPreferenceContent")["n"]) != 0 || integer(s.row("SELECT count(*) n FROM naturalPreferenceConflictContent")["n"]) != 0 {
			t.Fatal("forgotten payload retained")
		}
		return nil
	})
}
func TestRetiredDispatchersAbsentFromProductionAST(t *testing.T) {
	forbidden := map[string]bool{"runStrategyWorker": true, "runExperimentWorker": true, "executeStrategyProposal": true, "executeExperiment": true, "ExtractStrategyProposal": true, "strategyForegroundModel": true}
	for _, dir := range []string{".", "../ai"} {
		files, e := os.ReadDir(dir)
		if e != nil {
			t.Fatal(e)
		}
		for _, file := range files {
			if !strings.HasSuffix(file.Name(), ".go") || strings.HasSuffix(file.Name(), "_test.go") {
				continue
			}
			node, e := parser.ParseFile(token.NewFileSet(), filepath.Join(dir, file.Name()), nil, 0)
			if e != nil {
				t.Fatal(e)
			}
			ast.Inspect(node, func(n ast.Node) bool {
				if f, ok := n.(*ast.FuncDecl); ok && forbidden[f.Name.Name] {
					t.Error("retired production dispatcher", file.Name(), f.Name.Name)
				}
				if call, ok := n.(*ast.CallExpr); ok {
					if selector, ok := call.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "RunStrategyVariant" {
						t.Error("product can dispatch historical variants", file.Name())
					}
				}
				return true
			})
		}
	}
}
func TestNaturalConsolidationInputBudgetDoesNotCoverTrimmedSource(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	_, _ = b.Store.SetNaturalMemorySettings(ctx, "on", 0, true)
	text := "以后本项目固定中文。" + strings.Repeat("纯虚构说明", 2400)
	snap := consolidationSource(t, b.Store, ctx, session, text, true)
	b.Models.Save(&ai.Model{URL: "http://127.0.0.1:1", Name: "input-budget", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	snap.ModelRef = ai.ModelIdentity(*b.Models.Active())
	snap = ai.SealMemorySnapshot(snap)
	b.Store.update(func() any {
		b.Store.exec("UPDATE projectMemoryTurns SET snapshotJSON=?,snapshotHash=? WHERE sessionId=?", jsonText(snap), snap.SnapshotHash, session)
		return nil
	})
	b.messageMu.Lock()
	b.memoryLastForeground = time.Time{}
	b.messageMu.Unlock()
	b.processOneMemoryJob()
	b.Store.read(func() any {
		row := b.Store.row("SELECT stage,reason FROM naturalMemoryCoverage WHERE sessionId=?", session)
		if row["stage"] != "deferred" || row["reason"] != "input_budget_uncovered" {
			t.Fatal(row)
		}
		if integer(b.Store.row("SELECT count(*) n FROM naturalPreferenceDispatches")["n"]) != 0 {
			t.Fatal("oversized input reserved provider")
		}
		return nil
	})
}
func TestNaturalConsolidationBoundedBatchTailRemainsCaptured(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	var first ai.MemoryTurnSnapshot
	for i := 0; i < 8; i++ {
		snap := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
		if i == 0 {
			first = snap
		}
	}
	items := consolidationItems(t, s, first)
	if len(items) != naturalBatchLimit {
		t.Fatal("batch not bounded", len(items))
	}
	for i := range items {
		items[i].Result = NaturalPreferenceResult{SchemaVersion: 1, Decision: "ignore", Scope: "none", Relation: "none"}
	}
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	status, _ := s.NaturalConsolidationStatus(ctx)
	if integer(status["processed"]) != 6 || integer(status["captured"]) != 2 {
		t.Fatal("unhandled sources marked covered", status)
	}
}
func TestNaturalConsolidationMigrationBackfillsReferencesAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	project := stringOf(s.CreateProject("synthetic")["id"])
	session := stringOf(s.CreateSession(project, "source", nil)["id"])
	ctx := StrategyContext{ProjectID: project}
	_, _ = s.SetNaturalMemorySettings(ctx, "consent", 0, true)
	snap, job := naturalSource(t, s, ctx, session, "以后本项目固定中文。")
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "response-language", false, 0)); e != nil {
		t.Fatal(e)
	}
	s.exec("DROP TABLE naturalPreferenceConflictContent;DROP TABLE naturalPreferenceConflicts;DROP TABLE naturalPreferenceSupports;DROP TABLE naturalMemoryRelations;DROP TABLE naturalMemoryBatchMembers;DROP TABLE naturalMemoryBatches;DROP TABLE naturalMemoryCoverage;DROP TABLE naturalConsolidationMeta")
	s.Close()
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		if integer(s.row("SELECT count(*) n FROM naturalPreferenceSupports")["n"]) != 1 {
			t.Fatal("N2 source not adapted")
		}
		if integer(s.row("SELECT count(*) n FROM naturalPreferenceContent")["n"]) != 1 {
			t.Fatal("body copied on migration")
		}
		return nil
	})
	s.Close()
	for i := 0; i < 2; i++ {
		s, e = OpenStore(dir)
		if e != nil {
			t.Fatal(e)
		}
		s.Close()
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-natural-consolidation-v1-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("backup not idempotent")
	}
	info, _ := os.Stat(backups[0])
	if info.Mode().Perm() != 0600 {
		t.Fatal("backup not private")
	}
	db, e := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	_, _ = db.Exec("UPDATE naturalConsolidationMeta SET schemaHash='future'")
	db.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("unknown consolidation schema opened")
	}
}
func TestNaturalConsolidationMigrationDDLFailureIsAtomic(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	project := s.CreateProject("preserve")
	s.exec("DROP TABLE naturalPreferenceConflictContent;DROP TABLE naturalPreferenceConflicts;DROP TABLE naturalPreferenceSupports;DROP TABLE naturalMemoryRelations;DROP TABLE naturalMemoryBatchMembers;DROP TABLE naturalMemoryBatches;DROP TABLE naturalMemoryCoverage;DROP TABLE naturalConsolidationMeta;CREATE TABLE naturalMemoryCoverage(collision INTEGER)")
	s.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("DDL collision opened")
	}
	db, e := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var n int
	if e = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='naturalConsolidationMeta'").Scan(&n); e != nil || n != 0 {
		t.Fatal("partial marker", e, n)
	}
	if e = db.QueryRow("SELECT count(*) FROM projects WHERE id=?", project["id"]).Scan(&n); e != nil || n != 1 {
		t.Fatal("old data changed", e, n)
	}
}
func TestNaturalConsolidationRecoveryPreservesUnknownReservationsAndCoverage(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	job := s.ClaimMemoryJob()
	if job == nil {
		t.Fatal("missing job")
	}
	s.update(func() any {
		s.exec("INSERT INTO naturalPreferenceDispatches(id,jobId,projectId,startedAt) VALUES(?,?,?,?)", ident(), job["jobId"], ctx.ProjectID, now())
		return nil
	})
	s.RecoverMemoryJobs()
	s.read(func() any {
		row := s.row("SELECT status,usageJSON FROM naturalPreferenceDispatches")
		if row["status"] != "interrupted" || row["usageJSON"] != "{}" {
			t.Fatal("unknown cost was erased", row)
		}
		if s.row("SELECT stage FROM naturalMemoryCoverage WHERE turnSequence=?", job["turnSequence"])["stage"] != "captured" {
			t.Fatal("restart invented processing")
		}
		return nil
	})
	replay := snap
	replay.CapturedAt = now()
	replay = ai.SealMemorySnapshot(replay)
	if e := s.EnqueueMemoryTurn(replay); e != nil {
		t.Fatal(e)
	}
	recovered := s.ClaimMemoryJob()
	if recovered == nil || recovered["jobId"] != job["jobId"] {
		t.Fatal("canonical source not resumed")
	}
}
func TestNaturalConsolidationAtomicBatchRejectsLaterUserUndo(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "response-language", false, 0)
	items[0].Result.Relation = "new"
	_, _ = consolidationCommit(t, s, items)
	next := consolidationSource(t, s, ctx, session, "本项目后续答复都采用中文。", false)
	consolidationSource(t, s, ctx, session, "以后本项目报告固定先给结论。", false)
	items = consolidationItems(t, s, next)
	index := s.read(func() any { return s.naturalPreferenceIndex(next) }).([]Object)
	guard := s.read(func() any { return s.naturalBatchUserGuard(items) }).(string)
	items[0].Result = naturalResult(next.UserText, "response-language", false, 1)
	items[0].Result.Relation = "equivalent"
	items[1].Result = naturalResult(items[1].Snapshot.UserText, "report-order", false, 0)
	items[1].Result.Relation = "new"
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	change := objects(changes["items"])[0]
	if _, e := s.UndoNaturalPreference(ctx, stringOf(change["id"]), "user-undo", 1); e != nil {
		t.Fatal(e)
	}
	if _, e := s.commitNaturalBatch(items, ai.Usage{}, index, guard, ident()); e == nil {
		t.Fatal("late batch overwrote undo")
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(page["items"])) != 1 || objects(page["items"])[0]["state"] != "undone" {
		t.Fatal("partial second preference escaped transaction", page)
	}
}
func TestNaturalConsolidationDifferentConditionsCannotMerge(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	a := consolidationSource(t, s, ctx, session, "以后本项目只在生产排障报告里先列风险。", false)
	items := consolidationItems(t, s, a)
	items[0].Result = naturalResult(a.UserText, "report-order", false, 0)
	items[0].Result.Relation = "new"
	_, e := consolidationCommit(t, s, items)
	if e != nil {
		t.Fatal(e)
	}
	b := consolidationSource(t, s, ctx, session, "以后本项目只在开发排障报告里先列风险。", false)
	items = consolidationItems(t, s, b)
	items[0].Result = naturalResult(b.UserText, "report-order", false, 1)
	items[0].Result.Relation = "equivalent"
	if _, e := consolidationCommit(t, s, items); e == nil {
		t.Fatal("different conditions widened preference")
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	p := objects(page["items"])[0]
	if p["body"] != a.UserText || integer(p["revision"]) != 1 {
		t.Fatal("conditional original overwritten")
	}
}
func TestNaturalConsolidationQueueFullRetainsDurableOutboxUntilSpace(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	_, _ = b.Store.SetNaturalMemorySettings(ctx, "consent", 0, true)
	m := b.Store.AddMessage(session, "user", "以后本项目固定中文。", nil)
	snap := testMemorySnapshot(ctx.ProjectID, session, ident(), 0, 0)
	snap.UserText = stringOf(m["text"])
	snap.SourceMessageID = stringOf(m["id"])
	snap.Natural = b.Store.NaturalConsent(ctx.ProjectID)
	snap = ai.SealMemorySnapshot(snap)
	b.Store.update(func() any {
		for i := 0; i < 100; i++ {
			id := ident()
			b.Store.exec("INSERT INTO projectMemoryTurns(projectId,sessionId,turnId,epoch,knowledgeBaseRevision,snapshotJSON,snapshotHash,modelRefJSON,outcome,createdAt) VALUES(?,?,?,0,0,'','stub','{}','pending',?)", ctx.ProjectID, session, id, now())
			sequence := b.Store.row("SELECT sequence FROM projectMemoryTurns WHERE turnId=?", id)["sequence"]
			b.Store.exec("INSERT INTO projectMemoryJobs(jobId,turnSequence,status,createdAt,updatedAt) VALUES(?,?,'queued',?,?)", ident(), sequence, now(), now())
		}
		return nil
	})
	state := ai.State{View: ai.View{Session: session, Status: "completed"}, MemoryOutbox: []ai.MemoryTurnSnapshot{snap}}
	raw, e := json.Marshal(state)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(b.Engine.Dir, session+".json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	if e = b.reconcileMemoryOutboxForSession(session); e == nil {
		t.Fatal("full queue acknowledged a source")
	}
	out, e := b.Engine.MemoryOutbox(session)
	if e != nil || len(out) != 1 {
		t.Fatal("durable outbox source lost", e)
	}
	status, _ := b.Store.NaturalConsolidationStatus(ctx)
	if integer(status["processed"]) != 0 {
		t.Fatal("full queue pretended success")
	}
	b.Store.update(func() any {
		b.Store.exec("UPDATE projectMemoryJobs SET status='no_op' WHERE jobId=(SELECT jobId FROM projectMemoryJobs LIMIT 1)")
		return nil
	})
	b.reconcileRegisteredMemoryOutboxes()
	out, e = b.Engine.MemoryOutbox(session)
	if e != nil || len(out) != 0 {
		t.Fatal("outbox did not drain when space returned", e)
	}
	b.reconcileRegisteredMemoryOutboxes()
	status, _ = b.Store.NaturalConsolidationStatus(ctx)
	if integer(status["captured"]) != 1 || integer(status["processed"]) != 0 {
		t.Fatal("capture/process progress conflated", status)
	}
}
func TestNaturalConsolidationInvalidSourceStoresNoWithdrawnPayload(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	m := s.AddMessage(session, "user", "以后本项目固定中文。", nil)
	snap := testMemorySnapshot(ctx.ProjectID, session, ident(), 0, 0)
	snap.UserText = stringOf(m["text"])
	snap.SourceMessageID = stringOf(m["id"])
	snap.Natural = s.NaturalConsent(ctx.ProjectID)
	snap = ai.SealMemorySnapshot(snap)
	_, _ = s.SetNaturalMemorySettings(ctx, "off", 1, false)
	if e := s.EnqueueMemoryTurn(snap); e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		row := s.row("SELECT snapshotJSON,outcome FROM projectMemoryTurns WHERE sessionId=?", session)
		if row["snapshotJSON"] != "" || row["outcome"] != "skipped" {
			t.Fatal("withdrawn text stored again", row)
		}
		return nil
	})
}

func TestNaturalConsolidationSameTopicAcrossScopesIsIndependent(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	_, _ = s.SetNaturalMemorySettings(StrategyContext{}, "global-on", 0, true)
	first := consolidationSource(t, s, ctx, session, "以后这个项目的答复固定中文。", false)
	consolidationSource(t, s, ctx, session, "所有项目以后固定使用英文。", false)
	items := consolidationItems(t, s, first)
	for i := range items {
		items[i].Result = naturalResult(items[i].Snapshot.UserText, "response-language", false, 0)
		items[i].Result.Relation = "new"
	}
	items[1].Result.Scope = "user"
	if _, e := consolidationCommit(t, s, items); e != nil {
		t.Fatal(e)
	}
	local, _ := s.NaturalFormedPreferences(ctx, "", 20)
	global, _ := s.NaturalFormedPreferences(StrategyContext{}, "", 20)
	if len(objects(local["items"])) != 1 || len(objects(global["items"])) != 1 {
		t.Fatal("scope targets crossed", local, global)
	}
	raw := jsonText(global)
	for _, private := range []string{ctx.ProjectID, session, first.SourceMessageID, memoryHash(first.UserText)} {
		if strings.Contains(raw, private) {
			t.Fatal("global source identity leaked")
		}
	}
	conflict := consolidationSource(t, s, ctx, session, "所有项目以后固定使用中文。", false)
	next := consolidationItems(t, s, conflict)
	next[0].Result = naturalResult(conflict.UserText, "response-language", false, 1)
	next[0].Result.Scope = "user"
	next[0].Result.Relation = "conflict"
	if _, e := consolidationCommit(t, s, next); e != nil {
		t.Fatal(e)
	}
	page, _ := s.NaturalConflicts(StrategyContext{}, "", 20)
	if len(objects(page["items"])) != 1 {
		t.Fatal(page)
	}
	raw = jsonText(page)
	for _, private := range []string{ctx.ProjectID, session, conflict.SourceMessageID, memoryHash(conflict.UserText)} {
		if strings.Contains(raw, private) {
			t.Fatal("global conflict identity leaked")
		}
	}
}
func TestNaturalConsolidationDeferredBudgetWakesWithoutCoveringSource(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap := consolidationSource(t, s, ctx, session, "以后本项目固定中文。", false)
	job := s.ClaimMemoryJob()
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobs SET status='budget_wait',leaseToken='',nextAttemptAtMs=? WHERE jobId=?", time.Now().Add(time.Hour).UnixMilli(), job["jobId"])
		s.exec("UPDATE naturalMemoryCoverage SET stage='deferred',reason='daily_dispatch_limit' WHERE sourceKey=?", naturalCoverageKey(snap))
		return nil
	})
	if s.ClaimMemoryJob() != nil {
		t.Fatal("budget wake was early")
	}
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobs SET nextAttemptAtMs=0 WHERE jobId=?", job["jobId"])
		return nil
	})
	next := s.ClaimMemoryJob()
	if next == nil || next["jobId"] != job["jobId"] {
		t.Fatal("deferred source lost")
	}
	status, _ := s.NaturalConsolidationStatus(ctx)
	if integer(status["deferred"]) != 1 || integer(status["processed"]) != 0 {
		t.Fatal("wake invented processing", status)
	}
}
func TestNaturalConsolidationScopeCancellationUsesCapturedConsent(t *testing.T) {
	for _, c := range []struct {
		name            string
		global, project bool
		off             StrategyContext
		cancel          bool
	}{
		{"unrelated global", false, true, StrategyContext{}, false},
		{"captured global", true, false, StrategyContext{}, true},
		{"unrelated project", false, true, StrategyContext{ProjectID: "other"}, false},
		{"captured project", false, true, StrategyContext{ProjectID: "project"}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			b, h := fixture(t)
			_ = h
			called := false
			b.memoryCancel = func() { called = true }
			b.memoryBatchJobs = []naturalBatchItem{{Snapshot: ai.MemoryTurnSnapshot{ProjectID: "project", Natural: &ai.NaturalMemoryConsent{GlobalEnabled: c.global, ProjectEnabled: c.project}}}}
			b.messageMu.Lock()
			b.pauseNaturalScope(c.off)
			b.messageMu.Unlock()
			if called != c.cancel {
				t.Fatal("scope cancellation mismatch", called)
			}
		})
	}
}
