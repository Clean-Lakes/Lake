package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func naturalSource(t *testing.T, s *Store, ctx StrategyContext, session, text string) (ai.MemoryTurnSnapshot, Object) {
	t.Helper()
	m := s.AddMessage(session, "user", text, nil)
	snap := testMemorySnapshot(ctx.ProjectID, session, ident(), integer(s.MemorySettings(ctx.ProjectID)["epoch"]), integer(s.MemorySettings(ctx.ProjectID)["revision"]))
	snap.SourceMessageID = stringOf(m["id"])
	snap.UserText = text
	snap.Natural = s.NaturalConsent(ctx.ProjectID)
	snap = ai.SealMemorySnapshot(snap)
	if e := s.EnqueueMemoryTurn(snap); e != nil {
		t.Fatal(e)
	}
	job := s.ClaimMemoryJob()
	if job == nil {
		t.Fatal("no job")
	}
	return snap, job
}
func naturalResult(text, topic string, replace bool, revision int) NaturalPreferenceResult {
	return NaturalPreferenceResult{SchemaVersion: 1, Decision: "save", Scope: "project", Quote: text, Topic: topic, Replacement: replace, ExpectedRevision: revision}
}
func naturalNewFixture(t *testing.T) (*Store, StrategyContext, string) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	if _, e := b.Store.SetNaturalMemorySettings(ctx, "new-opt-in", 0, true); e != nil {
		t.Fatal(e)
	}
	return b.Store, ctx, session
}
func TestNaturalPreferenceSaveReplaceUndoAndNoRuntimeBinding(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	first := "以后这个项目的报告固定用中文。"
	snap, job := naturalSource(t, s, ctx, session, first)
	if changed, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(first, "report-language", false, 0)); e != nil || !changed {
		t.Fatal(changed, e)
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	entry := objects(page["items"])[0]
	id := stringOf(entry["id"])
	if entry["body"] != first || entry["state"] != "active" {
		t.Fatal(entry)
	}
	second := "更正本项目长期偏好：以后报告固定用英文。"
	snap, job = naturalSource(t, s, ctx, session, second)
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(second, "report-language", true, 1)); e != nil {
		t.Fatal(e)
	}
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	var change Object
	for _, c := range objects(changes["items"]) {
		if c["kind"] == "replace" {
			change = c
		}
	}
	if _, e := s.UndoNaturalPreference(ctx, stringOf(change["id"]), "undo", 2); e != nil {
		t.Fatal(e)
	}
	restored, _ := s.ReadNaturalFormedPreference(ctx, id, 0)
	if restored["body"] != first || integer(restored["revision"]) != 3 {
		t.Fatal(restored)
	}
	if _, e := s.UndoNaturalPreference(ctx, stringOf(change["id"]), "stale", 2); e == nil {
		t.Fatal("stale undo accepted")
	}
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(second, "report-language", true, 1)); e == nil {
		t.Fatal("settled job replay accepted")
	}
	s.read(func() any {
		if integer(s.row("SELECT count(*) n FROM strategyBindings")["n"]) != 0 {
			t.Fatal("natural preference changed legacy runtime")
		}
		return nil
	})
}
func TestNaturalPreferenceUndoBlocksSameSourceAndForgetErasesHistory(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	text := "这个项目以后固定先列证据。"
	snap, job := naturalSource(t, s, ctx, session, text)
	_, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(text, "evidence-order", false, 0))
	if e != nil {
		t.Fatal(e)
	}
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	c := objects(changes["items"])[0]
	_, e = s.UndoNaturalPreference(ctx, stringOf(c["id"]), "undo", 1)
	if e != nil {
		t.Fatal(e)
	}
	s.read(func() any {
		if s.naturalSnapshotValid(snap) {
			t.Fatal("undo source eligible again")
		}
		return nil
	})
	// A new real instruction may form another topic; forgetting removes all its bodies.
	snap, job = naturalSource(t, s, ctx, session, "以后本项目的回复固定使用简短列表。")
	_, e = s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "response-format", false, 0))
	if e != nil {
		t.Fatal(e)
	}
	list, _ := s.NaturalFormedPreferences(ctx, "", 20)
	for _, entry := range objects(list["items"]) {
		if entry["topic"] == "response-format" {
			id := stringOf(entry["id"])
			_, e = s.ForgetNaturalPreference(ctx, id, "forget", 1)
			if e != nil {
				t.Fatal(e)
			}
			v, e := s.ReadNaturalFormedPreference(ctx, id, 0)
			if e != nil || v["body"] != "" || v["state"] != "forgotten" {
				t.Fatal(v, e)
			}
			s.read(func() any {
				if integer(s.row("SELECT count(*) n FROM naturalPreferenceContent WHERE entryId=?", id)["n"]) != 0 {
					t.Fatal("forgotten history retained")
				}
				return nil
			})
		}
	}
}
func TestNaturalPreferenceConsentSourceEpochAndIsolation(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap, job := naturalSource(t, s, ctx, session, "以后这个项目的报告先给结论。")
	_, e := s.SetNaturalMemorySettings(ctx, "off", 1, false)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e == nil {
		t.Fatal("late result survived off")
	}
	_, _ = s.SetNaturalMemorySettings(ctx, "on-again", 2, true)
	if _, e = s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e == nil {
		t.Fatal("old epoch revived")
	}
	s.SettleMemoryJob(stringOf(job["jobId"]), stringOf(job["leaseToken"]), "skipped", "invalid", ai.Usage{})
	snap, job = naturalSource(t, s, ctx, session, "以后这个项目的报告先给证据。")
	fake := snap
	fake.UserText = "所有项目以后都用英文。"
	fake = ai.SealMemorySnapshot(fake)
	if _, e = s.CommitMemoryExtraction(job, fake, nil, ai.Usage{}, naturalResult(fake.UserText, "report-order", false, 0)); e == nil {
		t.Fatal("fake source accepted")
	}
	_, e = s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0))
	if e != nil {
		t.Fatal(e)
	}
	page, _ := s.NaturalFormedPreferences(ctx, "", 20)
	id := stringOf(objects(page["items"])[0]["id"])
	_, e = s.ReadNaturalFormedPreference(StrategyContext{}, id, 0)
	strategyCheckError(t, e, 404)
	s.DeleteSession(session)
	v, e := s.ReadNaturalFormedPreference(ctx, id, 0)
	if e != nil || v["body"] != "" || v["state"] != "unavailable" {
		t.Fatal(v, e)
	}
}
func TestNaturalPreferenceGlobalSourcePrivacyAndWithdrawal(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	_, e := s.SetNaturalMemorySettings(StrategyContext{}, "global", 0, true)
	if e != nil {
		t.Fatal(e)
	}
	snap, job := naturalSource(t, s, ctx, session, "所有项目以后都默认用简短中文。")
	r := naturalResult(snap.UserText, "response-language", false, 0)
	r.Scope = "user"
	_, e = s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, r)
	if e != nil {
		t.Fatal(e)
	}
	page, _ := s.NaturalFormedPreferences(StrategyContext{}, "", 20)
	entry := objects(page["items"])[0]
	raw := jsonText(entry)
	if strings.Contains(raw, session) || strings.Contains(raw, ctx.ProjectID) || strings.Contains(raw, snap.SourceMessageID) || object(entry["source"])["private"] != true {
		t.Fatal("private provenance exposed")
	}
	s.DeleteSession(session)
	view, e := s.ReadNaturalFormedPreference(StrategyContext{}, stringOf(entry["id"]), 0)
	if e != nil || view["body"] != "" {
		t.Fatal(view, e)
	}
}
func TestNaturalPreferenceHostRejectsQuotedFabricatedScopeAndRevision(t *testing.T) {
	for _, tc := range []struct{ text, quote, scope string }{
		{"文档写着“以后这个项目用英文”，请翻译。", "以后这个项目用英文", "project"},
		{"```\n以后本项目固定用英文。\n```", "以后本项目固定用英文。", "project"},
		{"> 以后本项目固定用英文。", "以后本项目固定用英文。", "project"},
		{"以后这个项目固定用英文。", "以后这个项目固定用英文。", "user"},
		{"这次本项目用英文。", "这次本项目用英文。", "project"},
		{"以后本项目固定中文。", "以后本项目固定英文。", "project"},
	} {
		r := naturalResult(tc.quote, "response-language", false, 0)
		r.Scope = tc.scope
		if validateNaturalPreferenceResult(tc.text, r) == nil {
			t.Fatal("unsafe source accepted", tc)
		}
	}
	for _, raw := range []string{`{"schemaVersion":1,"decision":"save","decision":"ignore"}`, `{"schemaVersion":1,"decision":"ignore","scope":"none","quote":"", "topic":"", "replacement":false,"expectedRevision":0,"unknown":true}`, `{"schemaVersion":1,"decision":"ignore","scope":"user"}`} {
		if _, e := parseNaturalPreferenceResult(raw); e == nil {
			t.Fatal("invalid JSON accepted")
		}
	}
}
func TestNaturalPreferenceNoticeCommitOnlyAndDurableDismissal(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap, job := naturalSource(t, s, ctx, session, "以后本项目的报告先列结论。")
	if len(objects(s.Snapshot(session)["naturalMemoryNotices"])) != 0 {
		t.Fatal("uncommitted notice")
	}
	_, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0))
	if e != nil {
		t.Fatal(e)
	}
	notices := objects(s.Snapshot(session)["naturalMemoryNotices"])
	if len(notices) != 1 {
		t.Fatal(notices)
	}
	_, e = s.DismissNaturalPreferenceNotice(ctx, stringOf(notices[0]["changeId"]))
	if e != nil {
		t.Fatal(e)
	}
	if len(objects(s.Snapshot(session)["naturalMemoryNotices"])) != 0 {
		t.Fatal("dismissal ignored")
	}
}
func TestNaturalPreferenceMigrationReopenBackupAndFutureGuard(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.CreateProject("synthetic")
	s.exec("DROP TABLE naturalPreferenceMeta")
	for _, name := range []string{"naturalPreferenceNoticeAcks", "naturalPreferenceConsent", "naturalPreferenceDispatches", "naturalPreferenceSuppressions", "naturalPreferenceChanges", "naturalPreferenceContent", "naturalPreferenceRevisions", "naturalPreferenceEntries"} {
		s.exec("DROP TABLE " + name)
	}
	s.Close()
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
	files, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-natural-preference-v1-*.sqlite"))
	if len(files) != 1 {
		t.Fatal(files)
	}
	info, _ := os.Stat(files[0])
	if info.Mode().Perm() != 0600 {
		t.Fatal("backup mode")
	}
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	s.exec("UPDATE naturalPreferenceMeta SET schemaHash='future'")
	s.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("unknown schema accepted")
	}
}
func TestNaturalPreferenceRealTurnOutboxSharedWorkerAndIgnore(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	_, e := b.Store.SetNaturalMemorySettings(ctx, "enable", 0, true)
	if e != nil {
		t.Fatal(e)
	}
	b.Store.SetMemorySettings(ctx.ProjectID, false, false, 0)
	text := "以后这个项目的答复固定先列证据。"
	var mu sync.Mutex
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["tools"] == nil && strings.Contains(jsonText(req["messages"]), "Identify at most ONE") {
			mu.Lock()
			calls++
			mu.Unlock()
			emitModel(w, jsonText(naturalResult(text, "report-order", false, 0)), nil)
		} else {
			emitModel(w, "已完成这次答复。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "natural fixture", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": text}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	list, _ := b.Store.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(list["items"])) != 0 {
		t.Fatal("foreground performed extraction")
	}
	b.messageMu.Lock()
	b.memoryLastForeground = time.Time{}
	b.messageMu.Unlock()
	b.processOneMemoryJob()
	list, _ = b.Store.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(list["items"])) != 1 {
		t.Fatal("shared worker did not save", list)
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "以后本项目固定中文。", "ignoreProjectMemory": true}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	b.processOneMemoryJob()
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatal("ignore triggered auxiliary call", calls)
	}
}

