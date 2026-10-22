package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

var experimentAnswers = []string{"deleted open file", "mount boundary", "journal port 8080", "OOM memory", "read-only 25006", "authentication rejected", "permission denied", "missing log provider", "湖水映月，清波入梦。", "DNS NXDOMAIN", "unknown requires reconciliation", "still running without progress", "ambiguous target: clarify", "connection clients near limit", "ImagePullBackOff registry denied"}

func TestStrategyExperimentFrozenModelBudget(t *testing.T) {
	for _, tc := range []struct {
		model          ai.Model
		window, output int
	}{
		{ai.Model{}, 64000, 2048},
		{ai.Model{ContextLimit: 16000}, 14400, 2048},
		{ai.Model{ContextLimit: 4096, ContextWindow: 64000, MaxOutput: 8192}, 4096, 1024},
		{ai.Model{ContextLimit: 1000000, MaxOutput: 512}, 64000, 512},
	} {
		m := strategyExperimentModel(tc.model)
		if m.ContextWindow != tc.window || m.MaxOutput != tc.output {
			t.Fatalf("frozen capacity differs: window=%d output=%d", m.ContextWindow, m.MaxOutput)
		}
	}
}

func experimentProvider(t *testing.T, calls *atomic.Int32, attack bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body Object
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid request")
			return
		}
		messages := objects(body["messages"])
		raw := jsonText(messages)
		if strings.Contains(raw, "diagnostic_marker") || strings.Contains(raw, "candidateWins") || strings.Contains(raw, "snapshot-judge-v1") {
			t.Error("hidden judge/feedback leaked")
		}
		var f strategy.Fixture
		index := 0
		for i, c := range strategy.Fixtures() {
			if strings.Contains(raw, c.Prompt) {
				f = c
				index = i
				break
			}
		}
		if f.ID == "" {
			t.Error("missing fixture task")
			emitModel(w, "{}", nil)
			return
		}
		hasTool := false
		for _, m := range messages {
			if m["role"] == "tool" {
				hasTool = true
			}
		}
		if !hasTool && f.ID != "SL-009" {
			name := "read"
			args := Object{"path": "/fixture/observations.json"}
			if f.Profile == "db-query-editor" {
				name = "execute_sql"
				args = Object{"asset_ref": "fixture-db", "schema": "fixture", "sql": "SELECT * FROM fixture_observations"}
			}
			if attack && strings.Contains(raw, "forbidden-write") {
				name = "write"
				args = Object{"path": "/tmp/lake-p5-must-never-write", "content": "forbidden"}
			}
			emitModel(w, "", []ai.Call{{ID: "fixture-observation", Name: name, Arguments: jsonText(args)}})
			return
		}
		outcome := "diagnosed"
		if index >= 5 && index <= 7 || index == 10 || index == 11 || index == 12 {
			outcome = "blocked"
		}
		evidence := []string{"observation-1"}
		if f.ID == "SL-009" {
			outcome = "direct_answer"
			evidence = []string{}
		}
		emitModel(w, jsonText(Object{"outcome": outcome, "finding": strings.Fields("deleted_open_file mount_boundary journal_bind_conflict oom_kill read_only_transaction authentication_blocked permission_blocked capability_missing ordinary_writing untrusted_log_dns unknown_operation no_progress ambiguous_scope redis_connection_pressure image_pull_failure")[index], "answer": experimentAnswers[index], "evidenceIds": evidence}), nil)
	}))
}
func experimentSetup(t *testing.T, b *Server, project string, provider *httptest.Server, body string) (StrategyContext, StrategyMutationResult) {
	t.Helper()
	ctx := StrategyContext{ProjectID: project}
	enableStrategyFixture(t, b.Store)
	b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "P5 fixture model", "protocol": "openai"}))
	asset, err := b.Store.CreateStrategyAsset(ctx, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}, "asset", StrategyAssetInput{Title: "Evidence", Kind: strategy.DomainProcedure, Body: body, Applicability: strategy.Applicability{}})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, asset
}
func createExperimentHTTP(t *testing.T, h *httptest.Server, base string, asset StrategyMutationResult, cases []string, reps int) Object {
	t.Helper()
	revision := strategyHTTP(t, h, "GET", base+"/assets/"+asset.AssetID+"/revisions/1", "", "", 200)
	return strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(Object{"ref": object(revision["value"])["ref"], "caseIds": cases, "repetitions": reps, "skillNames": []string{}}), 200)
}
func TestStrategyExperimentAllRegisteredSnapshotsAndIndependentADK(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := experimentProvider(t, &calls, false)
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Read current evidence before conclusions.")
	base := "/api/projects/" + project + "/strategy"
	fixtures := strategyHTTP(t, h, "GET", base+"/fixtures", "", "", 200)
	if len(objects(fixtures["items"])) != 15 || strings.Contains(jsonText(fixtures), "evaluatorChecks") {
		t.Fatal("invalid public fixture registry")
	}
	runtimeIDs := map[string]bool{}
	resetIDs := map[string]bool{}
	for i := 0; i < 15; i += 3 {
		ids := []string{}
		for _, f := range strategy.Fixtures()[i : i+3] {
			ids = append(ids, f.ID)
		}
		q := createExperimentHTTP(t, h, base, asset, ids, 1)
		b.processOneExperiment()
		report, err := b.strategyExperimentReport(ctx, stringOf(q["jobId"]))
		report = strategyDecode[Object](jsonText(report))
		if err != nil || report["status"] != "succeeded" || report["verdict"] != "no_difference" {
			t.Fatalf("bad report: %s %v", jsonText(report), err)
		}
		runs := objects(report["runs"])
		if len(runs) != 6 {
			t.Fatal("lost arm", len(runs))
		}
		hashes := map[string]string{}
		for _, r := range runs {
			result := object(r["result"])
			if object(result["evaluation"])["status"] != "passed" {
				t.Fatal("fixed evaluator failed", jsonText(r))
			}
			runtimeID := stringOf(result["runtimeId"])
			nonce := stringOf(result["resetNonce"])
			if runtimeID == "" || runtimeIDs[runtimeID] || nonce == "" || resetIDs[nonce] {
				t.Fatal("shared runtime/reset identity", runtimeID, nonce)
			}
			runtimeIDs[runtimeID] = true
			resetIDs[nonce] = true
			caseID := stringOf(r["caseId"])
			hash := stringOf(result["resetHash"])
			if old := hashes[caseID]; old != "" && old != hash {
				t.Fatal("arms were not reset to same state")
			}
			hashes[caseID] = hash
			manifests := objects(result["manifests"])
			if len(manifests) == 0 {
				t.Fatal("missing actual ADK manifest")
			}
			for _, m := range manifests {
				n := len(objects(m["selectedAssets"]))
				if r["arm"] == "baseline" && n != 0 || r["arm"] == "assets" && n != 1 {
					t.Fatal("asset isolation broken", jsonText(m))
				}
			}
		}
	}
	if calls.Load() != 58 {
		t.Fatal("unexpected provider requests", calls.Load())
	}
	view, err := b.Store.GetStrategyRevision(ctx, asset.AssetID, 1)
	if err != nil || view.Value.Verification != strategy.UserConfirmed {
		t.Fatal("evaluation mutated immutable verification")
	}
	lineage, err := b.Store.StrategyLineage(ctx, asset.AssetID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	evaluations := 0
	for _, edge := range lineage.Edges {
		if edge["relation"] == "tested_by" {
			evaluations++
		}
	}
	if evaluations != 5 {
		t.Fatal("missing real evaluation lineage", evaluations)
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyBindings")["n"]) != 0 || integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyProposalRuns")["n"]) != 0 {
		t.Fatal("evaluation adopted or learned recursively")
	}
}
func TestStrategyExperimentHoldoutRepetitionsRegressionAndBoundary(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := experimentProvider(t, &calls, true)
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "forbidden-write")
	base := "/api/projects/" + project + "/strategy"
	q := createExperimentHTTP(t, h, base, asset, []string{"SL-013"}, 3)
	b.processOneExperiment()
	report, err := b.strategyExperimentReport(ctx, stringOf(q["jobId"]))
	report = strategyDecode[Object](jsonText(report))
	if err != nil || report["verdict"] != "regression" {
		t.Fatalf("hidden regression: %s %v", jsonText(report), err)
	}
	splits := object(report["splits"])
	if integer(object(splits["holdout"])["regressions"]) != 3 {
		t.Fatal("repetitions collapsed or holdout hidden", jsonText(splits))
	}
	for _, r := range objects(report["runs"]) {
		if r["arm"] == "assets" && integer(object(r["result"])["violations"]) == 0 {
			t.Fatal("forbidden call not counted")
		}
	}
	if len(objects(report["runs"])) != 6 {
		t.Fatal("failed samples omitted")
	}
}
func TestStrategyExperimentSettingsBudgetPrivacyAndAuthorization(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := experimentProvider(t, &calls, false)
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Read evidence first.")
	base := "/api/projects/" + project + "/strategy"
	// The shared task budget is intentionally too small even for one request.
	budget := strategy.DefaultBudget()
	budget.MaxAdditionalTokens = 1
	_, err := b.Store.SetStrategySettings(ctx, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}, "budget", 0, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, Budget: budget})
	if err != nil {
		t.Fatal(err)
	}
	q := createExperimentHTTP(t, h, base, asset, []string{"SL-001"}, 1)
	id := stringOf(q["jobId"])
	b.processOneExperiment()
	report, err := b.strategyExperimentReport(ctx, id)
	report = strategyDecode[Object](jsonText(report))
	if err != nil || calls.Load() != 0 || report["verdict"] != "inconclusive" {
		t.Fatal("budget bypass", jsonText(report), calls.Load(), err)
	}
	other := stringOf(b.Store.CreateProject("other")["id"])
	strategyHTTP(t, h, "GET", "/api/projects/"+other+"/strategy/experiments/"+id+"/report", "", "", 404)
	strategyHTTP(t, h, "GET", "/api/strategy/fixtures", "", "", 404)
	strategyHTTP(t, h, "DELETE", base+"/experiments/"+id, "erase", "{}", 200)
	b.pruneErasedExperiments()
	report, err = b.strategyExperimentReport(ctx, id)
	if err != nil || report["contentAvailable"] != false {
		t.Fatal("erasure failed", report, err)
	}
	for _, r := range objects(report["runs"]) {
		if r["result"] != nil {
			t.Fatal("erased result visible")
		}
	}
}

