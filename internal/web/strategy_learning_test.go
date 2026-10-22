package web

import (
	"encoding/json"
	"errors"
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

func learningSource(t *testing.T, s *Store, ctx StrategyContext) StrategyMutationResult {
	t.Helper()
	session := stringOf(s.CreateSession(ctx.ProjectID, "source", nil)["id"])
	msg := s.AddMessage(session, "user", "以后请先列出证据，再提出结论。", nil)
	result, err := s.RegisterStrategyMessageSource(ctx, stringOf(msg["id"]), ident())
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func learningOutput(id, body string) string {
	return jsonText(strategyProposalResult{SchemaVersion: 1, Candidate: &strategyProposalCandidate{Title: "Evidence before conclusions", Kind: strategy.UserPreference, Body: body, Reason: "The user explicitly requested an evidence-first answer; effectiveness is unverified.", SourceIDs: []string{id}}})
}
func TestStrategyLearningAutomaticNewTurnAndNoRecursion(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ctx := StrategyContext{ProjectID: project}
	var mainCalls, learningCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		messages := objects(body["messages"])
		if len(messages) > 0 && strings.Contains(stringOf(messages[0]["content"]), "Extract at most one reusable") {
			learningCalls.Add(1)
			if len(objects(body["tools"])) != 0 || len(messages) != 2 {
				t.Error("extraction has tools/history")
			}
			payload := object(strategyDecode[Object](stringOf(messages[1]["content"])))
			source := objects(payload["sources"])[0]
			emitModel(w, learningOutput(stringOf(source["sourceId"]), "Present evidence before conclusions."), nil)
			return
		}
		mainCalls.Add(1)
		emitModel(w, "好的，会先列证据。", nil)
	}))
	defer provider.Close()
	b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "learning fixture", "protocol": "openai"}))
	b.Store.SetMemorySettings(project, true, false, 0)
	send := func(text string) {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": text}, 202)
		b.workers.Wait()
	}
	send("以后请先列证据。")
	if n := integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyJobs")["n"]); n != 0 {
		t.Fatal("default-off queued", n)
	}
	enableStrategyFixture(t, b.Store)
	send("你好")
	b.processOneStrategyJob()
	if learningCalls.Load() != 0 {
		t.Fatal("ordinary turn triggered learning")
	}
	send("以后请先列证据，再提出结论。")
	if n := integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyLearningTurns")["n"]); n != 1 {
		t.Fatal("missing true turn", n)
	}
	b.processOneStrategyJob()
	b.processOneStrategyJob()
	if learningCalls.Load() != 1 || mainCalls.Load() != 3 {
		t.Fatal("recursive or missing calls", mainCalls.Load(), learningCalls.Load())
	}
	assets, err := b.Store.ListStrategyAssets(ctx, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}, "", 50)
	if err != nil || len(assets) != 1 {
		t.Fatal("candidate missing", assets, err)
	}
	view, err := b.Store.GetStrategyRevision(ctx, assets[0].ID, 1)
	if err != nil || view.Value.Verification != strategy.SingleObservation || len(view.Value.Applicability.Profiles) != 1 {
		t.Fatal("candidate authority", view, err)
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyBindings")["n"]) != 0 {
		t.Fatal("automatic adoption")
	}
	sources, err := b.Engine.StrategyOutbox(id)
	if err != nil || len(sources) != 0 {
		t.Fatal("unacked outbox", err)
	}
	// The auxiliary call did not overwrite the completed business reply.
	viewMain, _ := b.Engine.Snapshot(id)
	if viewMain.Status != "completed" {
		t.Fatal("learning changed main turn")
	}
	base := "/api/projects/" + project + "/strategy"
	jobs := strategyHTTP(t, h, "GET", base+"/proposals", "", "", 200)
	if strings.Contains(jsonText(jobs), "leaseToken") || strings.Contains(jsonText(jobs), "leaseHash") || !strings.Contains(jsonText(jobs), "unverified") {
		t.Fatal("unsafe/missing job view", jobs)
	}
}
func TestStrategyLearningStrictResultSchema(t *testing.T) {
	good := learningOutput("actual", "Use concise reports.")
	if _, err := parseStrategyProposal(good, []string{"actual"}); err != nil {
		t.Fatal(err)
	}
	if _, err := parseStrategyProposal(`{"schemaVersion":1,"candidate":null}`, nil); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{good + " {}", strings.Replace(good, `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1), strings.Replace(good, `"body":`, `"Body":`, 1), strings.Replace(good, `"reason":`, `"verification":"observed","reason":`, 1), strings.Replace(good, "actual", "forged", 1), `{"schemaVersion":1}`, `{"schemaVersion":1,"candidate":{"title":"x"}}`, strings.Replace(good, "Use concise reports.", strings.Repeat("x", 4001), 1)} {
		if _, err := parseStrategyProposal(bad, []string{"actual"}); err == nil {
			t.Fatal("accepted malformed/forged result")
		}
	}
}
func TestStrategyLearningDispatchFailureCancellationAndBudgets(t *testing.T) {
	for _, mode := range []string{"invalid", "secret", "cancel", "withdraw", "disable", "budget", "no_candidate"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(id)["projectId"])}
			scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
			enableStrategyFixture(t, b.Store)
			source := learningSource(t, b.Store, ctx)
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				output := learningOutput(source.SourceID, "Use concise reports.")
				switch mode {
				case "invalid":
					output = `{"candidate":{}}`
				case "secret":
					output = learningOutput(source.SourceID, "password=synthetic-only-private")
				case "cancel":
					_, _ = b.Store.CancelStrategyJob(ctx, stringOf(b.Store.row("SELECT id FROM strategyJobs LIMIT 1")["id"]), "cancel")
				case "withdraw":
					_, _ = b.Store.ForgetStrategySource(ctx, source.SourceID, "withdraw", true)
				case "disable":
					_, _ = b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "disable", 1, StrategySettingsInput{Budget: strategy.DefaultBudget()})
				case "no_candidate":
					output = `{"schemaVersion":1,"candidate":null}`
				}
				emitModel(w, output, nil)
			}))
			defer provider.Close()
			b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "bounded fixture", "protocol": "openai"}))
			if mode == "budget" {
				budget := strategy.DefaultBudget()
				budget.MaxAdditionalTokens = 1
				_, err := b.Store.SetStrategySettings(ctx, scope, "budget", 0, StrategySettingsInput{MasterEnabled: true, LearnEnabled: true, Budget: budget})
				if err != nil {
					t.Fatal(err)
				}
			}
			input := StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}}
			queued, err := b.Store.QueueStrategyProposal(ctx, "q", input)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := b.Store.QueueStrategyProposal(ctx, "q2", input)
			if err != nil || replay.JobID != queued.JobID {
				t.Fatal("queue dedup", err)
			}
			b.processOneStrategyJob()
			b.processOneStrategyJob()
			expected := int32(1)
			if mode == "budget" {
				expected = 0
			}
			if calls.Load() != expected {
				t.Fatal("model replay/budget bypass", calls.Load())
			}
			if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"]) != 0 {
				t.Fatal("invalid/late candidate published")
			}
			job, _ := b.Store.GetStrategyJob(ctx, queued.JobID)
			if job["status"] != "failed" && job["status"] != "cancelled" && mode != "no_candidate" {
				t.Fatal("job not settled", job)
			}
			if mode == "no_candidate" && job["errorCode"] != "no_candidate" {
				t.Fatal(job)
			}
			if mode == "cancel" || mode == "withdraw" || mode == "disable" {
				run := b.Store.row("SELECT status,resultJSON,usageJSON FROM strategyProposalRuns WHERE jobId=?", queued.JobID)
				if run == nil || run["status"] == "running" || run["resultJSON"] != "" {
					t.Fatal("cancelled output retained or usage lost", run)
				}
			}
		})
	}
}
func TestStrategyLearningDurableResultRecoveryAndNoRedispatch(t *testing.T) {
	for _, stage := range []string{"before_dispatch", "running", "result", "committed"} {
		t.Run(stage, func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(id)["projectId"])}
			enableStrategyFixture(t, b.Store)
			source := learningSource(t, b.Store, ctx)
			q, err := b.Store.QueueStrategyProposal(ctx, "queue", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source.SourceID}})
			if err != nil {
				t.Fatal(err)
			}
			job, err := b.Store.claimStrategyJob(ctx, "proposal")
			if err != nil {
				t.Fatal(err)
			}
			result, _ := parseStrategyProposal(learningOutput(source.SourceID, "First inspect evidence."), []string{source.SourceID})
			if stage != "before_dispatch" {
				_, err = b.Store.beginStrategyProposalRun(ctx, q.JobID, stringOf(job["leaseToken"]), "request-hash")
				if err != nil {
					t.Fatal(err)
				}
			}
			if stage == "result" || stage == "committed" {
				_, err = b.Store.saveStrategyProposalRun(ctx, q.JobID, stringOf(job["leaseToken"]), result, ai.Usage{Input: 20, Output: 30}, "")
				if err != nil {
					t.Fatal(err)
				}
			}
			if stage == "committed" {
				b.finishStrategyProposal(ctx, job, result)
			}
			dir := b.Store.Dir
			b.Store.Close()
			b.Store, err = OpenStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			if stage == "before_dispatch" {
				job, _ = b.Store.GetStrategyJob(ctx, q.JobID)
				if job["status"] != "queued" {
					t.Fatal("undispatched job not recovered", job)
				}
				return
			}
			b.processOneStrategyJob()
			b.processOneStrategyJob()
			job, _ = b.Store.GetStrategyJob(ctx, q.JobID)
			count := integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"])
			if stage == "running" {
				if job["status"] != "failed" || count != 0 {
					t.Fatal("ambiguous request rerun/published", job, count)
				}
			} else if job["status"] != "succeeded" || count != 1 {
				t.Fatal("durable result not recovered exactly once", job, count)
			}
		})
	}
}
func TestStrategyLearningCommitFailureRetriesOnlyDurableResult(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(id)["projectId"])}
	enableStrategyFixture(t, b.Store)
	source := learningSource(t, b.Store, ctx)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		emitModel(w, learningOutput(source.SourceID, "Inspect before conclusions."), nil)
	}))
	defer provider.Close()
	b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "commit fixture", "protocol": "openai"}))
	q, err := b.Store.QueueStrategyProposal(ctx, "q", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source.SourceID}})
	if err != nil {
		t.Fatal(err)
	}
	b.Store.db.Exec("CREATE TRIGGER reject_candidate BEFORE INSERT ON strategyAssets BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END")
	b.processOneStrategyJob()
	job, _ := b.Store.GetStrategyJob(ctx, q.JobID)
	if job["status"] != "awaiting_reconciliation" {
		t.Fatal("durable result abandoned", job)
	}
	b.Store.db.Exec("DROP TRIGGER reject_candidate")
	b.processOneStrategyJob()
	job, _ = b.Store.GetStrategyJob(ctx, q.JobID)
	if job["status"] != "succeeded" || calls.Load() != 1 {
		t.Fatal("business retry redispatched model", job, calls.Load())
	}
}
func TestStrategyLearningV1UpgradeBackupAndNoSecondBackup(t *testing.T) {
	dir := t.TempDir()
	db, err := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range []string{schema, presentationSchema, memorySchema, strategySchema} {
		if _, err = db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec("INSERT INTO strategySchemaMeta VALUES(1,?)", strategySchemaV1Hash()); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v2-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("v1 backup missing")
	}
	snapshot, _ := openSQLite(backups[0])
	defer snapshot.Close()
	var version int
	var hash string
	snapshot.QueryRow("SELECT version,schemaHash FROM strategySchemaMeta").Scan(&version, &hash)
	if version != 1 || hash != strategySchemaV1Hash() {
		t.Fatal("backup marker changed")
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	backups, _ = filepath.Glob(filepath.Join(dir, "lake-web.before-strategy-v2-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("duplicate backup")
	}
	s.db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	if version != 4 {
		t.Fatal("upgrade missing")
	}
}
func TestStrategyLearningSourceLiveMessageGuardAndDedup(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	session := stringOf(s.CreateSession(ctx.ProjectID, "outcome", nil)["id"])
	text := "以后请只使用中文总结。"
	msg := s.AddMessage(session, "user", text, nil)
	effective, _ := s.EffectiveStrategySettings(ctx)
	snapshot := ai.SealStrategySnapshot(ai.StrategyTurnSnapshot{UserMessageID: stringOf(msg["id"]), SessionID: session, ProjectID: ctx.ProjectID, TurnID: "actual-turn", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), FinishedAt: now(), GlobalEpoch: effective.GlobalEpoch, ProjectEpoch: effective.ProjectEpoch, Status: "completed", Profile: "core", UserText: text, Correction: true})
	source, err := s.registerStrategyTurn(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.registerStrategyTurn(snapshot)
	if err != nil || source != replay {
		t.Fatal("snapshot replay", err)
	}
	q, err := s.QueueStrategyProposal(ctx, "job", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source}})
	if err != nil {
		t.Fatal(err)
	}
	job, _ := s.claimStrategyJob(ctx, "proposal")
	input := StrategyAssetInput{Title: "Chinese summary", Kind: strategy.UserPreference, Body: "使用中文总结。", Applicability: strategy.Applicability{Profiles: []string{"core"}}}
	createStrategyFixture(t, s, ctx, scope, "existing", "使用中文总结。")
	result, err := strategyCall(s, true, func() StrategyMutationResult {
		return s.strategyCompleteProposal(ctx, q.JobID, stringOf(job["leaseToken"]), input, true)
	})
	if err != nil || result.AssetID != "" {
		t.Fatal("asset dedup failed", result, err)
	}
	s.exec("UPDATE messages SET text='changed' WHERE id=?", msg["id"])
	_, err = s.QueueStrategyProposal(ctx, "after-edit", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source}})
	strategyCheckError(t, err, 409)
}

func TestStrategyLearningMemoryDedupAndSourceDeletion(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	source := learningSource(t, s, ctx)
	memory := s.CommitProjectMemory(ctx.ProjectID, MemoryMutation{Key: "answer-style", Type: "user", Description: "Answer style", Body: "List evidence before conclusions.", Verification: "user-stated"})
	q, err := s.QueueStrategyProposal(ctx, "q", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}})
	if err != nil {
		t.Fatal(err)
	}
	job, _ := s.claimStrategyJob(ctx, "proposal")
	_, err = strategyCall(s, true, func() StrategyMutationResult {
		return s.strategyCompleteProposal(ctx, q.JobID, stringOf(job["leaseToken"]), StrategyAssetInput{Title: "Evidence", Kind: strategy.UserPreference, Body: "List evidence before conclusions.\r\n", Applicability: strategy.Applicability{}}, true)
	})
	if err != nil {
		t.Fatal(err)
	}
	row, _ := s.GetStrategyJob(ctx, q.JobID)
	if row["errorCode"] != "duplicate_memory" {
		t.Fatal("memory duplicated", row)
	}
	if got := s.ReadProjectMemory(ctx.ProjectID, "answer-style", false); integer(got["revision"]) != integer(memory["revision"]) || got["body"] != "List evidence before conclusions." {
		t.Fatal("dedup mutated memory")
	}
	session := stringOf(s.row("SELECT sessionId FROM strategySourceEvents WHERE id=?", source.SourceID)["sessionId"])
	// Historical source IDs must not prevent ordinary conversation deletion.
	s.DeleteSession(session)
	_, err = s.QueueStrategyProposal(ctx, "after-delete", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}})
	strategyCheckError(t, err, 409)
}

func TestStrategyLearningCrashHelper(t *testing.T) {
	if os.Getenv("LAKE_P4_CRASH") != "1" {
		t.Skip("subprocess fixture")
	}
	s, err := OpenStore(os.Getenv("LAKE_P4_CRASH_DIR"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := StrategyContext{ProjectID: os.Getenv("LAKE_P4_CRASH_PROJECT")}
	job, err := s.claimStrategyJob(ctx, "proposal")
	if err != nil || job == nil {
		t.Fatal(err)
	}
	id, token := stringOf(job["id"]), stringOf(job["leaseToken"])
	_, err = s.beginStrategyProposalRun(ctx, id, token, "sealed-request")
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("LAKE_P4_CRASH_STAGE") == "result" {
		result, _ := parseStrategyProposal(learningOutput(s.strategyJobSources(id)[0], "Inspect evidence first."), s.strategyJobSources(id))
		_, err = s.saveStrategyProposalRun(ctx, id, token, result, ai.Usage{Input: 10, Output: 5}, "")
		if err != nil {
			t.Fatal(err)
		}
	}
	os.Exit(23)
}
func TestStrategyLearningActualProcessCrashRecovery(t *testing.T) {
	for _, stage := range []string{"running", "result"} {
		t.Run(stage, func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(id)["projectId"])}
			enableStrategyFixture(t, b.Store)
			source := learningSource(t, b.Store, ctx)
			q, err := b.Store.QueueStrategyProposal(ctx, "queue", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source.SourceID}})
			if err != nil {
				t.Fatal(err)
			}
			dir := b.Store.Dir
			b.Store.Close()
			binary, _ := os.Executable()
			child := exec.Command(binary, "-test.run=^TestStrategyLearningCrashHelper$", "-test.timeout=30s")
			child.Env = append(os.Environ(), "LAKE_P4_CRASH=1", "LAKE_P4_CRASH_DIR="+dir, "LAKE_P4_CRASH_PROJECT="+ctx.ProjectID, "LAKE_P4_CRASH_STAGE="+stage)
			output, crashErr := child.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(crashErr, &exited) || exited.ExitCode() != 23 {
				t.Fatalf("child did not reach durable boundary: %v %s", crashErr, output)
			}
			b.Store, err = OpenStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			b.processOneStrategyJob()
			b.processOneStrategyJob()
			job, _ := b.Store.GetStrategyJob(ctx, q.JobID)
			count := integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"])
			if stage == "running" {
				if job["status"] != "failed" || count != 0 {
					t.Fatal("unknown dispatch replayed", job, count)
				}
			} else if job["status"] != "succeeded" || count != 1 {
				t.Fatal("result not recovered exactly once", job, count)
			}
		})
	}
}

func TestStrategyLearningHTTPRealSourcesScopeAndPagination(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ctx := StrategyContext{ProjectID: project}
	base := "/api/projects/" + project + "/strategy"
	enableStrategyFixture(t, b.Store)
	first := b.Store.AddMessage(id, "user", "以后请先列证据。", nil)
	strategyHTTP(t, h, "POST", base+"/sources", "missing", "{}", 400)
	strategyHTTP(t, h, "POST", base+"/sources", "forged", `{"messageId":"forged"}`, 404)
	registered := strategyHTTP(t, h, "POST", base+"/sources", "source", jsonText(Object{"messageId": first["id"]}), 200)
	second := b.Store.AddMessage(id, "user", "以后请用中文总结。", nil)
	strategyHTTP(t, h, "POST", base+"/sources", "source2", jsonText(Object{"messageId": second["id"]}), 200)
	page := strategyHTTP(t, h, "GET", base+"/sources?limit=1", "", "", 200)
	if len(objects(page["items"])) != 1 || stringOf(page["nextCursor"]) == "" {
		t.Fatal("missing page", page)
	}
	last := strategyHTTP(t, h, "GET", base+"/sources?limit=1&after="+stringOf(page["nextCursor"]), "", "", 200)
	if len(objects(last["items"])) != 1 || objects(last["items"])[0]["id"] == objects(page["items"])[0]["id"] {
		t.Fatal("pagination repeated/skipped", last)
	}
	source := stringOf(registered["sourceId"])
	payload := jsonText(Object{"sourceIds": []string{source}, "assetId": "", "expectedRevision": 0})
	queued := strategyHTTP(t, h, "POST", base+"/proposals", "proposal", payload, 200)
	other := stringOf(b.Store.CreateProject("other")["id"])
	strategyHTTP(t, h, "POST", "/api/projects/"+other+"/strategy/proposals", "cross", payload, 404)
	strategyHTTP(t, h, "GET", "/api/strategy/proposals", "", "", 404)
	strategyHTTP(t, h, "POST", base+"/proposals/"+stringOf(queued["jobId"])+"/cancel", "cancel", "{}", 200)
	strategyHTTP(t, h, "DELETE", base+"/sources/"+source, "withdraw", "{}", 200)
	_, err := b.Store.QueueStrategyProposal(ctx, "late", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: project}, Kind: "proposal", SourceIDs: []string{source}})
	strategyCheckError(t, err, 409)
}

func TestStrategyLearningDeletionErasesPrivateSnapshotsAndResults(t *testing.T) {
	for _, target := range []string{"session", "asset"} {
		t.Run(target, func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(session)["projectId"])}
			scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
			enableStrategyFixture(t, b.Store)
			text := "以后请先列证据，再提出结论。"
			msg := b.Store.AddMessage(session, "user", text, nil)
			effective, _ := b.Store.EffectiveStrategySettings(ctx)
			snapshot := ai.SealStrategySnapshot(ai.StrategyTurnSnapshot{UserMessageID: stringOf(msg["id"]), SessionID: session, ProjectID: ctx.ProjectID, TurnID: "private-turn", StartedAt: now(), FinishedAt: now(), GlobalEpoch: effective.GlobalEpoch, ProjectEpoch: effective.ProjectEpoch, Status: "completed", Profile: "core", UserText: text, Correction: true})
			source, err := b.Store.registerStrategyTurn(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			q, err := b.Store.QueueStrategyProposal(ctx, "q", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source}})
			if err != nil {
				t.Fatal(err)
			}
			job, _ := b.Store.claimStrategyJob(ctx, "proposal")
			token := stringOf(job["leaseToken"])
			_, err = b.Store.beginStrategyProposalRun(ctx, q.JobID, token, "private-request")
			if err != nil {
				t.Fatal(err)
			}
			result, _ := parseStrategyProposal(learningOutput(source, "Inspect before conclusions."), []string{source})
			_, err = b.Store.saveStrategyProposalRun(ctx, q.JobID, token, result, ai.Usage{}, "")
			if err != nil {
				t.Fatal(err)
			}
			b.finishStrategyProposal(ctx, job, result)
			asset := stringOf(b.Store.row("SELECT id FROM strategyAssets LIMIT 1")["id"])
			if target == "session" {
				b.Store.DeleteSession(session)
				if b.Store.row("SELECT snapshotJSON FROM strategyLearningTurns WHERE sourceId=?", source)["snapshotJSON"] != "" {
					t.Fatal("deleted conversation retained in learning snapshot")
				}
			} else {
				_, err = b.Store.DeleteStrategyAsset(ctx, asset, "delete", 1)
				if err != nil {
					t.Fatal(err)
				}
			}
			if b.Store.row("SELECT resultJSON FROM strategyProposalRuns WHERE jobId=?", q.JobID)["resultJSON"] != "" {
				t.Fatal("deleted content retained in proposal result")
			}
		})
	}
}

func TestStrategyLearningUsesExactMessageIdentityAndParsedTime(t *testing.T) {
	s, ctx, _ := strategyFixture(t)
	enableStrategyFixture(t, s)
	session := stringOf(s.CreateSession(ctx.ProjectID, "exact message", nil)["id"])
	text := "以后请先列证据。"
	s.AddMessage(session, "user", text, nil)
	actual := s.AddMessage(session, "user", text, nil)
	effective, _ := s.EffectiveStrategySettings(ctx)
	s.exec("UPDATE messages SET createdAt='2000-01-01T00:00:00.1Z',text='edited during turn' WHERE id=?", actual["id"])
	snapshot := ai.SealStrategySnapshot(ai.StrategyTurnSnapshot{UserMessageID: stringOf(actual["id"]), SessionID: session, ProjectID: ctx.ProjectID, TurnID: "exact-turn", StartedAt: "2000-01-01T00:00:00.100001Z", FinishedAt: now(), Status: "completed", Profile: "core", UserText: text, Correction: true, GlobalEpoch: effective.GlobalEpoch, ProjectEpoch: effective.ProjectEpoch})
	// An older identical user message cannot impersonate the edited actual input.
	_, err := s.registerStrategyTurn(snapshot)
	strategyCheckError(t, err, 404)
	s.exec("UPDATE messages SET text=? WHERE id=?", text, actual["id"])
	source, err := s.registerStrategyTurn(snapshot)
	if err != nil || source == "" {
		t.Fatal("RFC3339 trailing-zero ordering incorrectly rejected genuine input", err)
	}
}
