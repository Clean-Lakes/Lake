package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// Seed the on-disk v4-v6 format, not a production optimizer or permissive route.
// Retirement replaces the old execution tests with historical-read, withdrawal,
// lease/dispatch denial and real process-crash compatibility checks.
func seedLegacyOptimization(t *testing.T, s *Store, state string) (StrategyContext, string, string) {
	t.Helper()
	ctx := StrategyContext{ProjectID: stringOf(s.CreateProject("Legacy optimizer compatibility")["id"])}
	scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
	a := createStrategyFixture(t, s, ctx, scope, ident(), "Legacy private seed method")
	v, e := s.GetStrategyRevision(ctx, a.AssetID, 1)
	if e != nil {
		t.Fatal(e)
	}
	job := seedLegacyJob(t, s, ctx, scope, "experiment", a.AssetID, v.Value.SourceIDs)

	f := strategyExperimentFrozen{Optimization: true, Asset: v.Value, Cases: []strategy.Fixture{strategy.Fixtures()[0], strategy.Fixtures()[13]}, Repetitions: 1, Budget: strategy.DefaultBudget(), SkillHashes: map[string]string{}}
	_, e = strategyCall(s, true, func() bool {
		raw := jsonText(f)
		s.exec("INSERT INTO strategyExperiments(jobId,frozenJSON,frozenHash,modelRef,requests,tokensCharged,createdAt) VALUES(?,?,?,'legacy-model',2,4096,?)", job.JobID, raw, strategy.ContentHash(raw), now())
		reason := ""
		if state == "checkpoint" {
			reason = "awaiting_user"
		}
		s.exec("INSERT INTO strategyOptimizations(jobId,stage,stopReason,activeMs) VALUES(?,3,?,50)", job.JobID, reason)
		candidate := strategyOptimizationOutput{SchemaVersion: 1, Candidate: &strategyOptimizationCandidate{Body: "Legacy private candidate", SourceRunIDs: []string{"legacy-run"}}}
		first := "planned"
		result := ""
		if state != "queued" {
			first = "completed"
			result = jsonText(candidate)
		}
		s.exec("INSERT INTO strategyOptimizationCalls(id,experimentId,stage,status,requestHash,resultJSON,usageJSON,reservedTokens) VALUES(?,?,'propose',?,'frozen-request',?,'{\"input\":10,\"output\":5,\"inputKnown\":true,\"outputKnown\":true}',2048)", ident(), job.JobID, first, result)
		second := "planned"
		if state == "unknown" {
			second = "running"
		}
		s.exec("INSERT INTO strategyOptimizationCalls(id,experimentId,stage,status,requestHash,reservedTokens) VALUES(?,?,'synthesize',?,'inflight-request',2048)", ident(), job.JobID, second)
		run := ai.StrategyVariantResult{Status: "completed", RuntimeID: "legacy-runtime", Answer: "Legacy private answer", Evaluation: strategy.FixtureEvaluation{Status: "passed"}}
		s.exec("INSERT INTO strategyExperimentRuns(id,experimentId,ordinal,caseId,arm,repetition,status,runtimeId,reportJSON,variant) VALUES(?,?,1,'SL-001','baseline',1,'completed','legacy-runtime',?,'baseline_development')", ident(), job.JobID, jsonText(run))
		s.exec("INSERT INTO strategyExperimentRuns(id,experimentId,ordinal,caseId,arm,repetition,status,variant) VALUES(?,?,2,'SL-014','assets',1,'planned','synthesis_holdout')", ident(), job.JobID)
		if state == "checkpoint" {
			s.exec("UPDATE strategyJobs SET status='awaiting_reconciliation',dispatchState='complete' WHERE id=?", job.JobID)
		}
		if state == "unknown" {
			s.exec("UPDATE strategyJobs SET status='awaiting_reconciliation',dispatchState='intent',leaseToken='old-lease',leaseUntilMs=1 WHERE id=?", job.JobID)
		}
		if state == "settled" {
			s.exec("UPDATE strategyJobs SET status='succeeded',dispatchState='complete' WHERE id=?", job.JobID)
			s.exec("UPDATE strategyOptimizations SET stopReason='completed' WHERE jobId=?", job.JobID)
		}
		return true
	})
	if e != nil {
		t.Fatal(e)
	}
	return ctx, job.JobID, a.SourceID
}
func TestStrategyOptimizationRetiredHTTPAndNoProviderDispatch(t *testing.T) {
	b, h := fixture(t)
	enableStrategyFixture(t, b.Store)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); emitModel(w, "unexpected", nil) }))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "retirement-fixture", Protocol: "openai"})
	ctx, id, _ := seedLegacyOptimization(t, b.Store, "queued")
	base := "/api/projects/" + ctx.ProjectID + "/strategy"
	f := strategyHTTP(t, h, "GET", base+"/fixtures", "", "", 200)
	if object(f["boundedOptimization"])["supported"] != false {
		t.Fatal("retired actor advertised")
	}
	// Even legacy idempotency keys cannot revive an old creation receipt.
	for _, key := range []string{"new", "old"} {
		strategyHTTP(t, h, "POST", base+"/experiments", key, jsonText(Object{"ref": strategy.RevisionRef{}, "caseIds": []string{}, "repetitions": 1, "skillNames": []string{}, "optimization": true}), 410)
	}
	for _, action := range []string{"resume", "save-candidate"} {
		strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/"+action, ident(), `{}`, 410)
	}
	b.processOneExperiment()
	job, e := b.Store.ClaimStrategyJob(ctx)
	if e != nil || job != nil || calls.Load() != 0 {
		t.Fatal("retired job dispatched", e)
	}
	report := strategyHTTP(t, h, "GET", base+"/experiments/"+id+"/report", "", "", 200)
	if report["retired"] != true || report["canSave"] != false || report["canResume"] != false {
		t.Fatal("historical actions remained available")
	}
}
func TestStrategyOptimizationRetirementRecoveryPreservesUnknownAndCompletedIdentity(t *testing.T) {
	for _, state := range []string{"queued", "checkpoint", "unknown", "settled"} {
		t.Run(state, func(t *testing.T) {
			s, _, _ := strategyFixture(t)
			enableStrategyFixture(t, s)
			ctx, id, _ := seedLegacyOptimization(t, s, state)
			dir := s.Dir
			before, _ := strategyCall(s, false, func() string {
				return jsonText(s.row("SELECT frozenHash,requests,tokensCharged FROM strategyExperiments WHERE jobId=?", id)) + jsonText(s.rows("SELECT id,requestHash,reservedTokens,usageJSON FROM strategyOptimizationCalls WHERE experimentId=? ORDER BY stage", id)) + jsonText(s.row("SELECT id,runtimeId,reportJSON FROM strategyExperimentRuns WHERE experimentId=? AND ordinal=1", id))
			})
			s.Close()
			s, e := OpenStore(dir)
			if e != nil {
				t.Fatal(e)
			}
			defer s.Close()
			job, e := s.GetStrategyJob(ctx, id)
			if e != nil {
				t.Fatal(e)
			}
			expected := "cancelled"
			if state == "unknown" {
				expected = "awaiting_reconciliation"
			}
			if state == "settled" {
				expected = "succeeded"
			}
			if job["status"] != expected || state == "unknown" && job["dispatchState"] != "unknown" {
				t.Fatal("uncertainty/outcome changed", job["status"], job["dispatchState"])
			}
			after, _ := strategyCall(s, false, func() string {
				return jsonText(s.row("SELECT frozenHash,requests,tokensCharged FROM strategyExperiments WHERE jobId=?", id)) + jsonText(s.rows("SELECT id,requestHash,reservedTokens,usageJSON FROM strategyOptimizationCalls WHERE experimentId=? ORDER BY stage", id)) + jsonText(s.row("SELECT id,runtimeId,reportJSON FROM strategyExperimentRuns WHERE experimentId=? AND ordinal=1", id))
			})
			if before != after {
				t.Fatal("settled usage, artifact or identity changed")
			}
			if job, e := s.ClaimStrategyJob(ctx); e != nil || job != nil {
				t.Fatal("retired job reclaimed", e)
			}
			s.Close()
			s, e = OpenStore(dir)
			if e != nil {
				t.Fatal(e)
			}
			defer s.Close() // The final reopened handle must close before Windows TempDir cleanup.
			events, _ := strategyCall(s, false, func() int {
				return integer(s.row("SELECT count(*) AS n FROM strategyEvents WHERE aggregateId=? AND type='optimization_retired'", id)["n"])
			})
			if state != "settled" && events != 1 {
				t.Fatal("retirement not idempotent", events)
			}
		})
	}
}
func TestStrategyOptimizationMemoryForgetErasesCandidateCopies(t *testing.T) {
	b, h := fixture(t)
	enableStrategyFixture(t, b.Store)
	ctx, id, source := seedLegacyOptimization(t, b.Store, "checkpoint")
	base := "/api/projects/" + ctx.ProjectID + "/strategy"
	before := strategyHTTP(t, h, "GET", base+"/experiments/"+id+"/report", "", "", 200)
	if !strings.Contains(jsonText(before), "Legacy private candidate") {
		t.Fatal("historical candidate unreadable")
	}
	if _, e := b.Store.ForgetStrategySource(ctx, source, ident(), true); e != nil {
		t.Fatal(e)
	}
	after := strategyHTTP(t, h, "GET", base+"/experiments/"+id+"/report", "", "", 200)
	if after["contentAvailable"] != false || strings.Contains(jsonText(after), "Legacy private") {
		t.Fatal("withdrawal retained historical private text")
	}
	other := stringOf(b.Store.CreateProject("Other project")["id"])
	strategyHTTP(t, h, "GET", "/api/projects/"+other+"/strategy/experiments/"+id+"/report", "", "", 404)
}
func TestStrategyOptimizationCheckpointCrashHelper(t *testing.T) {
	dir := os.Getenv("LAKE_R5_CRASH_DIR")
	if dir == "" {
		return
	}
	s, e := OpenStore(dir)
	if e != nil {
		os.Exit(3)
	}
	enableStrategyFixture(t, s)
	seedLegacyOptimization(t, s, "unknown")
	os.Exit(0)
}
func TestStrategyOptimizationCrashIntentRemainsUnknownAndNeverReplayed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "store")
	cmd := exec.Command(os.Args[0], "-test.run=^TestStrategyOptimizationCheckpointCrashHelper$")
	cmd.Env = append(os.Environ(), "LAKE_R5_CRASH_DIR="+dir)
	if err := cmd.Run(); err != nil {
		t.Fatal("crash fixture failed")
	}
	s, e := OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	_, e = strategyCall(s, false, func() bool {
		job := s.row("SELECT * FROM strategyJobs WHERE kind='experiment'")
		if job["dispatchState"] != "unknown" || job["status"] != "awaiting_reconciliation" {
			t.Fatal("crashed intent lost uncertainty")
		}
		call := s.row("SELECT * FROM strategyOptimizationCalls WHERE stage='synthesize'")
		if call["status"] != "unknown" || call["requestHash"] != "inflight-request" || integer(call["reservedTokens"]) != 2048 {
			t.Fatal("crash changed dispatched reservation")
		}
		return true
	})
	if e != nil {
		t.Fatal(e)
	}
}

// Explicit local rollback acceptance fixture. Normal tests never write outside
// TempDir or start another binary. The caller opens this retired v6 Home with
// the prior signed Dev binary and checks identity/withdrawal before reopening it.
func TestR5PrepareCompatibilityFixture(t *testing.T) {
	home := os.Getenv("LAKE_R5_COMPAT_HOME")
	if home == "" {
		t.Skip("explicit isolated compatibility fixture only")
	}
	if !filepath.IsAbs(home) || filepath.Base(home) != "home" || !strings.HasPrefix(filepath.Base(filepath.Dir(home)), "lake-r5-compat-") {
		t.Fatal("private temporary compatibility Home required")
	}
	s, e := OpenStore(filepath.Join(home, "web-agent"))
	if e != nil {
		t.Fatal(e)
	}
	enableStrategyFixture(t, s)
	for _, state := range []string{"queued", "checkpoint", "unknown"} {
		seedLegacyOptimization(t, s, state)
	}
	ctx, _, source := seedLegacyOptimization(t, s, "settled")
	if _, e = s.ForgetStrategySource(ctx, source, ident(), true); e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = OpenStore(filepath.Join(home, "web-agent"))
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
}