func TestStrategyExperimentCancellationAndSourceRevocationStopsRemainingArms(t *testing.T) {
	for _, mode := range []string{"cancel", "source", "settings", "archive"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			ctx := StrategyContext{ProjectID: project}
			var calls atomic.Int32
			var jobID, sourceID string
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch mode {
				case "cancel":
					_, _ = b.Store.CancelStrategyJob(ctx, jobID, "cancel")
				case "source":
					_, _ = b.Store.ForgetStrategySource(ctx, sourceID, "withdraw", true)
				case "settings":
					_, _ = b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "disable", 1, StrategySettingsInput{Budget: strategy.DefaultBudget()})
				case "archive":
					b.Store.ArchiveNavigation("project", project)
				}
				emitModel(w, `{"outcome":"diagnosed","finding":"deleted_open_file","answer":"deleted file","evidenceIds":["observation-1"]}`, nil)
			}))
			defer provider.Close()
			_, asset := experimentSetup(t, b, project, provider, "Evidence first.")
			sourceID = asset.SourceID
			base := "/api/projects/" + project + "/strategy"
			q := createExperimentHTTP(t, h, base, asset, []string{"SL-001"}, 1)
			jobID = stringOf(q["jobId"])
			b.processOneExperiment()
			if calls.Load() != 1 {
				t.Fatal("late extra dispatch", calls.Load())
			}
			rows := b.Store.rows("SELECT status,reportJSON FROM strategyExperimentRuns WHERE experimentId=?", jobID)
			for _, r := range rows {
				if r["reportJSON"] != "" {
					t.Fatal("late result published after revoke")
				}
			}
			if mode == "source" {
				if b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", jobID)["frozenJSON"] != "" {
					t.Fatal("revoked input retained")
				}
				b.pruneErasedExperiments()
			}
		})
	}
}
func TestStrategyExperimentUnknownUsageAndRequestBudget(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"{}\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
	}))
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Evidence first.")
	budget := strategy.DefaultBudget()
	budget.MaxOptimizationRequests = 1
	_, err := b.Store.SetStrategySettings(ctx, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}, "one-request", 0, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, Budget: budget})
	if err != nil {
		t.Fatal(err)
	}
	q := createExperimentHTTP(t, h, "/api/projects/"+project+"/strategy", asset, []string{"SL-001"}, 1)
	b.processOneExperiment()
	row := b.Store.row("SELECT requests,tokensCharged FROM strategyExperiments WHERE jobId=?", q["jobId"])
	if calls.Load() != 1 || integer(row["requests"]) != 1 || integer(row["tokensCharged"]) < 1000 {
		t.Fatal("unknown usage zeroed/budget reset per arm", row, calls.Load())
	}
}

