package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

const strategyExtractorVersion = "proposal-v1"

// Only Engine-produced sealed outboxes reach this adapter, never HTTP/model
// snapshots. Real user input is rechecked against the business session/message.
func (s *Store) registerStrategyTurn(snapshot ai.StrategyTurnSnapshot) (string, error) {
	return strategyCall(s, true, func() string {
		if !ai.ValidStrategySnapshot(snapshot) || snapshot.Deferred {
			strategyFail(400, "invalid_snapshot")
		}
		ctx := StrategyContext{ProjectID: snapshot.ProjectID}
		scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
		key := s.strategyEnsureScope(ctx, scope)
		session := s.session(snapshot.SessionID)
		if session["projectId"] != ctx.ProjectID {
			strategyFail(404, "source_unavailable")
		}
		if old := s.row("SELECT sourceId,snapshotHash FROM strategyLearningTurns WHERE sessionId=? AND turnId=?", snapshot.SessionID, snapshot.TurnID); old != nil {
			if old["snapshotHash"] != snapshot.SnapshotHash {
				strategyFail(409, "source_conflict")
			}
			return stringOf(old["sourceId"])
		}
		effective := s.strategyEffective(ctx)
		if !effective.Settings.MasterEnabled || !effective.Settings.LearnEnabled || snapshot.GlobalEpoch != effective.GlobalEpoch || snapshot.ProjectEpoch != effective.ProjectEpoch {
			return ""
		}
		start, err := time.Parse(time.RFC3339Nano, snapshot.StartedAt)
		if err != nil || start.After(time.Now().Add(time.Second)) {
			strategyFail(400, "invalid_snapshot")
		}
		msg := s.row("SELECT id,text,createdAt FROM messages WHERE id=? AND sessionId=? AND role='user' AND text=?", snapshot.UserMessageID, snapshot.SessionID, snapshot.UserText)
		if msg == nil {
			strategyFail(404, "source_unavailable")
		}
		created, err := time.Parse(time.RFC3339Nano, stringOf(msg["createdAt"]))
		if err != nil || created.After(start) {
			strategyFail(409, "source_unavailable")
		}
		id := ident()
		s.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'task_outcome',?,'',?,'Completed host turn reference','available',?)", id, key, "turn:"+snapshot.TurnID, snapshot.SessionID, snapshot.SnapshotHash, now())
		s.exec("INSERT INTO strategyLearningTurns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, ctx.ProjectID, snapshot.SessionID, snapshot.TurnID, msg["id"], strategy.ContentHash(snapshot.UserText), jsonText(snapshot), snapshot.SnapshotHash, snapshot.ModelRef, snapshot.GlobalEpoch, snapshot.ProjectEpoch, now())
		s.strategyNode("source:"+id, key, "task", "", 0, id)
		s.strategyEvent(key, ctx.ProjectID, id, 1, "source_registered", Object{"sourceId": id, "turnId": snapshot.TurnID})
		return id
	})
}

func (s *Store) QueueStrategyProposal(ctx StrategyContext, key string, input StrategyJobInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		if ctx.ProjectID == "" || input.Scope.Kind != strategy.ProjectScope || input.Kind != "proposal" || len(input.SourceIDs) > 8 {
			strategyFail(400, "invalid_proposal")
		}
		scopeKey := s.strategyAuthorize(ctx, input.Scope)
		strategyFail(410, "execution_retired")
		sources, hash := s.strategySourceSet(ctx, input.SourceIDs)
		input.SourceIDs = sources
		for _, id := range sources {
			kind := s.strategySource(ctx, id, true)["kind"]
			if kind != "user_correction" && kind != "task_outcome" {
				strategyFail(400, "unsupported_source")
			}
		}
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "proposal", "input": input, "extractor": strategyExtractorVersion})
		if replayed {
			return result
		}
		effective := s.strategyEffective(ctx)
		if !effective.Settings.MasterEnabled || !effective.Settings.LearnEnabled {
			strategyFail(409, "disabled")
		}
		existing := s.row("SELECT id FROM strategyJobs WHERE scopeKey=? AND kind='proposal' AND sourceSetHash=? AND COALESCE(assetId,'')=? AND expectedRevision=? AND globalEpoch=? AND projectEpoch=? AND status IN ('queued','leased','awaiting_reconciliation','succeeded') ORDER BY createdAt,id LIMIT 1", scopeKey, hash, input.AssetID, input.ExpectedRevision, effective.GlobalEpoch, effective.ProjectEpoch)
		if existing != nil {
			result = StrategyMutationResult{JobID: stringOf(existing["id"])}
		} else {
			result = s.strategyQueueJob(ctx, "dispatch:"+strategy.ContentHash(key+digest), input)
		}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}

func strategyComparableBody(body string) string {
	return strings.TrimSpace(strings.ReplaceAll(body, "\r\n", "\n"))
}
