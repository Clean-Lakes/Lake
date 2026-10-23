package web

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (s *Store) ReserveMemoryDispatch(job Object) (string, bool) {
	returnValue := s.update(func() any {
		project := stringOf(job["projectId"])
		start := time.Now().UTC().Truncate(24 * time.Hour)
		if integer(s.row("SELECT count(*) AS n FROM projectMemoryJobAttemptsV2 WHERE projectId=? AND startedAt>=?", project, start.Format(time.RFC3339Nano))["n"]) >= 20 {
			s.exec("UPDATE projectMemoryJobs SET status='budget_wait',nextAttemptAtMs=?,leaseToken='',leaseOwner='',leaseUntilMs=0,attempts=max(0,attempts-1),lastErrorCode='daily_dispatch_limit',updatedAt=? WHERE jobId=? AND leaseToken=?", start.Add(24*time.Hour).UnixMilli(), now(), job["jobId"], job["leaseToken"])
			return ""
		}
		id := ident()
		s.exec("INSERT INTO projectMemoryJobAttemptsV2(attemptId,jobId,projectId,startedAt,status,modelRefHash) VALUES(?,?,?,?,'dispatched',?)", id, job["jobId"], project, now(), memoryHash(job["modelRefJSON"]))
		return id
	}).(string)
	return returnValue, returnValue != ""
}

func (s *Store) settleMemoryDispatch(attempt string, usage ai.Usage, status, reason string) {
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobAttemptsV2 SET status=?,reason=?,finishedAt=?,inputUsage=?,outputUsage=?,usageKnown=? WHERE attemptId=? AND finishedAt=''", status, reason, now(), usage.Input, usage.Output, usage.InputKnown && usage.OutputKnown, attempt)
		return nil
	})
}

// Caller holds messageMu. Cancel the provider and revoke its lease without
// waiting for network teardown. The active marker stays until the call exits.
func (b *Server) PauseMemoryExtractionForForeground() {
	if b.memoryCancel == nil {
		return
	}
	b.memoryCancel()
	b.Store.update(func() any {
		b.Store.exec("UPDATE projectMemoryJobs SET status='queued',attempts=max(0,attempts-1),nextAttemptAtMs=?,leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode='foreground_preempted',updatedAt=? WHERE jobId=? AND leaseToken=? AND status='running'", time.Now().UnixMilli(), now(), b.memoryJobID, b.memoryLease)
		return nil
	})
}

// Caller holds messageMu; resource mutation has already committed. Revoke work
// from this project immediately, without waiting for provider cancellation.
func (b *Server) invalidateMemoryExtraction(project, reason string) {
	if !b.Store.memoryV2 || b.memoryCancel == nil {
		return
	}
	jobProject := b.Store.read(func() any {
		return stringOf(b.Store.row("SELECT t.projectId FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE j.jobId=?", b.memoryJobID)["projectId"])
	}).(string)
	if jobProject != project {
		return
	}
	b.memoryCancel()
	b.Store.update(func() any {
		b.Store.exec("UPDATE projectMemoryJobs SET status='skipped',leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode=?,updatedAt=? WHERE jobId=? AND leaseToken=? AND status='running'", reason, now(), b.memoryJobID, b.memoryLease)
		return nil
	})
}

func (b *Server) processMemoryV2Job() {
	b.messageMu.Lock()
	if len(b.runningMessages) > 0 || b.memoryCancel != nil || time.Since(b.memoryLastForeground) < 2*time.Second || b.Context.Err() != nil {
		b.messageMu.Unlock()
		return
	}
	job := b.Store.ClaimMemoryJob()
	if job == nil {
		b.messageMu.Unlock()
		return
	}
	jobID, token := stringOf(job["jobId"]), stringOf(job["leaseToken"])
	var snapshot ai.MemoryTurnSnapshot
	if json.Unmarshal([]byte(stringOf(job["snapshotJSON"])), &snapshot) != nil || snapshot.SchemaVersion != 2 || !ai.ValidMemorySnapshot(snapshot) {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(jobID, token, "skipped", "legacy_or_invalid_snapshot", ai.Usage{})
		return
	}
	settings := b.Store.MemorySettings(snapshot.ProjectID)
	if settings["useEnabled"] != true || settings["extractionEnabled"] != true || integer(settings["epoch"]) != snapshot.Epoch {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(jobID, token, "skipped", "memory_disabled", ai.Usage{})
		return
	}
	model := b.Models.ResolveModelIdentity(snapshot.ModelRef)
	if !b.Store.memorySnapshotBindingsValid(snapshot) {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(jobID, token, "skipped", "resource_changed", ai.Usage{})
		return
	}
	if model == nil {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(jobID, token, "blocked", "model_unavailable", ai.Usage{})
		return
	}
	messages, err := b.Store.memoryExtractionInputV2(snapshot)
	if err != nil {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(jobID, token, "blocked", "context_budget", ai.Usage{})
		return
	}
	attempt, ok := b.Store.ReserveMemoryDispatch(job)
	if !ok {
		b.messageMu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(b.Context, 60*time.Second)
	b.memoryCancel, b.memoryJobID, b.memoryLease = cancel, jobID, token
	b.messageMu.Unlock()
	defer func() {
		cancel()
		b.messageMu.Lock()
		if b.memoryLease == token {
			b.memoryCancel = nil
			b.memoryJobID = ""
			b.memoryLease = ""
		}
		b.messageMu.Unlock()
	}()
	output, usage, err := b.Engine.ExtractMemory(ctx, *model, messages)
	status, reason := "succeeded", ""
	defer func() { b.Store.settleMemoryDispatch(attempt, usage, status, reason) }()
	if err != nil {
		status, reason = "failed", "model_error"
		if ctx.Err() != nil {
			status, reason = "cancelled", "interrupted"
		}
		b.Store.SettleMemoryJob(jobID, token, "retry_wait", reason, usage)
		return
	}
	mutations, err := parseMemoryExtractionV2(output)
	if err == nil {
		err = validateMemoryExtractionSources(messages, mutations)
	}
	if err != nil {
		status, reason = "failed", "invalid_output"
		b.Store.SettleMemoryJob(jobID, token, "failed", reason, usage)
		return
	}
	for _, mutation := range mutations {
		if b.Terminals.containsCredential(jsonText(mutation)) || !ai.SafeMemoryContent(jsonText(mutation), *model) {
			status, reason = "failed", "credential_detected"
			b.Store.SettleMemoryJob(jobID, token, "failed", reason, usage)
			return
		}
	}
	b.messageMu.Lock()
	if len(b.runningMessages) > 0 || ctx.Err() != nil {
		b.messageMu.Unlock()
		status, reason = "cancelled", "foreground_preempted"
		return
	}
	_, err = b.Store.CommitMemoryCandidates(job, snapshot, mutations, usage)
	b.messageMu.Unlock()
	if err != nil {
		status, reason = "blocked", "conflict"
		var f *Failure
		if errors.As(err, &f) && f.Status == 400 {
			status, reason = "failed", "invalid_output"
		}
		b.Store.SettleMemoryJob(jobID, token, status, reason, usage)
	}
}