func TestNaturalPreferenceSharedCommitRollsBackBothOutputs(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap, job := naturalSource(t, s, ctx, session, "以后这个项目的报告先给结论。")
	// Re-seal the actual durable job with legacy extraction explicitly included.
	snap.LegacyExtraction = true
	snap = ai.SealMemorySnapshot(snap)
	s.update(func() any {
		s.exec("UPDATE projectMemoryTurns SET snapshotJSON=?,snapshotHash=? WHERE sequence=?", jsonText(snap), snap.SnapshotHash, job["turnSequence"])
		return nil
	})
	invalid := MemoryExtractMutation{Operation: "upsert", Key: "project-standard", Type: "project", Description: "fixture", Body: "fixture", SourceIDs: []string{"evidence:missing"}, Verification: "observed"}
	if _, e := s.CommitMemoryExtraction(job, snap, []MemoryExtractMutation{invalid}, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e == nil {
		t.Fatal("invalid legacy result accepted")
	}
	list, _ := s.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(list["items"])) != 0 || len(objects(s.Snapshot(session)["naturalMemoryNotices"])) != 0 {
		t.Fatal("partial preference transaction escaped")
	}
	if _, e := s.CommitMemoryExtraction(job, snap, []MemoryExtractMutation{}, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e != nil {
		t.Fatal(e)
	}
}
func TestNaturalPreferenceOldHistoryLeaseExpiryAndNewInstructionAfterUndo(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	// A source predating explicit opt-in cannot be authorized by a current epoch.
	old := s.AddMessage(session, "user", "以后这个项目先给结论。", nil)
	_, _ = s.SetNaturalMemorySettings(ctx, "consent-refresh", 1, true)
	snap := testMemorySnapshot(ctx.ProjectID, session, ident(), 0, 0)
	snap.UserText = stringOf(old["text"])
	snap.SourceMessageID = stringOf(old["id"])
	snap.Natural = s.NaturalConsent(ctx.ProjectID)
	snap = ai.SealMemorySnapshot(snap)
	s.read(func() any {
		if s.naturalSnapshotValid(snap) {
			t.Fatal("pre-consent message accepted")
		}
		return nil
	})
	snap, job := naturalSource(t, s, ctx, session, "以后这个项目先给结论。")
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobs SET leaseUntilMs=0 WHERE jobId=?", job["jobId"])
		return nil
	})
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e == nil {
		t.Fatal("expired lease accepted")
	}
	s.SettleMemoryJob(stringOf(job["jobId"]), stringOf(job["leaseToken"]), "skipped", "expired", ai.Usage{})
	snap, job = naturalSource(t, s, ctx, session, "以后本项目先列证据。")
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e != nil {
		t.Fatal(e)
	}
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	c := objects(changes["items"])[0]
	if _, e := s.UndoNaturalPreference(ctx, stringOf(c["id"]), "undo", 1); e != nil {
		t.Fatal(e)
	}
	snap, job = naturalSource(t, s, ctx, session, "以后本项目固定先列摘要。")
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); e != nil {
		t.Fatal("new real instruction cannot form preference", e)
	}
	list, _ := s.NaturalFormedPreferences(ctx, "", 20)
	v := objects(list["items"])[0]
	if integer(v["revision"]) != 3 || v["body"] != snap.UserText {
		t.Fatal(v)
	}
}
func TestNaturalPreferenceScopeGateIdempotencyAndLaterEditCAS(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap, job := naturalSource(t, s, ctx, session, "所有项目以后固定用中文。")
	global := naturalResult(snap.UserText, "response-language", false, 0)
	global.Scope = "user"
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, global); e == nil {
		t.Fatal("project consent allowed global write")
	}
	s.SettleMemoryJob(stringOf(job["jobId"]), stringOf(job["leaseToken"]), "skipped", "wrong_scope", ai.Usage{})
	snap, job = naturalSource(t, s, ctx, session, "以后本项目报告固定中文。")
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-language", false, 0)); e != nil {
		t.Fatal(e)
	}
	changes, _ := s.NaturalPreferenceChanges(ctx, "", 20)
	first := objects(changes["items"])[0]
	snap, job = naturalSource(t, s, ctx, session, "更正本项目长期偏好：以后固定英文。")
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-language", true, 1)); e != nil {
		t.Fatal(e)
	}
	if _, e := s.UndoNaturalPreference(ctx, stringOf(first["id"]), "old-undo", 1); e == nil {
		t.Fatal("undo overwrote newer edit")
	}
	if _, e := s.SetNaturalMemorySettings(ctx, "same-key", 1, false); e != nil {
		t.Fatal(e)
	}
	if _, e := s.SetNaturalMemorySettings(ctx, "same-key", 1, true); e == nil {
		t.Fatal("idempotency collision accepted")
	}
}
func TestNaturalPreferenceForegroundPreemptionAndFiniteDispatches(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	_, _ = b.Store.SetNaturalMemorySettings(ctx, "on", 0, true)
	b.Store.SetMemorySettings(ctx.ProjectID, false, false, 0)
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		emitModel(w, jsonText(naturalResult("以后本项目固定用中文。", "response-language", false, 0)), nil)
	}))
	defer provider.Close()
	model := &ai.Model{URL: provider.URL, Name: "preemption", Protocol: "openai", ContextWindow: 64000, MaxOutput: 1024}
	b.Models.Save(model)
	snap, job := naturalSource(t, b.Store, ctx, session, "以后本项目固定用中文。")
	snap.ModelRef = ai.ModelIdentity(*b.Models.Active())
	snap = ai.SealMemorySnapshot(snap)
	b.Store.update(func() any {
		b.Store.exec("UPDATE projectMemoryTurns SET snapshotJSON=?,snapshotHash=? WHERE sequence=?", jsonText(snap), snap.SnapshotHash, job["turnSequence"])
		return nil
	})
	job["snapshotJSON"] = jsonText(snap)
	go func() { defer close(done); b.messageMu.Lock(); b.processNaturalPreferenceJob(job, snap) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("no extraction dispatch", b.Store.read(func() any {
			return b.Store.row("SELECT status,lastErrorCode FROM projectMemoryJobs WHERE jobId=?", job["jobId"])
		}))
	}
	b.messageMu.Lock()
	b.PauseMemoryExtractionForForeground()
	b.runningMessages = map[string]bool{session: true}
	b.messageMu.Unlock()
	close(release)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("foreground waited for auxiliary request")
	}
	page, _ := b.Store.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(page["items"])) != 0 {
		t.Fatal("late result committed")
	}
	b.messageMu.Lock()
	delete(b.runningMessages, session)
	b.messageMu.Unlock()
	// A provider attempt cancelled without a response still consumes the reservation.
	b.Store.read(func() any {
		if integer(b.Store.row("SELECT count(*) n FROM naturalPreferenceDispatches")["n"]) != 1 {
			t.Fatal("dispatch accounting lost")
		}
		return nil
	})
	b.Store.update(func() any {
		for i := 0; i < 19; i++ {
			b.Store.exec("INSERT INTO naturalPreferenceDispatches(id,jobId,projectId,startedAt,status) VALUES(?,?,?,?,'interrupted')", ident(), job["jobId"], ctx.ProjectID, now())
		}
		return nil
	})
	reclaimed := b.Store.ClaimMemoryJob()
	if reclaimed == nil {
		t.Fatal("preempted job missing")
	}
	b.messageMu.Lock()
	b.processNaturalPreferenceJob(reclaimed, snap)
	b.Store.read(func() any {
		row := b.Store.row("SELECT status,lastErrorCode FROM projectMemoryJobs WHERE jobId=?", job["jobId"])
		if row["status"] != "blocked" || row["lastErrorCode"] != "natural_daily_dispatch_limit" {
			t.Fatal(row)
		}
		return nil
	})
}
func TestNaturalPreferenceHTTPVersionsChangesStrictBodies(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	_, _ = b.Store.SetNaturalMemorySettings(ctx, "on", 0, true)
	snap, job := naturalSource(t, b.Store, ctx, session, "以后本项目固定用中文。")
	_, e := b.Store.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "response-language", false, 0))
	if e != nil {
		t.Fatal(e)
	}
	base := "/api/projects/" + ctx.ProjectID + "/natural-memory"
	list := strategyHTTP(t, h, "GET", base+"/formed-preferences", "", "", 200)
	entry := objects(list["items"])[0]
	id := stringOf(entry["id"])
	strategyHTTP(t, h, "GET", base+"/formed-preferences/"+id+"/revisions/1", "", "", 200)
	strategyHTTP(t, h, "GET", "/api/natural-memory/formed-preferences/"+id, "", "", 404)
	changes := strategyHTTP(t, h, "GET", base+"/formed-changes", "", "", 200)
	c := objects(changes["items"])[0]
	cid := stringOf(c["id"])
	detail := strategyHTTP(t, h, "GET", base+"/formed-changes/"+cid, "", "", 200)
	if object(detail["after"])["body"] != snap.UserText {
		t.Fatal(detail)
	}
	strategyHTTP(t, h, "POST", base+"/formed-changes/"+cid+"/undo", "bad", `{"expectedRevision":1,"projectId":"other"}`, 400)
	strategyHTTP(t, h, "POST", base+"/formed-changes/"+cid+"/dismiss", "dismiss", `{}`, 200)
	strategyHTTP(t, h, "POST", base+"/formed-changes/"+cid+"/undo", "undo", `{"expectedRevision":1}`, 200)
	strategyHTTP(t, h, "POST", base+"/formed-preferences/"+id+"/forget", "forget", `{"expectedRevision":2}`, 200)
}
func TestNaturalPreferenceCombinedCompletionPreservesLegacyKnowledge(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	_, _ = b.Store.SetNaturalMemorySettings(ctx, "on", 0, true)
	text := "以后这个项目固定用中文。这个项目代号为示例演示。"
	quote := "以后这个项目固定用中文。"
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["tools"] == nil {
			calls++
			emitModel(w, jsonText(Object{"preference": naturalResult(quote, "response-language", false, 0), "legacy": Object{"schemaVersion": 1, "mutations": []MemoryExtractMutation{{Operation: "upsert", Key: "project-codename", Type: "project", Description: "项目代号", Body: "项目代号为示例演示。", SourceIDs: []string{"user:0"}, Verification: "user-stated"}}}}), nil)
		} else {
			emitModel(w, "已收到。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "combined", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": text}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	b.messageMu.Lock()
	b.memoryLastForeground = time.Time{}
	b.messageMu.Unlock()
	b.processOneMemoryJob()
	list, _ := b.Store.NaturalFormedPreferences(ctx, "", 20)
	if len(objects(list["items"])) != 1 || objects(list["items"])[0]["body"] != quote || b.Store.ReadProjectMemory(ctx.ProjectID, "project-codename", false)["body"] != "项目代号为示例演示。" || calls != 1 {
		t.Fatal("combined result lost or extra dispatch", list, calls)
	}
}
func TestNaturalPreferenceArchivedSourceIsRejected(t *testing.T) {
	s, ctx, session := naturalNewFixture(t)
	snap, job := naturalSource(t, s, ctx, session, "以后本项目固定用中文。")
	s.update(func() any {
		s.exec("INSERT INTO navigationTrash(kind,id,projectId,name,payload,deletedAt) VALUES('project',?,?,?,'{}',?)", ctx.ProjectID, ctx.ProjectID, "fixture", now())
		return nil
	})
	if _, e := s.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "response-language", false, 0)); e == nil {
		t.Fatal("archived source accepted")
	}
}
func TestNaturalPreferenceMigrationDDLFailureLeavesNoMarker(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	p := s.CreateProject("synthetic")
	s.exec("DROP TABLE naturalPreferenceNoticeAcks;DROP TABLE naturalPreferenceConsent;DROP TABLE naturalPreferenceDispatches;DROP TABLE naturalPreferenceSuppressions;DROP TABLE naturalPreferenceChanges;DROP TABLE naturalPreferenceContent;DROP TABLE naturalPreferenceRevisions;DROP TABLE naturalPreferenceEntries;DROP TABLE naturalPreferenceMeta;CREATE TABLE naturalPreferenceEntries(collision INTEGER)")
	s.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("collision accepted")
	}
	db, e := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var count int
	if e = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='naturalPreferenceMeta'").Scan(&count); e != nil || count != 0 {
		t.Fatal("partial marker", e, count)
	}
	if e = db.QueryRow("SELECT count(*) FROM projects WHERE id=?", p["id"]).Scan(&count); e != nil || count != 1 {
		t.Fatal("old data lost")
	}
}
