package web

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

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

func (e *StrategyError) Error() string     { return e.Code }
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

type StrategyMutationResult struct {
	AssetID          string `json:"assetId,omitempty"`
	Revision         int64  `json:"revision,omitempty"`
	BindingRevision  int64  `json:"bindingRevision,omitempty"`
	SettingsRevision int64  `json:"settingsRevision,omitempty"`
	SourceID         string `json:"sourceId,omitempty"`
	JobID            string `json:"jobId,omitempty"`
}
type StrategyAssetInput struct {
	Title         string
	Kind          strategy.AssetKind
	Body          string
	Applicability strategy.Applicability
}
type StrategyAssetView struct {
	ID       string             `json:"id"`
	Title    string             `json:"title"`
	Scope    strategy.Scope     `json:"scope"`
	Kind     strategy.AssetKind `json:"kind"`
	Revision int64              `json:"revision"`
	Deleted  bool               `json:"deleted"`
}
type StrategyRevisionView struct {
	Asset            StrategyAssetView      `json:"asset"`
	Value            strategy.AssetRevision `json:"value"`
	Available        bool                   `json:"available"`
	SourcesAvailable bool                   `json:"sourcesAvailable"`
}

var strategyTag = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)
var strategySecret = regexp.MustCompile(`(?i)(bearer\s+[a-z0-9._~-]{8,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+|://[^\s/@]+:[^\s/@]+@)`)