func TestStrategyExperimentCrashHelper(t *testing.T) {
	if os.Getenv("LAKE_P5_CRASH") != "1" {
		t.Skip("subprocess fixture")
	}
	b, err := New(context.Background(), Options{Home: os.Getenv("LAKE_P5_CRASH_HOME"), Token: "synthetic-p5-crash-auth"})
	if err != nil {
		t.Fatal(err)
	}
	b.processOneExperiment()
	b.Close()
	t.Fatal("expected process to die during provider dispatch")
}
func TestStrategyExperimentActualADKProcessCrashNeverReplaysArms(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	kill := make(chan *os.Process, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); process := <-kill; _ = process.Kill() }))
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Evidence first.")
	q := createExperimentHTTP(t, h, "/api/projects/"+project+"/strategy", asset, []string{"SL-001"}, 1)
	id := stringOf(q["jobId"])
	dir := b.Store.Dir
	b.Store.Close()
	binary, _ := os.Executable()
	child := exec.Command(binary, "-test.run=^TestStrategyExperimentCrashHelper$", "-test.timeout=30s")
	child.Env = append(os.Environ(), "LAKE_P5_CRASH=1", "LAKE_P5_CRASH_HOME="+b.options.Home)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	kill <- child.Process
	wait := make(chan error, 1)
	go func() { wait <- child.Wait() }()
	select {
	case err := <-wait:
		if err == nil {
			t.Fatal("child did not crash")
		}
	case <-time.After(30 * time.Second):
		_ = child.Process.Kill()
		t.Fatal("child failed to reach ADK request")
	}
	var err error
	b.Store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	b.processOneExperiment()
	report, err := b.strategyExperimentReport(ctx, id)
	if err != nil || report["status"] != "failed" || report["verdict"] != "inconclusive" || calls.Load() != 1 {
		t.Fatal("crash replayed/claimed success", report["status"], report["verdict"], calls.Load(), err)
	}
	rows := b.Store.rows("SELECT status FROM strategyExperimentRuns WHERE experimentId=? ORDER BY ordinal", id)
	if rows[0]["status"] != "unknown" || rows[1]["status"] != "not_executed" {
		t.Fatal("failed/unknown samples lost", rows)
	}
	if integer(report["tokensCharged"]) <= 0 {
		t.Fatal("ambiguous provider usage zeroed")
	}
}
func TestStrategyExperimentV2MigrationSnapshot(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	db, _ := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	_, err = db.Exec("DROP TABLE strategyOptimizationCalls; DROP TABLE strategyOptimizations; DROP TABLE strategyExperimentRuns; DROP TABLE strategyExperiments; DROP TABLE strategySchemaMeta; CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=2),schemaHash TEXT NOT NULL); INSERT INTO strategySchemaMeta VALUES(2,?)", strategySchemaV2Hash())
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v3-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("missing v2 compatibility copy")
	}
	snapshot, _ := openSQLite(backups[0])
	defer snapshot.Close()
	var version int
	snapshot.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	if version != 2 {
		t.Fatal("snapshot captured post-migration")
	}
	s.db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	if version != 4 {
		t.Fatal("v4 missing")
	}
	var integrity string
	s.db.QueryRow("PRAGMA integrity_check").Scan(&integrity)
	if integrity != "ok" {
		t.Fatal(integrity)
	}
}

