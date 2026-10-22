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

const optimizationFirstBody = "Method revision one: read the authorized observation, distinguish deleted open files from directory totals, and ground each conclusion in the observed evidence. Stop on permission or unknown operations."
const optimizationSynthesisBody = "Method revision two: first establish the selected resource and authorization, then read the authorized observation. Check whether live file handles explain directory/disk discrepancies. Cite observations and explicitly retain unresolved gaps; never claim actual recovery from simulation."

func optimizationProvider(t *testing.T, calls *atomic.Int32, mode string, hook func(Object, bool)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var data Object
		_ = json.NewDecoder(r.Body).Decode(&data)
		messages := objects(data["messages"])
		raw := jsonText(messages)
		aux := strings.Contains(raw, "Lake bounded snapshot optimizer v1")
		if strings.Contains(raw, "snapshot-judge-v1") || strings.Contains(raw, "diagnostic_marker") {
			t.Error("hidden judge leaked")
		}
		if hook != nil {
			hook(data, aux)
		}
		if aux {
			if len(messages) != 2 || len(objects(data["tools"])) != 0 {
				t.Error("optimizer received tools/history")
			}
			if strings.Contains(raw, "Investigate connection pressure") || strings.Contains(raw, "fixture-redis") || strings.Contains(raw, "candidateWins") || strings.Contains(raw, "evaluation") {
				t.Error("holdout or judge feedback leaked into optimizer")
			}
			input := object(parsed(stringOf(messages[1]["content"])))
			if !strings.Contains(jsonText(input["developmentRuns"]), "720GB") {
				t.Error("actual observed development evidence missing")
			}
			ids := []string{}
			for _, run := range objects(input["developmentRuns"]) {
				ids = append(ids, stringOf(run["runId"]))
			}
			body := optimizationFirstBody
			if input["stage"] == "synthesize" {
				body = optimizationSynthesisBody
				if mode == "same_synthesis" {
					body = optimizationFirstBody
				}
			}
			candidate := any(Object{"body": body, "reason": "Observed behavior does not consistently ground the diagnosis in the available evidence; only this snapshot is known.", "refutedHypothesis": "Directory totals necessarily equal allocated filesystem bytes.", "changes": "Inspect current observations before forming an evidence-linked diagnosis.", "expectedInformation": "Whether selected observations support the current explanation.", "stopCondition": "Stop on denied access, unknown operation, no new information or exhausted budget.", "sourceRunIds": ids})
			if mode == "no_candidate" {
				candidate = nil
			}
			if mode == "unknown_usage" {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte("data: " + jsonText(Object{"choices": []Object{{"index": 0, "delta": Object{"content": jsonText(Object{"schemaVersion": 1, "candidate": candidate})}, "finish_reason": "stop"}}}) + "\n\ndata: [DONE]\n\n"))
			} else {
				emitModel(w, jsonText(Object{"schemaVersion": 1, "candidate": candidate}), nil)
			}
			return
		}
		hasTool := false
		for _, m := range messages {
			hasTool = hasTool || m["role"] == "tool"
		}
		if !hasTool {
			emitModel(w, "", []ai.Call{{ID: "observe", Name: "read", Arguments: `{"path":"/fixture/observations.json"}`}})
			return
		}
		finding, answer := "deleted_open_file", "deleted open file occupies disk; synthetic evidence only."
		if !strings.Contains(raw, "Method revision") && mode != "no_progress" {
			finding = "mount_boundary"
		}
		if strings.Contains(raw, "Investigate connection pressure") {
			finding = "redis_connection_pressure"
			answer = "connection clients near limit; snapshot only."
			if mode == "regression" && strings.Contains(raw, "Method revision two") {
				finding = "mount_boundary"
			}
		}
		emitModel(w, jsonText(Object{"outcome": "diagnosed", "finding": finding, "answer": answer, "evidenceIds": []string{"observation-1"}}), nil)
	}))
}
func createOptimizationHTTP(t *testing.T, h *httptest.Server, base string, asset StrategyMutationResult) string {
	t.Helper()
	v := strategyHTTP(t, h, "GET", base+"/assets/"+asset.AssetID+"/revisions/1", "", "", 200)
	q := strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(Object{"ref": object(v["value"])["ref"], "caseIds": []string{"SL-001", "SL-014"}, "repetitions": 1, "skillNames": []string{}, "optimization": true}), 200)
	return stringOf(q["jobId"])
}
func optimizationReport(t *testing.T, b *Server, ctx StrategyContext, id string) Object {
	t.Helper()
	r, err := b.strategyExperimentReport(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return strategyDecode[Object](jsonText(r))
}
func TestStrategyOptimizationParserRejectsForgedSourcesAndAuthority(t *testing.T) {
	c := strategyOptimizationCandidate{Body: optimizationFirstBody, Reason: "Observed gap", RefutedHypothesis: "Unsupported assumption", Changes: "Read evidence", ExpectedInformation: "Current evidence", StopCondition: "No new information", SourceRunIDs: []string{"genuine"}}
	text := jsonText(strategyOptimizationOutput{SchemaVersion: 1, Candidate: &c})
	if _, err := parseStrategyOptimization(text, []string{"genuine"}); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{strings.Replace(text, `"genuine"`, `"forged"`, 1), strings.Replace(text, `"body":`, `"verified":true,"body":`, 1), strings.Replace(text, `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1), text + " {}", strings.Replace(text, `"changes":"Read evidence"`, `"changes":null`, 1)} {
		if _, err := parseStrategyOptimization(invalid, []string{"genuine"}); err == nil {
			t.Fatal("untrusted optimizer schema accepted")
		}
	}
}
func TestStrategyOptimizationSettingsAndCaseValidation(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := optimizationProvider(t, &calls, "", nil)
	defer provider.Close()
	_, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
	base := "/api/projects/" + project + "/strategy"
	v := strategyHTTP(t, h, "GET", base+"/assets/"+asset.AssetID+"/revisions/1", "", "", 200)
	request := Object{"ref": object(v["value"])["ref"], "caseIds": []string{"SL-001", "SL-014"}, "repetitions": 1, "skillNames": []string{}, "optimization": true}
	capabilities := object(strategyHTTP(t, h, "GET", base+"/settings", "", "", 200)["capabilities"])
	if capabilities["correct"] != true || capabilities["onlineCorrect"] != true || capabilities["correctMode"] != "snapshots_and_trusted_readonly" {
		t.Fatal("incorrect capability scope")
	}
	settings, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
	_, err := b.Store.SetStrategySettings(StrategyContext{}, settings.Scope, ident(), settings.Revision, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: false, Budget: settings.Budget})
	if err != nil {
		t.Fatal(err)
	}
	strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(request), 409)
	settings, _ = b.Store.GetStrategySettings(StrategyContext{}, settings.Scope)
	_, err = b.Store.SetStrategySettings(StrategyContext{}, settings.Scope, ident(), settings.Revision, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: true, Budget: settings.Budget})
	if err != nil {
		t.Fatal(err)
	}
	request["caseIds"] = []string{"SL-014", "SL-001"}
	strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(request), 400)
	request["caseIds"] = []string{"SL-001", "SL-014"}
	request["repetitions"] = 3
	strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(request), 400)
	request["repetitions"] = 1
	request["verified"] = true
	strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(request), 400)
	delete(request, "verified")
	settings, _ = b.Store.GetStrategySettings(StrategyContext{}, settings.Scope)
	budget := settings.Budget
	budget.MaxRevisions = 1
	_, err = b.Store.SetStrategySettings(StrategyContext{}, settings.Scope, ident(), settings.Revision, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: true, Budget: budget})
	if err != nil {
		t.Fatal(err)
	}
	strategyHTTP(t, h, "POST", base+"/experiments", ident(), jsonText(request), 400)
	if calls.Load() != 0 || b.Store.row("SELECT 1 FROM strategyOptimizations") != nil {
		t.Fatal("invalid/disabled request dispatched work")
	}
}
func TestStrategyOptimizationMemoryForgetErasesCandidateCopies(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := optimizationProvider(t, &calls, "", nil)
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
	b.Store.CommitProjectMemory(project, MemoryMutation{Key: "test-preference", Type: "user", Description: "test preference", Body: "Prefer explicit evidence.", Verification: "user-stated"})
	id := createOptimizationHTTP(t, h, "/api/projects/"+project+"/strategy", asset)
	b.processOneExperiment()
	if optimizationReport(t, b, ctx, id)["stopReason"] != "completed" {
		t.Fatal("optimization failed")
	}
	b.Store.CommitProjectMemory(project, MemoryMutation{Key: "test-preference", ExpectedRevision: 1, Forget: true})
	r := optimizationReport(t, b, ctx, id)
	if r["contentAvailable"] != false || b.Store.row("SELECT 1 FROM strategyOptimizationCalls WHERE experimentId=? AND resultJSON<>''", id) != nil {
		t.Fatal("forgotten memory retained in optimizer")
	}
}
func TestStrategyOptimizationSynthesisRevalidationHoldoutAndExplicitSave(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	provider := optimizationProvider(t, &calls, "", nil)
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
	base := "/api/projects/" + project + "/strategy"
	id := createOptimizationHTTP(t, h, base, asset)
	b.processOneExperiment()
	report := optimizationReport(t, b, ctx, id)
	if report["stopReason"] != "completed" || report["verdict"] != "candidate_better_on_selected_snapshots" || calls.Load() != 12 || integer(report["requests"]) != 12 || report["canSave"] != true {
		t.Fatalf("bad optimization: %s calls=%d", jsonText(report), calls.Load())
	}
	runs := objects(report["runs"])
	if len(runs) != 5 || len(objects(report["calls"])) != 2 {
		t.Fatal("missing runs/calls")
	}
	identities := map[string]bool{}
	hashes := map[string]string{}
	for _, run := range runs {
		result := object(run["result"])
		runtime := stringOf(result["runtimeId"])
		if runtime == "" || identities[runtime] {
			t.Fatal("shared runtime")
		}
		identities[runtime] = true
		caseID := stringOf(run["caseId"])
		if old := hashes[caseID]; old != "" && old != result["resetHash"] {
			t.Fatal("different initial state")
		}
		hashes[caseID] = stringOf(result["resetHash"])
		for _, m := range objects(result["manifests"]) {
			n := len(objects(m["selectedAssets"]))
			if run["arm"] == "baseline" && n != 0 || run["arm"] == "assets" && n != 1 {
				t.Fatal("candidate isolation")
			}
		}
	}
	if integer(b.Store.row("SELECT revision FROM strategyAssets WHERE id=?", asset.AssetID)["revision"]) != 1 || b.Store.row("SELECT 1 FROM strategyBindings") != nil {
		t.Fatal("automatic save/adoption")
	}
	other := stringOf(b.Store.CreateProject("other")["id"])
	strategyHTTP(t, h, "GET", "/api/projects/"+other+"/strategy/experiments/"+id, "", "", 404)
	saved := strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/save-candidate", "save-once", `{"expectedRevision":1}`, 200)
	again := strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/save-candidate", "save-once", `{"expectedRevision":1}`, 200)
	if saved["revision"] != float64(2) || jsonText(saved) != jsonText(again) {
		t.Fatal("duplicate candidate commit")
	}
	v, err := b.Store.GetStrategyRevision(ctx, asset.AssetID, 2)
	if err != nil || v.Value.Body != optimizationSynthesisBody || v.Value.Verification != strategy.FixtureValidated || b.Store.row("SELECT 1 FROM strategyBindings") != nil {
		t.Fatal("candidate persistence", v, err)
	}
	lineage, err := b.Store.StrategyLineage(ctx, asset.AssetID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	relations := map[string]int{}
	for _, edge := range lineage.Edges {
		relations[stringOf(edge["relation"])]++
	}
	for _, name := range []string{"tested_by", "composed_from", "compared_with", "proposed_to_fix"} {
		if relations[name] == 0 {
			t.Fatal("missing lineage", name)
		}
	}
	if strings.Contains(jsonText(report["experience"]), "holdout") || strings.Contains(jsonText(report), "sharedContext") || strings.Contains(jsonText(report), "leaseToken") {
		t.Fatal("private snapshot exported")
	}
	source := b.Store.row("SELECT id FROM strategySourceEvents WHERE originKey=?", "experiment:"+id)
	if _, err = b.Store.ForgetStrategySource(ctx, stringOf(source["id"]), "withdraw-eval", true); err != nil {
		t.Fatal(err)
	}
	b.pruneErasedExperiments()
	cleared := optimizationReport(t, b, ctx, id)
	if cleared["contentAvailable"] != false || b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", id)["frozenJSON"] != "" {
		t.Fatal("experiment erasure")
	}
	for _, run := range objects(cleared["runs"]) {
		if run["result"] != nil {
			t.Fatal("erased runtime content exported")
		}
	}
	if b.Store.row("SELECT 1 FROM strategyOptimizationCalls WHERE experimentId=? AND resultJSON<>''", id) != nil {
		t.Fatal("optimizer body copy survived")
	}
}
func TestStrategyOptimizationStopsForNoProgressRegressionAndBudget(t *testing.T) {
	for _, mode := range []string{"no_progress", "same_synthesis", "no_candidate", "regression", "budget", "unknown_usage"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			var calls atomic.Int32
			provider := optimizationProvider(t, &calls, mode, nil)
			defer provider.Close()
			ctx, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
			base := "/api/projects/" + project + "/strategy"
			if mode == "budget" || mode == "unknown_usage" {
				settings, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
				budget := settings.Budget
				budget.MaxOptimizationRequests = 3
				_, err := b.Store.SetStrategySettings(StrategyContext{}, settings.Scope, ident(), settings.Revision, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: true, Budget: budget})
				if err != nil {
					t.Fatal(err)
				}
			}
			id := createOptimizationHTTP(t, h, base, asset)
			b.processOneExperiment()
			r := optimizationReport(t, b, ctx, id)
			expected := "no_progress"
			if mode == "no_candidate" {
				expected = "no_candidate"
			}
			if mode == "regression" {
				expected = "regression"
			}
			if mode == "budget" || mode == "unknown_usage" {
				expected = "budget_exhausted"
			}
			if r["stopReason"] != expected || r["canSave"] != false || calls.Load() > 12 {
				t.Fatal("incorrect stop", mode, r["stopReason"], calls.Load())
			}
			strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/save-candidate", ident(), `{"expectedRevision":1}`, 409)
			if mode == "regression" && r["verdict"] != "regression" {
				t.Fatal("holdout regression hidden")
			}
			if mode == "budget" && calls.Load() != 3 {
				t.Fatal("budget per stage reset", calls.Load())
			}
			if mode == "unknown_usage" && integer(r["tokensCharged"]) <= 1000 {
				t.Fatal("unknown auxiliary usage refunded", r["tokensCharged"])
			}
		})
	}
}
func TestStrategyOptimizationRevocationDuringAuxiliaryCallDropsLateCandidate(t *testing.T) {
	for _, mode := range []string{"cancel", "source", "settings", "erase"} {
		t.Run(mode, func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			ctx := StrategyContext{ProjectID: project}
			var calls atomic.Int32
			id := ""
			source := ""
			provider := optimizationProvider(t, &calls, "", func(_ Object, aux bool) {
				if !aux {
					return
				}
				switch mode {
				case "cancel":
					_, _ = b.Store.CancelStrategyJob(ctx, id, ident())
				case "source":
					_, _ = b.Store.ForgetStrategySource(ctx, source, ident(), true)
				case "settings":
					settings, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
					_, _ = b.Store.SetStrategySettings(StrategyContext{}, settings.Scope, ident(), settings.Revision, StrategySettingsInput{Budget: settings.Budget})
				case "erase":
					_, _ = b.Store.CancelStrategyJob(ctx, id, ident())
					_, _ = strategyCall(b.Store, true, func() bool { b.Store.eraseStrategyExperiments("jobId=?", id); return true })
				}
			})
			defer provider.Close()
			_, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
			source = asset.SourceID
			base := "/api/projects/" + project + "/strategy"
			id = createOptimizationHTTP(t, h, base, asset)
			b.processOneExperiment()
			r := optimizationReport(t, b, ctx, id)
			if calls.Load() != 3 || r["canSave"] != false || b.Store.row("SELECT resultJSON FROM strategyOptimizationCalls WHERE experimentId=? AND stage='propose'", id)["resultJSON"] != "" {
				t.Fatal("late candidate escaped fence", mode, calls.Load())
			}
			if integer(r["tokensCharged"]) != 45 {
				t.Fatal("late usage lost", r["tokensCharged"])
			}
		})
	}
}
func TestStrategyOptimizationActualProviderCrashNeverReplaysUnknownCall(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	var calls atomic.Int32
	kill := make(chan *os.Process, 1)
	provider := optimizationProvider(t, &calls, "", func(_ Object, aux bool) {
		if aux {
			process := <-kill
			_ = process.Kill()
		}
	})
	defer provider.Close()
	ctx, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
	base := "/api/projects/" + project + "/strategy"
	id := createOptimizationHTTP(t, h, base, asset)
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
		t.Fatal("optimizer not reached")
	}
	var err error
	b.Store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	b.processOneExperiment()
	r := optimizationReport(t, b, ctx, id)
	if calls.Load() != 3 || r["stopReason"] != "awaiting_reconciliation" || r["canResume"] != false || integer(r["tokensCharged"]) <= 400 {
		t.Fatal("unknown optimizer replayed", r["stopReason"], calls.Load())
	}
	strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/resume", ident(), `{}`, 409)
}
func TestStrategyOptimizationCheckpointCrashHelper(t *testing.T) {
	if os.Getenv("LAKE_P6_BOUNDARY") != "1" {
		t.Skip("subprocess fixture")
	}
	b, err := New(context.Background(), Options{Home: os.Getenv("LAKE_P6_HOME"), Port: 4177, Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := StrategyContext{ProjectID: os.Getenv("LAKE_P6_PROJECT")}
	job, err := b.Store.claimStrategyJob(ctx, "experiment")
	if err != nil || job == nil {
		t.Fatal(err)
	}
	id, token := stringOf(job["id"]), stringOf(job["leaseToken"])
	row := b.Store.row("SELECT frozenJSON FROM strategyExperiments WHERE jobId=?", id)
	f := strategyDecode[strategyExperimentFrozen](stringOf(row["frozenJSON"]))
	if _, err = b.Store.PrepareStrategyDispatch(ctx, id, token); err != nil {
		t.Fatal(err)
	}
	_, err = strategyCall(b.Store, true, func() bool {
		b.Store.exec("UPDATE strategyOptimizations SET activationStartedMs=? WHERE jobId=?", time.Now().UnixMilli(), id)
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	m := b.Models.ResolveModelIdentity(f.ModelRef)
	m.ContextWindow = f.ContextWindow
	m.MaxOutput = f.MaxOutput
	root := filepath.Join(b.options.DataDir, "strategy-experiments")
	_ = os.MkdirAll(root, 0700)
	if _, code := b.optimizationRun(context.Background(), ctx, id, token, "baseline_development", root, f, *m, nil); code != "" {
		t.Fatal(code)
	}
	if _, err = b.Store.checkpointOptimization(ctx, id, token, 1); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("LAKE_P6_BOUNDARY_POINT") == "proposal_result" {
		if candidate, code := b.optimizationModel(context.Background(), ctx, id, token, "propose", f, *m); code != "" || candidate == nil {
			t.Fatal(code)
		}
	}
	if os.Getenv("LAKE_P6_BOUNDARY_POINT") == "final_result" {
		for stage := 1; stage <= 6; stage++ {
			if stage == 1 || stage == 3 {
				name := "propose"
				if stage == 3 {
					name = "synthesize"
				}
				if c, code := b.optimizationModel(context.Background(), ctx, id, token, name, f, *m); code != "" || c == nil {
					t.Fatal(code)
				}
			} else {
				variant := map[int]string{2: "proposal_development", 4: "synthesis_development", 5: "baseline_holdout", 6: "synthesis_holdout"}[stage]
				var asset *strategy.AssetRevision
				if stage != 5 {
					name := "synthesize"
					if stage == 2 {
						name = "propose"
					}
					asset, err = b.optimizationAsset(id, name, f)
					if err != nil {
						t.Fatal(err)
					}
				}
				if _, code := b.optimizationRun(context.Background(), ctx, id, token, variant, root, f, *m, asset); code != "" {
					t.Fatal(code)
				}
			}
			if stage < 6 {
				if _, err = b.Store.checkpointOptimization(ctx, id, token, stage+1); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	os.Exit(23)
}
func TestStrategyOptimizationExplicitResumeKeepsBudgetAndCompletedRunIdentity(t *testing.T) {
	for _, point := range []string{"baseline_checkpoint", "proposal_result", "final_result", "expired_wait", "exhausted_time", "stale_epoch"} {
		t.Run(point, func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			var calls atomic.Int32
			provider := optimizationProvider(t, &calls, "", nil)
			defer provider.Close()
			ctx, asset := experimentSetup(t, b, project, provider, "Observe evidence before conclusions.")
			base := "/api/projects/" + project + "/strategy"
			id := createOptimizationHTTP(t, h, base, asset)
			dir := b.Store.Dir
			// The fixture owns a live schedule ticker. Its Store pointer is
			// immutable in production; this test alone replaces it to simulate
			// recovery. Pause schedule reads across each replacement.
			reopen := func(beforeOpen func()) {
				t.Helper()
				b.scheduleMu.Lock()
				defer b.scheduleMu.Unlock()
				b.Store.Close()
				if beforeOpen != nil {
					beforeOpen()
				}
				store, err := OpenStore(dir)
				if err != nil {
					t.Fatal(err)
				}
				b.Store = store
			}
			reopen(func() {
				binary, _ := os.Executable()
				child := exec.Command(binary, "-test.run=^TestStrategyOptimizationCheckpointCrashHelper$", "-test.timeout=30s")
				child.Env = append(os.Environ(), "LAKE_P6_BOUNDARY=1", "LAKE_P6_HOME="+b.options.Home, "LAKE_P6_PROJECT="+project, "LAKE_P6_BOUNDARY_POINT="+point)
				out, err := child.CombinedOutput()
				if exited, ok := err.(*exec.ExitError); !ok || exited.ExitCode() != 23 {
					t.Fatalf("boundary crash failed %s %v", out, err)
				}
			})
			b.processOneExperiment()
			r := optimizationReport(t, b, ctx, id)
			first := objects(r["runs"])[0]
			wantCalls := int32(2)
			if point == "proposal_result" {
				wantCalls = 3
			}
			if point == "final_result" {
				wantCalls = 12
			}
			if r["canResume"] != true || r["stopReason"] != "awaiting_user" || calls.Load() != wantCalls {
				t.Fatal("checkpoint auto resumed", r["stopReason"], calls.Load())
			}
			waitUntil := r["waitUntilMs"]
			reopen(nil)
			if optimizationReport(t, b, ctx, id)["waitUntilMs"] != waitUntil {
				t.Fatal("restart extended wait TTL")
			}
			if point == "expired_wait" || point == "exhausted_time" || point == "stale_epoch" {
				if point == "expired_wait" {
					b.Store.update(func() any {
						b.Store.exec("UPDATE strategyOptimizations SET waitUntilMs=1 WHERE jobId=?", id)
						return nil
					})
				}
				if point == "exhausted_time" {
					b.Store.update(func() any {
						b.Store.exec("UPDATE strategyOptimizations SET activeMs=600000 WHERE jobId=?", id)
						return nil
					})
				}
				if point == "stale_epoch" {
					settings, _ := b.Store.GetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope})
					_, _ = b.Store.SetStrategySettings(StrategyContext{}, settings.Scope, ident(), settings.Revision, StrategySettingsInput{MasterEnabled: true, ApplyEnabled: true, LearnEnabled: true, CorrectEnabled: true, Budget: settings.Budget})
				}
				strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/resume", ident(), `{}`, 409)
				if calls.Load() != 2 {
					t.Fatal("invalid resume issued provider request")
				}
				return
			}
			strategyHTTP(t, h, "POST", base+"/experiments/"+id+"/resume", "resume-once", `{}`, 200)
			b.processOneExperiment()
			r = optimizationReport(t, b, ctx, id)
			if calls.Load() != 12 || r["stopReason"] != "completed" || integer(r["requests"]) != 12 || object(objects(r["runs"])[0]["result"])["runtimeId"] != object(first["result"])["runtimeId"] {
				t.Fatal("resume replayed baseline/reset budget", calls.Load(), r["stopReason"])
			}
		})
	}
}
