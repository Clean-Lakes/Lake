package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Imported pre-C1 records, not a feature flag or an executable test bypass.
func seedLegacyJob(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope, kind, asset string, sources []string) StrategyMutationResult {
	t.Helper()
	id := ident()
	s.update(func() any {
		key := s.strategyEnsureScope(ctx, scope)
		_, hash := s.strategySourceSet(ctx, sources)
		effective := s.strategyEffective(ctx)
		var assetID any
		if asset != "" {
			assetID = asset
		}
		s.exec("INSERT INTO strategyJobs(id,scopeKey,accessProjectId,kind,assetId,expectedRevision,status,globalEpoch,projectEpoch,sourceSetHash,runtimeId,dispatchState,expiresAtMs,createdAt,updatedAt) VALUES(?,?,?,?,?,0,'queued',?,?,?,?, 'none',9999999999999,?,?)", id, key, ctx.ProjectID, kind, assetID, effective.GlobalEpoch, effective.ProjectEpoch, hash, "legacy-runtime-"+id, now(), now())
		for _, source := range sources {
			s.exec("INSERT INTO strategyJobSources VALUES(?,?)", id, source)
		}
		return nil
	})
	return StrategyMutationResult{JobID: id}
}

func seedLegacyCandidate(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope, source string) StrategyMutationResult {
	t.Helper()
	job := seedLegacyJob(t, s, ctx, scope, "proposal", "", []string{source})
	id := ident()
	s.update(func() any {
		key := s.strategyEnsureScope(ctx, scope)
		input := StrategyAssetInput{Title: "PRIVATE_PROJECT_ONLY_TITLE", Kind: strategy.UserPreference, Body: "PRIVATE_PROJECT_ONLY_BODY", Applicability: strategy.Applicability{Profiles: []string{"core"}}}
		s.exec("INSERT INTO strategyAssets(id,scopeKey,kind,title,revision,createdAt) VALUES(?,?,?,?,1,?)", id, key, input.Kind, input.Title, now())
		s.strategyWriteRevision(ctx, s.strategyAsset(ctx, id, false), 1, 0, input, []string{source}, strategy.SingleObservation, "job:"+job.JobID)
		s.exec("UPDATE strategyJobs SET status='succeeded',dispatchState='complete' WHERE id=?", job.JobID)
		return nil
	})
	return StrategyMutationResult{AssetID: id, Revision: 1, JobID: job.JobID}
}

func TestStrategyRetiredRoutesRejectBeforeReceiptsAndPreserveManualAssets(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
	enableStrategyFixture(t, b.Store)
	asset := createStrategyFixture(t, b.Store, ctx, scope, "manual", "Manual retained content")
	base := "/api/projects/" + ctx.ProjectID + "/strategy"
	for _, suffix := range []string{"/sources", "/proposals", "/experiments", "/experiments/old/resume", "/experiments/old/save-candidate"} {
		b.Store.update(func() any {
			b.Store.exec("INSERT INTO strategyReceipts VALUES(?,?,?,'{\"jobId\":\"old\"}')", "project:"+ctx.ProjectID, "old-success-"+suffix, "old")
			return nil
		})
		got := strategyHTTP(t, h, "POST", base+suffix, "old-success-"+suffix, `{}`, 410)
		if got["code"] != "strategy_execution_retired" {
			t.Fatal(got)
		}
	}
	strategyHTTP(t, h, "POST", "/api/projects/missing/strategy/proposals", "foreign", `{}`, 404)
	settings := strategyHTTP(t, h, "GET", "/api/strategy/settings", "", "", 200)
	if object(settings["capabilities"])["learn"] != false || object(settings["capabilities"])["onlineCorrect"] != false {
		t.Fatal(settings)
	}
	body := Object{"expectedRevision": 1, "masterEnabled": true, "applyEnabled": true, "learnEnabled": true, "correctEnabled": true, "onlineCorrectEnabled": true, "onlineConsentVersion": 2, "budget": strategy.DefaultBudget()}
	strategyHTTP(t, h, "PATCH", "/api/strategy/settings", "old-enable", jsonText(body), 410)
	strategyHTTP(t, h, "GET", base+"/assets/"+asset.AssetID+"/revisions/1", "", "", 200)
	strategyHTTP(t, h, "GET", base+"/sources", "", "", 200)
	strategyHTTP(t, h, "GET", base+"/proposals", "", "", 200)
	strategyHTTP(t, h, "GET", base+"/experiments", "", "", 200)
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyJobs")["n"]) != 0 {
		t.Fatal("retired request created work")
	}
}

