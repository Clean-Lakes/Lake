package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

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

func TestStrategyExperimentV2MigrationSnapshot(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	db, _ := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	_, err = db.Exec("DROP TABLE strategyUsageFeedback; DROP TABLE strategyReusePolicies; DROP TABLE strategyReviews; DROP TABLE strategyAssessments; DROP TABLE strategyPromotions; DROP TABLE strategyRejections; DROP TABLE strategyOptimizationCalls; DROP TABLE strategyOptimizations; DROP TABLE strategyExperimentRuns; DROP TABLE strategyExperiments; DROP TABLE strategySchemaMeta; CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=2),schemaHash TEXT NOT NULL); INSERT INTO strategySchemaMeta VALUES(2,?)", strategySchemaV2Hash())
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
	if version != 6 {
		t.Fatal("v5 missing")
	}
	var integrity string
	s.db.QueryRow("PRAGMA integrity_check").Scan(&integrity)
	if integrity != "ok" {
		t.Fatal(integrity)
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
