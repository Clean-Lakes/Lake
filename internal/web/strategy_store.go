package web

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// StrategyContext is resolved by a trusted host, never decoded from model/API
// arguments. Empty ProjectID is the local user's global view, not all projects.
// P2 adds repository methods only; P3 must authenticate every HTTP entrypoint.
type StrategyContext struct {
	ProjectID string `json:"-"`
}

type StrategyError struct {
	Status int
	Code   string
}

func (e *StrategyError) Error() string { return e.Code }

func strategyFail(status int, code string) { panic(&StrategyError{status, "strategy_" + code}) }

func strategyCall[T any](s *Store, write bool, fn func() T) (out T, err error) {
	defer func() {
		if p := recover(); p != nil {
			switch v := p.(type) {
			case *StrategyError:
				err = v
			case *Failure:
				err = &StrategyError{v.Status, "strategy_scope_unavailable"}
			default:
				err = &StrategyError{500, "strategy_storage_error"}
			}
		}
	}()
	work := func() any { return fn() }
	if write {
		out = s.update(work).(T)
	} else {
		out = s.read(work).(T)
	}
	return
}

var strategySecret = regexp.MustCompile(`(?i)(bearer\s+[a-z0-9._~-]{8,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+|://[^\s/@]+:[^\s/@]+@)`)

func strategyScopeKey(scope strategy.Scope) string {
	if scope.Validate() != nil {
		strategyFail(400, "invalid_scope")
	}
	if scope.Kind == strategy.UserScope {
		return "user"
	}
	return "project:" + scope.ProjectID
}

func scopeFromRow(row Object) strategy.Scope {
	if stringOf(row["scopeKey"]) == "user" {
		return strategy.Scope{Kind: strategy.UserScope}
	}
	return strategy.Scope{Kind: strategy.ProjectScope, ProjectID: strings.TrimPrefix(stringOf(row["scopeKey"]), "project:")}
}

func (s *Store) strategyContext(ctx StrategyContext) {
	if ctx.ProjectID != "" {
		s.activeProject(ctx.ProjectID)
	}
}

func (s *Store) strategyAuthorize(ctx StrategyContext, scope strategy.Scope) string {
	s.strategyContext(ctx)
	key := strategyScopeKey(scope)
	if scope.Kind == strategy.ProjectScope && scope.ProjectID != ctx.ProjectID {
		strategyFail(404, "scope_unavailable")
	}
	return key
}

func (s *Store) strategyEnsureScope(ctx StrategyContext, scope strategy.Scope) string {
	key := s.strategyAuthorize(ctx, scope)
	if scope.Kind == strategy.ProjectScope {
		s.exec("INSERT OR IGNORE INTO strategyScopes(scopeKey,kind,projectId,owner) VALUES(?,'project',?,'local')", key, scope.ProjectID)
	}
	return key
}

func strategyDecode[T any](text string) T { var v T; must(json.Unmarshal([]byte(text), &v)); return v }

func (s *Store) strategyEvent(scopeKey, accessProject, aggregate string, revision int64, kind string, payload any) {
	s.exec("INSERT INTO strategyEvents(scopeKey,accessProjectId,aggregateId,revision,type,actor,digest,createdAt) VALUES(?,?,?,?,?,'local',?,?)", scopeKey, accessProject, aggregate, revision, kind, strategy.ContentHash(jsonText(payload)), now())
}

func (s *Store) strategySource(ctx StrategyContext, id string, requireAvailable bool) Object {
	source := s.row("SELECT * FROM strategySourceEvents WHERE id=?", id)
	if source == nil {
		strategyFail(404, "source_unavailable")
	}
	s.strategyAuthorize(ctx, scopeFromRow(source))
	if source["availability"] == "available" && source["messageId"] != "" {
		msg := s.row("SELECT m.text,m.role,x.projectId FROM messages m JOIN sessions x ON x.id=m.sessionId WHERE m.id=? AND m.sessionId=?", source["messageId"], source["sessionId"])
		if msg == nil || msg["role"] != "user" || strategy.ContentHash(stringOf(msg["text"])) != source["contentHash"] || "project:"+stringOf(msg["projectId"]) != source["scopeKey"] {
			source["availability"] = "tombstoned"
		}
	}
	if source["availability"] == "available" && source["kind"] == "task_outcome" {
		turn := s.row("SELECT t.*,m.text,m.role,x.projectId AS actualProject FROM strategyLearningTurns t LEFT JOIN messages m ON m.id=t.userMessageId LEFT JOIN sessions x ON x.id=t.sessionId WHERE t.sourceId=?", id)
		valid := turn != nil && turn["snapshotJSON"] != "" && turn["role"] == "user" && turn["actualProject"] == turn["projectId"] && strategy.ContentHash(stringOf(turn["text"])) == turn["userHash"]
		if valid {
			snapshot := strategyDecode[ai.StrategyTurnSnapshot](stringOf(turn["snapshotJSON"]))
			valid = ai.ValidStrategySnapshot(snapshot) && snapshot.SnapshotHash == source["contentHash"] && snapshot.UserMessageID == turn["userMessageId"] && snapshot.SessionID == turn["sessionId"] && snapshot.TurnID == turn["turnId"] && snapshot.ProjectID == turn["projectId"]
		}
		if !valid {
			source["availability"] = "tombstoned"
		}
	}
	if requireAvailable && source["availability"] != "available" {
		strategyFail(409, "source_unavailable")
	}
	return source
}
