package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyBackgroundPreemptedByForegroundWithoutWaitingOrReplay(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(id)["projectId"])}
	enableStrategyFixture(t, b.Store)
	source := learningSource(t, b.Store, ctx)
	entered, release := make(chan struct{}), make(chan struct{})
	var auxiliary, foreground atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		messages := objects(request["messages"])
		if strings.Contains(stringOf(messages[0]["content"]), "Extract at most one reusable") {
			if auxiliary.Add(1) == 1 {
				close(entered)
			}
			// Keep the auxiliary handler stalled even after the client cancels.
			// The normal task must finish before this response is released.
			<-release
			emitModel(w, learningOutput(source.SourceID, "Late suggestion must be discarded."), nil)
			return
		}
		foreground.Add(1)
		emitModel(w, "前台任务已完成。", nil)
	}))
	defer provider.Close()
	defer close(release)
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "foreground-priority", Protocol: "openai"})
	q, err := b.Store.QueueStrategyProposal(ctx, "background", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source.SourceID}})
	if err != nil {
		t.Fatal(err)
	}

	workerDone := make(chan struct{})
	go func() { b.processOneStrategyJob(); close(workerDone) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("auxiliary call not dispatched")
	}
	// The read-only status endpoint must not wait for the stalled worker/model.
	page := apiTest(t, h, "GET", "/api/projects/"+ctx.ProjectID+"/strategy/proposals", nil, 200)
	if integer(object(page["limits"])["maxDailyRequests"]) != 12 {
		t.Fatal("missing independent learning limits")
	}
	start := time.Now()
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "回复收到，无需工具。"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if time.Since(start) > 3*time.Second || foreground.Load() != 1 {
		t.Fatal("foreground waited for auxiliary result", time.Since(start))
	}
	select {
	case <-workerDone:
	case <-time.After(3 * time.Second):
		t.Fatal("auxiliary client retained model slot after cancellation")
	}
	job, _ := b.Store.GetStrategyJob(ctx, q.JobID)
	run := b.Store.row("SELECT status,usageJSON,resultJSON FROM strategyProposalRuns WHERE jobId=?", q.JobID)
	usage := strategyDecode[Object](stringOf(run["usageJSON"]))
	if job["errorCode"] != "foreground_preempted" || job["dispatchState"] != "unknown" || run["status"] != "unknown" || run["resultJSON"] != "" || integer(usage["tokensCharged"]) != integer(usage["reservedTokens"]) || integer(usage["tokensCharged"]) < 1 {
		t.Fatal("cancelled dispatch lost unknown state/reservation", job, run)
	}
	b.processOneStrategyJob()
	if auxiliary.Load() != 1 || integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"]) != 0 {
		t.Fatal("unknown auxiliary call replayed or adopted")
	}
}

func TestStrategyBackgroundBusySlotDefersBeforeDispatchAndHasIndependentBudget(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ctx := StrategyContext{ProjectID: stringOf(b.Store.Session(id)["projectId"])}
	enableStrategyFixture(t, b.Store)
	// Online optimization budget must not disable or resize background learning.
	budget := strategy.DefaultBudget()
	budget.MaxAdditionalTokens = 1
	budget.MaxActiveSeconds = 1
	_, err := b.Store.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "tiny-online", 1, StrategySettingsInput{MasterEnabled: true, LearnEnabled: true, Budget: budget})
	if err != nil {
		t.Fatal(err)
	}
	source := learningSource(t, b.Store, ctx)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var request Object
		_ = json.NewDecoder(r.Body).Decode(&request)
		messages := objects(request["messages"])
		if integer(request["max_tokens"]) > strategy.DefaultLearningLimits().MaxOutputTokens || len(objects(request["tools"])) != 0 || len(stringOf(messages[0]["content"]))+len(stringOf(messages[1]["content"])) > strategy.DefaultLearningLimits().MaxInputBytes {
			t.Error("learning prompt/output exceeded separate limits")
		}
		emitModel(w, learningOutput(source.SourceID, "Keep private user conventions."), nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "independent-budget", Protocol: "openai"})
	q, err := b.Store.QueueStrategyProposal(ctx, "q", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}, Kind: "proposal", SourceIDs: []string{source.SourceID}})
	if err != nil {
		t.Fatal(err)
	}
	releases := []func(){}
	for i := 0; i < 4; i++ {
		_, release, ok := b.Engine.TryStrategyModelSlot(context.Background())
		if !ok {
			t.Fatal("fixture failed to occupy model slots")
		}
		releases = append(releases, release)
	}
	jobBefore, _ := b.Store.GetStrategyJob(ctx, q.JobID)
	if int64(integer(jobBefore["expiresAtMs"])) < time.Now().Add(47*time.Hour).UnixMilli() {
		t.Fatal("learning queue TTL still coupled to online seconds")
	}
	b.processOneStrategyJob()
	for _, release := range releases {
		release()
	}
	job, _ := b.Store.GetStrategyJob(ctx, q.JobID)
	if job["status"] != "queued" || integer(job["attempts"]) != 0 || calls.Load() != 0 || b.Store.row("SELECT jobId FROM strategyProposalRuns WHERE jobId=?", q.JobID) != nil {
		t.Fatal("model-busy admission dispatched or charged", job)
	}
	b.processOneStrategyJob()
	job, _ = b.Store.GetStrategyJob(ctx, q.JobID)
	if job["status"] != "succeeded" || calls.Load() != 1 {
		t.Fatal("independent learning budget not applied", job, calls.Load())
	}
}

