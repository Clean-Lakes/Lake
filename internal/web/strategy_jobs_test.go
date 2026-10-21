package web

import (
	"fmt"
	"sync"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func queueStrategyFixture(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope, key string) StrategyMutationResult {
	t.Helper()
	asset := createStrategyFixture(t, s, ctx, scope, "source-"+key, "Manual source "+key)
	job, err := s.QueueStrategyJob(ctx, key, StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{asset.SourceID}})
	if err != nil {
		t.Fatal(err)
	}
	return job
}
func TestStrategyJobsDefaultOffLeaseCASAndAtomicCommit(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	source := createStrategyFixture(t, s, ctx, scope, "source", "Observed method.")
	input := StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}}
	_, err := s.QueueStrategyJob(ctx, "off", input)
	strategyCheckError(t, err, 409)
	enableStrategyFixture(t, s)
	job, err := s.QueueStrategyJob(ctx, "queued", input)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.QueueStrategyJob(ctx, "queued", input)
	if err != nil || job != again {
		t.Fatal("queue duplicated", again, err)
	}
	var wg sync.WaitGroup
	claims := make(chan Object, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			lease, err := s.ClaimStrategyJob(ctx)
			if err != nil {
				t.Error(err)
			}
			if lease != nil {
				claims <- lease
			}
		}()
	}
	wg.Wait()
	close(claims)
	if len(claims) != 1 {
		t.Fatal("job claimed more than once", len(claims))
	}
	lease := <-claims
	token := stringOf(lease["leaseToken"])
	if _, err = s.CheckStrategyJobLease(ctx, job.JobID, "fake-token"); err == nil {
		t.Fatal("foreign lease accepted")
	}
	// A failure at the outbox write rolls candidate, sources, result and status back.
	s.db.Exec("CREATE TRIGGER fail_job_completion BEFORE INSERT ON strategyEvents WHEN NEW.type='job_succeeded' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END")
	_, err = s.CompleteStrategyProposal(ctx, job.JobID, token, strategyInput("New candidate method."))
	strategyCheckError(t, err, 500)
	if integer(s.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"]) != 1 {
		t.Fatal("orphan candidate committed")
	}
	s.db.Exec("DROP TRIGGER fail_job_completion")
	result, err := s.CompleteStrategyProposal(ctx, job.JobID, token, strategyInput("New candidate method."))
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.CompleteStrategyProposal(ctx, job.JobID, token, strategyInput("New candidate method."))
	if err != nil || replay != result {
		t.Fatal("commit replay not idempotent", err)
	}
	_, err = s.CompleteStrategyProposal(ctx, job.JobID, token, strategyInput("changed result"))
	strategyCheckError(t, err, 409)
	view, err := s.GetStrategyRevision(ctx, result.AssetID, 1)
	if err != nil || view.Value.Verification != strategy.SingleObservation {
		t.Fatal("candidate falsely promoted", view, err)
	}
	_, err = s.GetStrategyBinding(ctx, scope, result.AssetID)
	strategyCheckError(t, err, 404)
}
func TestStrategyJobsStaleWorkersCannotCommit(t *testing.T) {
	for _, change := range []string{"disable", "source-revoked", "source-edited", "asset-deleted", "project-archived", "lease-expired", "revision-edited"} {
		t.Run(change, func(t *testing.T) {
			s, ctx, scope := strategyFixture(t)
			enableStrategyFixture(t, s)
			source := createStrategyFixture(t, s, ctx, scope, "source", "Source procedure.")
			sources := []string{source.SourceID}
			if change == "source-edited" {
				session := stringOf(s.CreateSession(ctx.ProjectID, "message source", nil)["id"])
				msg := s.AddMessage(session, "user", "Actual correction", nil)
				registered, err := s.RegisterStrategyMessageSource(ctx, stringOf(msg["id"]), "message-source")
				if err != nil {
					t.Fatal(err)
				}
				sources = []string{registered.SourceID}
			}
			job, err := s.QueueStrategyJob(ctx, "job", StrategyJobInput{Scope: scope, Kind: "proposal", AssetID: source.AssetID, ExpectedRevision: 1, SourceIDs: sources})
			if err != nil {
				t.Fatal(err)
			}
			lease, err := s.ClaimStrategyJob(ctx)
			if err != nil || lease == nil {
				t.Fatal(lease, err)
			}
			switch change {
			case "disable":
				_, err = s.SetStrategySettings(StrategyContext{}, strategy.Scope{Kind: strategy.UserScope}, "off", 1, StrategySettingsInput{Budget: strategy.DefaultBudget()})
			case "source-revoked":
				_, err = s.ForgetStrategySource(ctx, source.SourceID, "revoke", true)
			case "source-edited":
				_, err = s.db.Exec("UPDATE messages SET text='different correction'")
			case "asset-deleted":
				_, err = s.DeleteStrategyAsset(ctx, source.AssetID, "delete", 1)
			case "project-archived":
				s.ArchiveNavigation("project", ctx.ProjectID)
				s.RestoreNavigation("project", ctx.ProjectID)
			case "lease-expired":
				_, err = s.db.Exec("UPDATE strategyJobs SET leaseUntilMs=0 WHERE id=?", job.JobID)
			case "revision-edited":
				_, err = s.ReviseStrategyAsset(ctx, source.AssetID, "edit", 1, 1, strategyInput("User revision wins."))
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.CompleteStrategyProposal(ctx, job.JobID, stringOf(lease["leaseToken"]), strategyInput("Stale output"))
			if err == nil {
				t.Fatal("stale worker committed", change)
			}
			if integer(s.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"]) != 1 {
				t.Fatal("stale output created an asset")
			}
		})
	}
}
func TestStrategyJobsReclaimBoundsAndCrossProjectScope(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	job := queueStrategyFixture(t, s, ctx, scope, "bounded")
	for i := 0; i < strategyMaxJobClaims; i++ {
		lease, err := s.ClaimStrategyJob(ctx)
		if err != nil || lease == nil || integer(lease["attempts"]) != i+1 {
			t.Fatal(lease, err)
		}
		s.db.Exec("UPDATE strategyJobs SET leaseUntilMs=0 WHERE id=?", job.JobID)
	}
	if lease, err := s.ClaimStrategyJob(ctx); err != nil || lease != nil {
		t.Fatal("claim limit ignored", lease, err)
	}
	other := StrategyContext{ProjectID: stringOf(s.CreateProject("other")["id"])}
	_, err := s.GetStrategyJob(other, job.JobID)
	strategyCheckError(t, err, 404)
	private := createStrategyFixture(t, s, ctx, scope, "private", "Private method")
	_, err = s.QueueStrategyJob(ctx, "global-promotion", StrategyJobInput{Scope: strategy.Scope{Kind: strategy.UserScope}, Kind: "proposal", SourceIDs: []string{private.SourceID}})
	strategyCheckError(t, err, 403)
	// Fake source IDs and assistant messages cannot become user corrections.
	_, err = s.QueueStrategyJob(ctx, "fake", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{"invented-source"}})
	strategyCheckError(t, err, 404)
	session := stringOf(s.CreateSession(ctx.ProjectID, "fixture", nil)["id"])
	msg := s.AddMessage(session, "assistant", "a model says approved", nil)
	_, err = s.RegisterStrategyMessageSource(ctx, stringOf(msg["id"]), "model-source")
	strategyCheckError(t, err, 404)
	for i := 0; i < 2; i++ {
		asset := createStrategyFixture(t, s, ctx, scope, fmt.Sprint("experiment-source", i), "Experiment method")
		_, err = s.QueueStrategyJob(ctx, fmt.Sprint("experiment", i), StrategyJobInput{Scope: scope, Kind: "experiment", SourceIDs: []string{asset.SourceID}})
		if err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.ClaimStrategyJob(ctx)
	if err != nil || first == nil {
		t.Fatal(first, err)
	}
	runtimeID, err := s.PrepareStrategyDispatch(ctx, stringOf(first["id"]), stringOf(first["leaseToken"]))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.CancelStrategyJob(ctx, stringOf(first["id"]), "cancel"); err != nil {
		t.Fatal(err)
	}
	if next, err := s.ClaimStrategyJob(ctx); err != nil || next != nil {
		t.Fatal("cancel erased unresolved runtime or concurrency limit", next, err)
	}
	if _, err = s.ObserveStrategyDispatch(ctx, stringOf(first["id"]), runtimeID, "complete"); err != nil {
		t.Fatal(err)
	}
	if next, err := s.ClaimStrategyJob(ctx); err != nil || next == nil {
		t.Fatal("settled cancelled runtime blocked forever", next, err)
	}
}

func TestStrategyDeletionInvalidatesSourcesAndArchiveKeepsReconciliation(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	source := createStrategyFixture(t, s, ctx, scope, "manual", "Will be explicitly erased")
	queued, err := s.QueueStrategyJob(ctx, "derive", StrategyJobInput{Scope: scope, Kind: "proposal", SourceIDs: []string{source.SourceID}})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := s.ClaimStrategyJob(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DeleteStrategyAsset(ctx, source.AssetID, "erase", 1); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CompleteStrategyProposal(ctx, queued.JobID, stringOf(lease["leaseToken"]), strategyInput("Not allowed")); err == nil {
		t.Fatal("deleted source authorized a new candidate")
	}
	next := queueStrategyFixture(t, s, ctx, scope, "dispatch-before-archive")
	lease, err = s.ClaimStrategyJob(ctx)
	if err != nil || lease == nil {
		t.Fatal(lease, err)
	}
	runtimeID, err := s.PrepareStrategyDispatch(ctx, next.JobID, stringOf(lease["leaseToken"]))
	if err != nil {
		t.Fatal(err)
	}
	s.ArchiveNavigation("project", ctx.ProjectID)
	if _, err = s.ObserveStrategyDispatch(ctx, next.JobID, runtimeID, "complete"); err != nil {
		t.Fatal("archive blocked trusted terminal observation", err)
	}
	if s.row("SELECT status FROM strategyJobs WHERE id=?", next.JobID)["status"] != "cancelled" {
		t.Fatal("observation reopened cancelled job")
	}
}