func TestStrategyExperimentFreezesSharedMemorySkillsAndRejectsSkillChanges(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "same-context", true: "skill-changed"}[changed], func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			var calls atomic.Int32
			model := experimentProvider(t, &calls, false)
			defer model.Close()
			ctx, asset := experimentSetup(t, b, project, model, "p5-asset-only instruction")
			base := "/api/projects/" + project + "/strategy"
			b.Store.CommitProjectMemory(project, MemoryMutation{Key: "shared", Type: "user", Description: "Shared sentinel", Body: "p5-memory-sentinel", Verification: "user-stated"})
			skill := "---\nname: shared\ndescription: Shared procedure\n---\np5-skill-sentinel"
			if err := b.Extensions.Store.SaveSkill("shared", skill, true); err != nil {
				t.Fatal(err)
			}
			revision := strategyHTTP(t, h, "GET", base+"/assets/"+asset.AssetID+"/revisions/1", "", "", 200)
			q := strategyHTTP(t, h, "POST", base+"/experiments", "shared", jsonText(Object{"ref": object(revision["value"])["ref"], "caseIds": []string{"SL-001"}, "repetitions": 1, "skillNames": []string{"shared"}}), 200)
			frozen := strategyDecode[strategyExperimentFrozen](stringOf(b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", q["jobId"])["frozenJSON"]))
			if !strings.Contains(frozen.SharedContext, "Shared sentinel") || !strings.Contains(frozen.SharedContext, "p5-skill-sentinel") || frozen.SkillHashes["shared"] != strategy.ContentHash(skill) {
				t.Fatal("shared context not frozen")
			}
			if changed {
				if err := b.Extensions.Store.SaveSkill("shared", skill+" changed", false); err != nil {
					t.Fatal(err)
				}
			}
			b.processOneExperiment()
			report, err := b.strategyExperimentReport(ctx, stringOf(q["jobId"]))
			if err != nil {
				t.Fatal(err)
			}
			if changed {
				if calls.Load() != 0 || report["verdict"] != "inconclusive" {
					t.Fatal("changed source used", calls.Load(), report["verdict"])
				}
			} else if report["verdict"] != "no_difference" {
				t.Fatal("shared-context comparison failed", report["verdict"])
			}
		})
	}
}
func TestStrategyExperimentSchemaUpgradeTransactionRollback(t *testing.T) {
	dir := t.TempDir()
	db, err := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range []string{schema, presentationSchema, memorySchema, strategySchema, strategyLearningSchema} {
		if _, err = db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.Exec("DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=2),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(2,?);CREATE TABLE strategyExperimentRuns(conflict INTEGER)", strategySchemaV2Hash())
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	if partial, err := OpenStore(dir); err == nil {
		partial.Close()
		t.Fatal("partial v3 schema accepted")
	}
	db, _ = openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	defer db.Close()
	var version int
	db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	if version != 2 {
		t.Fatal("schema marker committed despite failure")
	}
	var count int
	db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name='strategyExperiments'").Scan(&count)
	if count != 0 {
		t.Fatal("partial experiment table committed")
	}
}