func TestStrategyBackgroundDailyRequestAndUnknownTokenCapsAreDurable(t *testing.T) {
	for _, mode := range []string{"requests", "unknown_tokens"} {
		t.Run(mode, func(t *testing.T) {
			s, ctx, scope := strategyFixture(t)
			enableStrategyFixture(t, s)
			source := learningSource(t, s, ctx)
			limits := strategy.DefaultLearningLimits()
			count := limits.MaxDailyRequests
			if mode == "unknown_tokens" {
				count = limits.MaxDailyTokens / (limits.MaxInputBytes + limits.MaxOutputTokens)
			}
			for i := 0; i < count; i++ {
				q, err := s.QueueStrategyJob(ctx, fmt.Sprintf("job-%d", i), StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}})
				if err != nil {
					t.Fatal(err)
				}
				job, err := s.claimStrategyJob(ctx, "proposal")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = s.beginStrategyProposalRun(ctx, q.JobID, stringOf(job["leaseToken"]), "request"); err != nil {
					t.Fatal(err)
				}
				usage := ai.Usage{}
				if mode == "requests" {
					usage = ai.Usage{InputKnown: true, OutputKnown: true, Input: 1, Output: 1}
				}
				_, err = s.saveStrategyProposalRun(ctx, q.JobID, stringOf(job["leaseToken"]), nil, usage, "model_error")
				if err != nil {
					t.Fatal(err)
				}
				_, _ = s.failStrategyProposal(ctx, q.JobID, "model_error")
			}
			// Reopen the actual DB; changing online budgets/restarting cannot refund it.
			dir := s.Dir
			s.Close()
			reopened, err := OpenStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			q, err := reopened.QueueStrategyJob(ctx, "blocked", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}})
			if err != nil {
				t.Fatal(err)
			}
			job, err := reopened.claimStrategyJob(ctx, "proposal")
			if err != nil {
				t.Fatal(err)
			}
			_, err = reopened.beginStrategyProposalRun(ctx, q.JobID, stringOf(job["leaseToken"]), "not-dispatched")
			if e, ok := err.(*StrategyError); !ok || e.Code != "strategy_learning_daily_budget" {
				t.Fatal("durable daily cap bypassed", err)
			}
			if reopened.row("SELECT jobId FROM strategyProposalRuns WHERE jobId=?", q.JobID) != nil {
				t.Fatal("blocked request got a dispatch identity")
			}
		})
	}
}

func TestStrategyBackgroundInputTruncationPreservesSourcesAndFailureState(t *testing.T) {
	sources := []Object{}
	for i := 0; i < 8; i++ {
		sources = append(sources, Object{"sourceId": fmt.Sprintf("source-%d", i), "kind": "task_outcome", "turn": Object{"userText": strings.Repeat("纠正", 2000), "assistantText": strings.Repeat("结论", 2000), "status": "failed", "correction": true, "evidence": []Object{{"callId": "actual", "status": "unknown", "resultHash": "hash"}}}})
	}
	content, fits := strategyLearningContent(Object{"sources": sources, "existingMemory": strings.Repeat("记忆", 4000)})
	if !fits || len(content)+len(strategyProposalPrompt) > strategy.DefaultLearningLimits().MaxInputBytes {
		t.Fatal("cannot bound Chinese source envelope")
	}
	parsed := strategyDecode[Object](content)
	if len(objects(parsed["sources"])) != 8 || !strings.Contains(content, `"status":"unknown"`) || !strings.Contains(content, `"truncated":true`) {
		t.Fatal("truncation lost identity/uncertainty", content)
	}
}
