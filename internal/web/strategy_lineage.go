package web

import (
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"strings"
)

// Only existing real user messages can be registered here. Tool, evaluation
// and Skill provenance need their own trusted adapters in P4/P5; there is no
// method accepting model-supplied source hashes or verification levels.
func (s *Store) RegisterStrategyMessageSource(ctx StrategyContext, messageID, key string) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		s.strategyContext(ctx)
		if ctx.ProjectID == "" {
			strategyFail(404, "source_unavailable")
		}
		msg := s.row("SELECT m.id,m.text,m.role,m.sessionId,x.projectId FROM messages m JOIN sessions x ON x.id=m.sessionId WHERE m.id=?", messageID)
		if msg == nil || msg["projectId"] != ctx.ProjectID || msg["role"] != "user" {
			strategyFail(404, "source_unavailable")
		}
		scopeKey := s.strategyEnsureScope(ctx, strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID})
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "message_source", "messageId": messageID, "hash": strategy.ContentHash(stringOf(msg["text"]))})
		if replayed {
			s.strategySource(ctx, result.SourceID, true)
			return result
		}
		origin := "message:" + messageID
		source := s.row("SELECT id FROM strategySourceEvents WHERE scopeKey=? AND originKey=?", scopeKey, origin)
		if source != nil {
			s.strategySource(ctx, stringOf(source["id"]), true)
			result.SourceID = stringOf(source["id"])
		} else {
			id := ident()
			s.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'user_correction',?,?,?,'User message reference','available',?)", id, scopeKey, origin, msg["sessionId"], messageID, strategy.ContentHash(stringOf(msg["text"])), now())
			s.strategyNode("source:"+id, scopeKey, "correction", "", 0, id)
			result.SourceID = id
			s.strategyEvent(scopeKey, ctx.ProjectID, id, 1, "source_registered", Object{"sourceId": id})
		}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}
func (s *Store) ForgetStrategySource(ctx StrategyContext, id, key string, revoke bool) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		source := s.strategySource(ctx, id, false)
		scopeKey := stringOf(source["scopeKey"])
		result, replayed, digest := s.strategyReceipt(scopeKey, key, Object{"operation": "forget_source", "id": id, "revoke": revoke})
		if replayed {
			return result
		}
		status := "tombstoned"
		if revoke {
			status = "revoked"
		}
		s.exec("UPDATE strategySourceEvents SET availability=?,summary='' WHERE id=?", status, id)
		if source["kind"] == "fixture_evaluation" && strings.HasPrefix(stringOf(source["originKey"]), "experiment:") {
			experiment := strings.TrimPrefix(stringOf(source["originKey"]), "experiment:")
			s.eraseStrategyExperiments("jobId=?", experiment)
			s.strategyInvalidateJobs("id=?", experiment)
		}
		s.exec("UPDATE strategyLearningTurns SET snapshotJSON='' WHERE sourceId=?", id)
		s.eraseStrategyExperiments("jobId IN (SELECT jobId FROM strategyJobSources WHERE sourceId=?)", id)
		s.exec("UPDATE strategyProposalRuns SET resultJSON='' WHERE jobId IN (SELECT jobId FROM strategyJobSources WHERE sourceId=?)", id)
		s.strategyAdvanceScope(scopeKey)
		s.strategyInvalidateJobs("id IN (SELECT jobId FROM strategyJobSources WHERE sourceId=?)", id)
		s.strategyEvent(scopeKey, "", id, s.strategyGeneration(scopeKey), "source_"+status, Object{"sourceId": id})
		result = StrategyMutationResult{SourceID: id}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}

type StrategyLineagePage struct {
	Nodes      []Object `json:"nodes"`
	Edges      []Object `json:"edges"`
	NextCursor int64    `json:"nextCursor"`
	Redacted   bool     `json:"redacted"`
	HasMore    bool     `json:"hasMore"`
}