func TestStrategyRetirementMigrationPreservesChoicesUnknownAndTerminalRecords(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	ctx := StrategyContext{ProjectID: stringOf(s.CreateProject("legacy")["id"])}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
	enableStrategyFixture(t, s)
	asset := createStrategyFixture(t, s, ctx, scope, "asset", "Keep exact adopted version")
	v, _ := s.GetStrategyRevision(ctx, asset.AssetID, 1)
	if _, e = s.BindStrategyAsset(ctx, scope, "adopt", StrategyBindingInput{Action: "adopt", Ref: v.Value.Ref}); e != nil {
		t.Fatal(e)
	}
	jobs := map[string]string{}
	for _, state := range []string{"none", "intent", "started", "complete"} {
		j := seedLegacyJob(t, s, ctx, scope, "proposal", "", []string{asset.SourceID})
		jobs[state] = j.JobID
		s.update(func() any {
			status := "leased"
			if state == "complete" {
				status = "succeeded"
			}
			s.exec("UPDATE strategyJobs SET status=?,dispatchState=?,leaseToken='old-lease',leaseUntilMs=9999999999999 WHERE id=?", status, state, j.JobID)
			if state == "started" {
				s.exec("INSERT INTO strategyProposalRuns(jobId,runtimeId,status,requestHash,leaseHash,usageJSON,startedAt) VALUES(?,?,'running','request-fingerprint','lease-fingerprint','{\"tokensCharged\":9876}',?)", j.JobID, "legacy-runtime-"+j.JobID, now())
			}
			return nil
		})
	}
	experiment := seedLegacyJob(t, s, ctx, scope, "experiment", asset.AssetID, []string{asset.SourceID})
	s.update(func() any {
		s.exec("INSERT INTO strategyExperiments(jobId,frozenJSON,frozenHash,modelRef,requests,tokensCharged,createdAt) VALUES(?,'{}','frozen','old-model',2,8192,?)", experiment.JobID, now())
		for ordinal, state := range []string{"planned", "running", "completed"} {
			s.exec("INSERT INTO strategyExperimentRuns(id,experimentId,ordinal,caseId,arm,repetition,status,runtimeId,reportJSON) VALUES(?,?,?,'SL-001','baseline',1,?,'old-runtime','{\"tokensCharged\":4096}')", ident(), experiment.JobID, ordinal+1, state)
		}
		return nil
	})
	s.update(func() any {
		old := s.strategySettings(strategy.Scope{Kind: strategy.UserScope})
		old.LearnEnabled, old.CorrectEnabled, old.OnlineCorrectEnabled = true, true, true
		old.OnlineConsentVersion = 2
		old.ExecutionRetirementVersion = 0
		s.strategySaveSettings("user", old)
		return nil
	})
	s.Close()
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	settings, _ := s.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
	if settings.LearnEnabled || settings.CorrectEnabled || settings.OnlineCorrectEnabled || !settings.MasterEnabled || !settings.ApplyEnabled || settings.RetiredExecutionChoices == nil || !settings.RetiredExecutionChoices.LearnEnabled {
		t.Fatal(settings)
	}
	for state, id := range jobs {
		j := s.row("SELECT * FROM strategyJobs WHERE id=?", id)
		want := "awaiting_reconciliation"
		if state == "none" {
			want = "cancelled"
		}
		if state == "complete" {
			want = "succeeded"
		}
		if j["status"] != want || j["runtimeId"] != "legacy-runtime-"+id {
			t.Fatal(state, j)
		}
		if state == "intent" || state == "started" {
			if j["dispatchState"] != "unknown" || j["leaseToken"] != "" {
				t.Fatal(j)
			}
		}
	}
	run := s.row("SELECT * FROM strategyProposalRuns WHERE jobId=?", jobs["started"])
	if run["status"] != "unknown" || run["requestHash"] != "request-fingerprint" || run["usageJSON"] != `{"tokensCharged":9876}` {
		t.Fatal(run)
	}
	exp := s.row("SELECT * FROM strategyExperiments WHERE jobId=?", experiment.JobID)
	if integer(exp["requests"]) != 2 || integer(exp["tokensCharged"]) != 8192 {
		t.Fatal("experiment reservations changed", exp)
	}
	for i, r := range s.rows("SELECT * FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", experiment.JobID) {
		if r["status"] != []string{"not_executed", "unknown", "completed"}[i] || r["runtimeId"] != "old-runtime" || r["reportJSON"] != `{"tokensCharged":4096}` {
			t.Fatal("experiment outcome or identity changed", r)
		}
	}
	if s.row("SELECT status FROM strategyJobs WHERE id=?", experiment.JobID)["status"] != "awaiting_reconciliation" {
		t.Fatal("unknown child result was discarded")
	}
	retained, _ := s.GetStrategyRevision(ctx, asset.AssetID, 1)
	binding, _ := s.GetStrategyBinding(ctx, scope, asset.AssetID)
	if retained.Value.Ref != v.Value.Ref || retained.Value.Body != v.Value.Body || !binding.Enabled {
		t.Fatal("manual content changed")
	}
	seq := integer(s.row("SELECT COUNT(*) AS n FROM strategyEvents")["n"])
	s.Close()
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	second, _ := s.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
	if jsonText(second) != jsonText(settings) || integer(s.row("SELECT COUNT(*) AS n FROM strategyEvents")["n"]) != seq {
		t.Fatal("retirement is not idempotent")
	}
	if claim, e := s.ClaimStrategyJob(ctx); e != nil || claim != nil {
		t.Fatal("retired work leased", claim, e)
	}
}

