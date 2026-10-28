package web

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Called with messageMu held. The single existing worker owns admission,
// dispatch, cancellation and settlement for both preference and project memory.
func (b *Server) processNaturalPreferenceJob(job Object, snapshot ai.MemoryTurnSnapshot) {
	id, token := stringOf(job["jobId"]), stringOf(job["leaseToken"])
	if !naturalSourceAgeValid(snapshot) || !b.Store.read(func() any { return b.Store.naturalSnapshotValid(snapshot) }).(bool) {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(id, token, "skipped", "natural_memory_invalidated", ai.Usage{})
		return
	}
	model := b.Models.ResolveModelIdentity(snapshot.ModelRef)
	if model == nil {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(id, token, "blocked", "model_unavailable", ai.Usage{})
		return
	}
	existing := b.Store.read(func() any { return b.Store.naturalPreferenceIndex(snapshot) }).([]Object)
	index := ""
	if snapshot.LegacyExtraction {
		index = b.Store.ProjectMemoryIndex(snapshot.ProjectID)
	}
	messages := naturalPreferenceMessages(snapshot, existing, index)
	attempt := b.Store.update(func() any {
		// Reserve BEFORE provider invocation. Interrupted/unknown calls remain counted.
		start := time.Now().UTC().Truncate(24 * time.Hour)
		if integer(b.Store.row("SELECT count(*) AS n FROM naturalPreferenceDispatches WHERE projectId=? AND startedAt>=?", snapshot.ProjectID, start.Format(time.RFC3339Nano))["n"]) >= 20 {
			return ""
		}
		attempt := ident()
		b.Store.exec("INSERT INTO naturalPreferenceDispatches(id,jobId,projectId,startedAt) VALUES(?,?,?,?)", attempt, id, snapshot.ProjectID, now())
		return attempt
	}).(string)
	if attempt == "" {
		b.messageMu.Unlock()
		b.Store.SettleMemoryJob(id, token, "blocked", "natural_daily_dispatch_limit", ai.Usage{})
		return
	}
	ctx, cancel := context.WithTimeout(b.Context, 60*time.Second)
	b.memoryCancel, b.memoryJobID, b.memoryLease = cancel, id, token
	b.messageMu.Unlock()
	var usage ai.Usage
	status := "failed"
	defer func() {
		cancel()
		b.Store.update(func() any {
			b.Store.exec("UPDATE naturalPreferenceDispatches SET finishedAt=?,status=?,usageJSON=? WHERE id=?", now(), status, jsonText(usage), attempt)
			return nil
		})
		b.messageMu.Lock()
		if b.memoryLease == token {
			b.memoryCancel = nil
			b.memoryJobID = ""
			b.memoryLease = ""
		}
		b.messageMu.Unlock()
	}()
	output, u, err := b.Engine.ExtractMemory(ctx, *model, messages)
	usage = u
	if err != nil {
		status = "model_error"
		settlement := "retry_wait"
		if errors.Is(err, ai.ErrModelOutputLimit) {
			settlement, status = "failed", "output_limit"
		}
		if strings.Contains(err.Error(), "context budget") {
			settlement, status = "blocked", "context_budget"
		}
		b.Store.SettleMemoryJob(id, token, settlement, status, usage)
		return
	}
	result, mutations, err := parseNaturalPreferenceCompletion(output, snapshot.LegacyExtraction)
	if err == nil {
		err = validateNaturalPreferenceResult(snapshot.UserText, result)
	}
	if err != nil {
		status = "invalid_output"
		b.Store.SettleMemoryJob(id, token, "failed", status, usage)
		return
	}
	if b.Terminals.containsCredential(output) || b.Models.strategyContainsProviderSecret(output) || !ai.SafeMemoryContent(output, *model) {
		status = "credential_detected"
		b.Store.SettleMemoryJob(id, token, "failed", status, usage)
		return
	}
	b.messageMu.Lock()
	if len(b.runningMessages) > 0 || ctx.Err() != nil {
		b.messageMu.Unlock()
		status = "foreground_preempted"
		b.Store.SettleMemoryJob(id, token, "retry_wait", status, usage)
		return
	}
	_, err = b.Store.CommitMemoryExtraction(job, snapshot, mutations, usage, result)
	b.messageMu.Unlock()
	if err != nil {
		status = "conflict"
		b.Store.SettleMemoryJob(id, token, "blocked", status, usage)
		return
	}
	status = "succeeded"
}

func (s *Store) execSafeNaturalYield(job Object) {
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobs SET status='queued',attempts=max(0,attempts-1),leaseToken='',leaseOwner='',leaseUntilMs=0 WHERE jobId=? AND leaseToken=?", job["jobId"], job["leaseToken"])
		return nil
	})
}