func strategySafeText(text string, maxBytes int) {
	if !utf8.ValidString(text) || strings.TrimSpace(text) == "" || len(text) > maxBytes || !ai.SafeMemoryContent(text, ai.Model{}) || strategySecret.MatchString(text) {
		strategyFail(400, "invalid_content")
	}
}
func validateStrategyInput(in StrategyAssetInput) {
	strategySafeText(in.Title, 240)
	if strings.ContainsAny(in.Title, "\r\n") {
		strategyFail(400, "invalid_title")
	}
	strategySafeText(in.Body, strategy.MaxContentBytes)
	for i, values := range [][]string{in.Applicability.Profiles, in.Applicability.ResourceKinds, in.Applicability.DomainTags} {
		if len(values) > 16 {
			strategyFail(400, "invalid_applicability")
		}
		seen := map[string]bool{}
		for _, v := range values {
			valid := strategyTag.MatchString(v)
			if i == 0 {
				valid = set("core terminal2 db-query-editor")[v]
			}
			if i == 1 {
				valid = set("local ssh database docker redis")[v]
			}
			if !valid || seen[v] {
				strategyFail(400, "invalid_applicability")
			}
			seen[v] = true
		}
	}
	sample := strategy.AssetRevision{Ref: strategy.RevisionRef{AssetID: "validation", Revision: 1, ContentHash: strategy.ContentHash(in.Body)}, Kind: in.Kind, Body: in.Body, Verification: strategy.UserConfirmed, SourceIDs: []string{"validation"}}
	if sample.Validate() != nil {
		strategyFail(400, "invalid_asset")
	}
}
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
func (s *Store) strategyAsset(ctx StrategyContext, id string, deleted bool) Object {
	s.strategyContext(ctx)
	a := s.row("SELECT * FROM strategyAssets WHERE id=?", id)
	if a == nil {
		strategyFail(404, "asset_unavailable")
	}
	s.strategyAuthorize(ctx, scopeFromRow(a))
	if !deleted && a["deletedAt"] != "" {
		strategyFail(404, "asset_unavailable")
	}
	return a
}
func assetView(a Object) StrategyAssetView {
	return StrategyAssetView{stringOf(a["id"]), stringOf(a["title"]), scopeFromRow(a), strategy.AssetKind(stringOf(a["kind"])), int64(integer(a["revision"])), stringOf(a["deletedAt"]) != ""}
}
func strategyDecode[T any](text string) T { var v T; must(json.Unmarshal([]byte(text), &v)); return v }
func (s *Store) strategyEvent(scopeKey, accessProject, aggregate string, revision int64, kind string, payload any) {
	s.exec("INSERT INTO strategyEvents(scopeKey,accessProjectId,aggregateId,revision,type,actor,digest,createdAt) VALUES(?,?,?,?,?,'local',?,?)", scopeKey, accessProject, aggregate, revision, kind, strategy.ContentHash(jsonText(payload)), now())
}
func (s *Store) strategyReceipt(key, requestKey string, request any) (StrategyMutationResult, bool, string) {
	if strings.TrimSpace(requestKey) != requestKey || len(requestKey) < 1 || len(requestKey) > 128 {
		strategyFail(400, "invalid_idempotency_key")
	}
	keyHash := strategy.ContentHash(requestKey)
	digest := strategy.ContentHash(jsonText(request))
	row := s.row("SELECT requestHash,result FROM strategyReceipts WHERE scopeKey=? AND keyHash=?", key, keyHash)
	if row == nil {
		return StrategyMutationResult{}, false, digest
	}
	if row["requestHash"] != digest {
		strategyFail(409, "idempotency_conflict")
	}
	return strategyDecode[StrategyMutationResult](stringOf(row["result"])), true, digest
}
func (s *Store) strategySaveReceipt(key, requestKey, digest string, result StrategyMutationResult) {
	s.exec("INSERT INTO strategyReceipts VALUES(?,?,?,?)", key, strategy.ContentHash(requestKey), digest, jsonText(result))
}
func revisionNode(id string, revision int64) string {
	return fmt.Sprintf("revision:%s:%d", id, revision)
}
func (s *Store) strategyNode(id, key, kind, aggregate string, revision int64, source any) {
	s.exec("INSERT INTO strategyLineageNodes VALUES(?,?,?,?,?,?,?)", id, key, kind, aggregate, revision, source, now())
}
func (s *Store) strategyEdge(assetID, from, to, relation string) {
	a := s.row("SELECT * FROM strategyLineageNodes WHERE id=?", from)
	b := s.row("SELECT * FROM strategyLineageNodes WHERE id=?", to)
	if a == nil || b == nil || from == to || stringOf(a["aggregateId"]) != assetID {
		strategyFail(400, "invalid_lineage")
	}
	valid := false
	switch relation {
	case "derived_from":
		valid = a["kind"] == "asset_revision" && b["sourceId"] != nil && s.row("SELECT 1 FROM strategyRevisionSources WHERE assetId=? AND revision=? AND sourceId=?", assetID, a["revision"], b["sourceId"]) != nil
	case "supersedes", "reverted_to":
		valid = a["kind"] == "asset_revision" && b["kind"] == "asset_revision" && b["aggregateId"] == assetID && integer(a["revision"]) > integer(b["revision"])
		if relation == "supersedes" {
			valid = valid && s.row("SELECT 1 FROM strategyRevisions WHERE assetId=? AND revision=? AND parentRevision=?", assetID, a["revision"], b["revision"]) != nil
		}
	case "tested_by":
		valid = a["kind"] == "asset_revision" && b["kind"] == "evaluation" && b["aggregateId"] == assetID && b["sourceId"] != nil && s.row("SELECT 1 FROM strategySourceEvents WHERE id=? AND kind='fixture_evaluation'", b["sourceId"]) != nil
	case "adopted_as":
		valid = a["kind"] == "asset_revision" && b["kind"] == "adoption" && b["aggregateId"] == assetID && a["revision"] == b["revision"]
	case "proposed_to_fix":
		valid = a["kind"] == "attempt" && b["kind"] == "run" && b["aggregateId"] == assetID && s.row("SELECT 1 FROM strategyOptimizationCalls c JOIN strategyExperimentRuns r ON r.experimentId=c.experimentId JOIN strategyJobs j ON j.id=c.experimentId WHERE c.id=? AND r.id=? AND j.assetId=? AND r.variant='baseline_development'", strings.TrimPrefix(from, "attempt:"), strings.TrimPrefix(to, "run:"), assetID) != nil
	case "compared_with":
		valid = a["kind"] == "run" && b["kind"] == "run" && b["aggregateId"] == assetID && s.row("SELECT 1 FROM strategyExperimentRuns x JOIN strategyExperimentRuns y ON y.experimentId=x.experimentId JOIN strategyOptimizations o ON o.jobId=x.experimentId JOIN strategyJobs j ON j.id=o.jobId WHERE x.id=? AND y.id=? AND j.assetId=? AND x.arm='baseline' AND y.arm='assets' AND x.caseId=y.caseId", strings.TrimPrefix(from, "run:"), strings.TrimPrefix(to, "run:"), assetID) != nil
	case "composed_from":
		if b["aggregateId"] != assetID {
			break
		}
		if a["kind"] == "attempt" {
			call := s.row("SELECT c.* FROM strategyOptimizationCalls c JOIN strategyJobs j ON j.id=c.experimentId WHERE c.id=? AND c.stage='synthesize' AND c.status='completed' AND j.assetId=?", strings.TrimPrefix(from, "attempt:"), assetID)
			valid = call != nil && (b["kind"] == "asset_revision" || b["kind"] == "attempt" && s.row("SELECT 1 FROM strategyOptimizationCalls WHERE id=? AND experimentId=? AND stage='propose' AND status='completed'", strings.TrimPrefix(to, "attempt:"), call["experimentId"]) != nil)
		} else if a["kind"] == "asset_revision" && b["kind"] == "attempt" {
			valid = s.row("SELECT 1 FROM strategyRevisions r JOIN strategyOptimizations o ON r.createdBy='optimizer:'||o.jobId JOIN strategyOptimizationCalls c ON c.experimentId=o.jobId AND c.stage='synthesize' WHERE r.assetId=? AND r.revision=? AND c.id=? AND c.status='completed'", assetID, a["revision"], strings.TrimPrefix(to, "attempt:")) != nil
		}
	}
	if !valid {
		strategyFail(400, "invalid_lineage")
	}
	s.exec("INSERT OR IGNORE INTO strategyLineageEdges(aggregateId,fromId,toId,relation,actor,createdAt) VALUES(?,?,?,?,'local',?)", assetID, from, to, relation, now())
}
func (s *Store) strategyManualSource(key, origin, body string) string {
	id := ident()
	s.exec("INSERT INTO strategySourceEvents VALUES(?,?,?,'manual_authoring','','',?,'Manual user confirmation','available',?)", id, key, origin, strategy.ContentHash(body), now())
	s.strategyNode("source:"+id, key, "user_message", "", 0, id)
	return id
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
func (s *Store) strategySourceSet(ctx StrategyContext, ids []string) ([]string, string) {
	if len(ids) < 1 || len(ids) > 32 {
		strategyFail(400, "invalid_sources")
	}
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	items := []Object{}
	for i, id := range ids {
		if id == "" || (i > 0 && ids[i-1] == id) {
			strategyFail(400, "invalid_sources")
		}
		source := s.strategySource(ctx, id, true)
		items = append(items, Object{"id": id, "hash": source["contentHash"]})
	}
	return ids, strategy.ContentHash(jsonText(items))
}
func (s *Store) strategyWriteRevision(ctx StrategyContext, a Object, revision, parent int64, in StrategyAssetInput, sources []string, verification strategy.VerificationLevel, actor string) {
	ids, sourceHash := s.strategySourceSet(ctx, sources)
	s.exec("INSERT INTO strategyRevisions VALUES(?,?,?,?,?,?,?,?,?)", a["id"], revision, parent, strategy.ContentHash(jsonText(in.Applicability)), strategy.ContentHash(in.Body), sourceHash, verification, actor, now())
	s.exec("INSERT INTO strategyRevisionContent VALUES(?,?,?,?)", a["id"], revision, in.Body, jsonText(in.Applicability))
	for _, id := range ids {
		s.exec("INSERT INTO strategyRevisionSources VALUES(?,?,?)", a["id"], revision, id)
	}
	node := revisionNode(stringOf(a["id"]), revision)
	s.strategyNode(node, stringOf(a["scopeKey"]), "asset_revision", stringOf(a["id"]), revision, nil)
	for _, id := range ids {
		s.strategyEdge(stringOf(a["id"]), node, "source:"+id, "derived_from")
	}
	if parent > 0 {
		s.strategyEdge(stringOf(a["id"]), node, revisionNode(stringOf(a["id"]), parent), "supersedes")
	}
	s.exec("UPDATE strategyAssets SET revision=? WHERE id=?", revision, a["id"])
	s.strategyEvent(stringOf(a["scopeKey"]), "", stringOf(a["id"]), revision, "revision_created", Object{"contentHash": strategy.ContentHash(in.Body), "sources": sourceHash})
}
func (s *Store) CreateStrategyAsset(ctx StrategyContext, scope strategy.Scope, key string, in StrategyAssetInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		scopeKey := s.strategyEnsureScope(ctx, scope)
		validateStrategyInput(in)
		request := Object{"operation": "create", "scope": scope, "input": in}
		result, replayed, digest := s.strategyReceipt(scopeKey, key, request)
		if replayed {
			return result
		}
		id := ident()
		s.exec("INSERT INTO strategyAssets(id,scopeKey,kind,title,revision,createdAt) VALUES(?,?,?,?,1,?)", id, scopeKey, in.Kind, in.Title, now())
		a := s.strategyAsset(ctx, id, false)
		source := s.strategyManualSource(scopeKey, "manual:"+strategy.ContentHash(key)+":"+digest, in.Body)
		s.strategyWriteRevision(ctx, a, 1, 0, in, []string{source}, strategy.UserConfirmed, "local_user")
		result = StrategyMutationResult{AssetID: id, Revision: 1, SourceID: source}
		s.strategySaveReceipt(scopeKey, key, digest, result)
		return result
	})
}
func (s *Store) ReviseStrategyAsset(ctx StrategyContext, id, key string, expected, parent int64, in StrategyAssetInput) (StrategyMutationResult, error) {
	return strategyCall(s, true, func() StrategyMutationResult {
		a := s.strategyAsset(ctx, id, false)
		validateStrategyInput(in)
		if in.Kind != strategy.AssetKind(stringOf(a["kind"])) {
			strategyFail(400, "immutable_asset_metadata")
		}
		result, replayed, digest := s.strategyReceipt(stringOf(a["scopeKey"]), key, Object{"operation": "revise", "id": id, "expected": expected, "parent": parent, "input": in})
		if replayed {
			return result
		}
		if expected != int64(integer(a["revision"])) || parent < 1 || parent > expected {
			strategyFail(409, "revision_conflict")
		}
		source := s.strategyManualSource(stringOf(a["scopeKey"]), "manual:"+strategy.ContentHash(key)+":"+digest, in.Body)
		revision := expected + 1
		s.strategyWriteRevision(ctx, a, revision, parent, in, []string{source}, strategy.UserConfirmed, "local_user")
		s.exec("UPDATE strategyAssets SET title=? WHERE id=?", in.Title, id)
		result = StrategyMutationResult{AssetID: id, Revision: revision, SourceID: source}
		s.strategySaveReceipt(stringOf(a["scopeKey"]), key, digest, result)
		return result
	})
}
func (s *Store) GetStrategyRevision(ctx StrategyContext, id string, revision int64) (StrategyRevisionView, error) {
	return strategyCall(s, false, func() StrategyRevisionView { return s.strategyRevisionView(ctx, id, revision) })
}
func (s *Store) strategyRevisionView(ctx StrategyContext, id string, revision int64) StrategyRevisionView {
	a := s.strategyAsset(ctx, id, true)
	r := s.row("SELECT * FROM strategyRevisions WHERE assetId=? AND revision=?", id, revision)
	if r == nil {
		strategyFail(404, "revision_unavailable")
	}
	content := s.row("SELECT body,applicability FROM strategyRevisionContent WHERE assetId=? AND revision=?", id, revision)
	view := StrategyRevisionView{Asset: assetView(a), Available: content != nil, SourcesAvailable: true}
	view.Value = strategy.AssetRevision{Ref: strategy.RevisionRef{AssetID: id, Revision: revision, ContentHash: stringOf(r["contentHash"])}, ParentRevision: int64(integer(r["parentRevision"])), Kind: strategy.AssetKind(stringOf(a["kind"])), Verification: strategy.VerificationLevel(stringOf(r["verification"])), SourceIDs: []string{}}
	if content != nil {
		view.Value.Body = stringOf(content["body"])
		view.Value.Applicability = strategyDecode[strategy.Applicability](stringOf(content["applicability"]))
	}
	for _, row := range s.rows("SELECT sourceId FROM strategyRevisionSources WHERE assetId=? AND revision=? ORDER BY sourceId", id, revision) {
		source := s.strategySource(ctx, stringOf(row["sourceId"]), false)
		view.Value.SourceIDs = append(view.Value.SourceIDs, stringOf(row["sourceId"]))
		view.SourcesAvailable = view.SourcesAvailable && source["availability"] == "available"
	}
	if view.Available && (view.Value.Validate() != nil || strategy.ContentHash(stringOf(content["applicability"])) != r["applicabilityHash"]) {
		strategyFail(500, "revision_integrity_error")
	}
	items := []Object{}
	for _, sourceID := range view.Value.SourceIDs {
		source := s.strategySource(ctx, sourceID, false)
		items = append(items, Object{"id": sourceID, "hash": source["contentHash"]})
	}
	if strategy.ContentHash(jsonText(items)) != r["sourceSetHash"] {
		strategyFail(500, "source_integrity_error")
	}
	return view
}
func (s *Store) ListStrategyAssets(ctx StrategyContext, scope strategy.Scope, after string, limit int) ([]StrategyAssetView, error) {
	return strategyCall(s, false, func() []StrategyAssetView {
		key := s.strategyAuthorize(ctx, scope)
		if limit < 1 || limit > 50 {
			strategyFail(400, "invalid_page")
		}
		out := []StrategyAssetView{}
		for _, a := range s.rows("SELECT * FROM strategyAssets WHERE scopeKey=? AND deletedAt='' AND id>? ORDER BY id LIMIT ?", key, after, limit) {
			out = append(out, assetView(a))
		}
		return out
	})
}