func TestStrategyRetiredSignalsAndWorkerTicksMakeNoAuxiliaryRequests(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	enableStrategyFixture(t, b.Store)
	project := stringOf(b.Store.Session(id)["projectId"])
	b.Store.SetMemorySettings(project, true, false, 0)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.Contains(jsonText(body), "revise_readonly_strategy") || strings.Contains(jsonText(body), "Extract at most one reusable") {
			t.Error("retired instruction reached provider")
		}
		emitModel(w, "本轮答复正常完成。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "retirement", Protocol: "openai", ContextWindow: 64000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "以后请先列证据。"}, 202)
	b.workers.Wait()
	b.processOneStrategyJob()
	b.processOneExperiment()
	view, _ := b.Engine.Snapshot(id)
	if view.Status != "completed" || requests.Load() != 1 || integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyJobs")["n"]) != 0 {
		t.Fatal(view.Status, requests.Load())
	}
}

func TestStrategyRetirementProcessRestartHelper(t *testing.T) {
	if os.Getenv("LAKE_C1_RESTART_HOME") == "" {
		return
	}
	s, e := OpenStore(os.Getenv("LAKE_C1_RESTART_HOME"))
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
}

func TestStrategyRetirementRepeatedProcessStartupNeverDispatches(t *testing.T) {
	dir := t.TempDir()
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	ctx := StrategyContext{ProjectID: stringOf(s.CreateProject("restart")["id"])}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
	a := createStrategyFixture(t, s, ctx, scope, "source", "Legacy source")
	j := seedLegacyJob(t, s, ctx, scope, "proposal", "", []string{a.SourceID})
	s.update(func() any {
		s.exec("UPDATE strategyJobs SET status='awaiting_reconciliation',dispatchState='intent' WHERE id=?", j.JobID)
		return nil
	})
	s.Close()
	for i := 0; i < 2; i++ {
		cmd := exec.Command(os.Args[0], "-test.run=^TestStrategyRetirementProcessRestartHelper$")
		cmd.Env = append(os.Environ(), "LAKE_C1_RESTART_HOME="+dir)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("restart failed: %v %s", e, out)
		}
	}
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	r := s.row("SELECT * FROM strategyJobs WHERE id=?", j.JobID)
	if r["dispatchState"] != "unknown" || r["status"] != "awaiting_reconciliation" || integer(r["attempts"]) != 0 {
		t.Fatal(r)
	}
}