func (s *Store) StrategyLineage(ctx StrategyContext, id string, cursor int64, limit int) (StrategyLineagePage, error) {
	return strategyCall(s, false, func() StrategyLineagePage {
		s.strategyAsset(ctx, id, true)
		if cursor < 0 || limit < 1 || limit > 50 {
			strategyFail(400, "invalid_page")
		}
		out := StrategyLineagePage{Nodes: []Object{}, Edges: []Object{}, NextCursor: cursor}
		seen := map[string]bool{}
		for _, edge := range s.rows("SELECT * FROM strategyLineageEdges WHERE aggregateId=? AND id>? ORDER BY id LIMIT ?", id, cursor, limit) {
			out.NextCursor = int64(integer(edge["id"]))
			nodes := []Object{}
			visible := true
			for _, endpoint := range []string{stringOf(edge["fromId"]), stringOf(edge["toId"])} {
				n := s.row("SELECT * FROM strategyLineageNodes WHERE id=?", endpoint)
				if n == nil {
					strategyFail(500, "invalid_lineage")
				}
				scope := scopeFromRow(n)
				if scope.Kind == strategy.ProjectScope && scope.ProjectID != ctx.ProjectID {
					visible = false
					continue
				}
				if n["sourceId"] != nil {
					source := s.strategySource(ctx, stringOf(n["sourceId"]), false)
					n["sourceKind"] = source["kind"]
					n["availability"] = source["availability"]
					n["summary"] = source["summary"]
					n["contentHash"] = source["contentHash"]
				}
				nodes = append(nodes, n)
			}
			if !visible {
				out.Redacted = true
				continue
			}
			out.Edges = append(out.Edges, edge)
			for _, n := range nodes {
				nodeID := stringOf(n["id"])
				if !seen[nodeID] {
					seen[nodeID] = true
					out.Nodes = append(out.Nodes, n)
				}
			}
		}
		out.HasMore = s.row("SELECT 1 FROM strategyLineageEdges WHERE aggregateId=? AND id>? LIMIT 1", id, out.NextCursor) != nil
		return out
	})
}

// P2 only exposes metadata from real repository nodes. New relation types need
// their authoritative task/run adapters; this method cannot invent endpoints.
func (s *Store) AddStrategyLineage(ctx StrategyContext, id, key, from, to, relation string) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		a := s.strategyAsset(ctx, id, false)
		if relation != "derived_from" && relation != "supersedes" {
			strategyFail(400, "invalid_lineage")
		}
		for _, endpoint := range []string{from, to} {
			n := s.row("SELECT * FROM strategyLineageNodes WHERE id=?", endpoint)
			if n == nil {
				strategyFail(404, "lineage_unavailable")
			}
			s.strategyAuthorize(ctx, scopeFromRow(n))
			if n["sourceId"] != nil {
				s.strategySource(ctx, stringOf(n["sourceId"]), true)
			}
		}
		result, replayed, digest := s.strategyReceipt(stringOf(a["scopeKey"]), key, Object{"operation": "lineage", "id": id, "from": from, "to": to, "relation": relation})
		if replayed {
			return result
		}
		s.strategyEdge(id, from, to, relation)
		s.strategyEvent(stringOf(a["scopeKey"]), "", id, int64(integer(a["revision"])), "lineage_added", Object{"from": from, "to": to, "relation": relation})
		result = StrategyMutationResult{AssetID: id, Revision: int64(integer(a["revision"]))}
		s.strategySaveReceipt(stringOf(a["scopeKey"]), key, digest, result)
		return result
	})
}
func (s *Store) PendingStrategyEvents(ctx StrategyContext, after int64, limit int) ([]Object, error) {
	return strategyCall(s, false, func() []Object {
		s.strategyContext(ctx)
		if after < 0 || limit < 1 || limit > 50 {
			strategyFail(400, "invalid_page")
		}
		return s.rows("SELECT * FROM strategyEvents WHERE seq>? AND publishedAt='' AND (scopeKey='user' OR scopeKey=?) AND (accessProjectId='' OR accessProjectId=?) ORDER BY seq LIMIT ?", after, "project:"+ctx.ProjectID, ctx.ProjectID, limit)
	})
}
func (s *Store) AcknowledgeStrategyEvent(ctx StrategyContext, seq int64) (bool, error) {
	return strategyCall(s, true, func() bool {
		s.strategyContext(ctx)
		row := s.row("SELECT * FROM strategyEvents WHERE seq=? AND (scopeKey='user' OR scopeKey=?) AND (accessProjectId='' OR accessProjectId=?)", seq, "project:"+ctx.ProjectID, ctx.ProjectID)
		if row == nil {
			strategyFail(404, "event_unavailable")
		}
		s.exec("UPDATE strategyEvents SET publishedAt=? WHERE seq=? AND publishedAt=''", now(), seq)
		return true
	})
}
