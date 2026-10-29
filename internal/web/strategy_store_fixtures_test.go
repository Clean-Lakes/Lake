package web

// Historical fixture support only: never compiled into the Lake product.

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/testsupport/legacystrategy"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

type StrategyMutationResult struct {
	AssetID          string `json:"assetId,omitempty"`
	Revision         int64  `json:"revision,omitempty"`
	BindingRevision  int64  `json:"bindingRevision,omitempty"`
	SettingsRevision int64  `json:"settingsRevision,omitempty"`
	SourceID         string `json:"sourceId,omitempty"`
	JobID            string `json:"jobId,omitempty"`
}

type StrategyAssetView struct {
	ID           string             `json:"id"`
	Title        string             `json:"title"`
	Scope        strategy.Scope     `json:"scope"`
	Kind         strategy.AssetKind `json:"kind"`
	Revision     int64              `json:"revision"`
	Deleted      bool               `json:"deleted"`
	ReviewStatus string             `json:"reviewStatus"`
}

type StrategyRevisionView struct {
	Asset            StrategyAssetView          `json:"asset"`
	Value            strategy.AssetRevision     `json:"value"`
	Available        bool                       `json:"available"`
	SourcesAvailable bool                       `json:"sourcesAvailable"`
	Review           StrategyReview             `json:"review"`
	Assessment       strategy.Assessment        `json:"assessment"`
	Reuse            legacystrategy.ReusePolicy `json:"reuse"`
}

var strategyTag = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

func strategySafeText(text string, maxBytes int) {
	if !utf8.ValidString(text) || strings.TrimSpace(text) == "" || len(text) > maxBytes || !ai.SafeMemoryContent(text, ai.Model{}) || strategySecret.MatchString(text) {
		strategyFail(400, "invalid_content")
	}
}

func validateStrategyInput(in StrategyAssetInput) {
	if in.Reuse != nil && in.Reuse.Validate(in.Kind) != nil {
		strategyFail(400, "invalid_reuse_policy")
	}
	if in.Reuse != nil {
		for _, keyword := range in.Reuse.Keywords {
			strategySafeText(keyword, 64)
		}
	}
	strategySafeText(in.Title, 240)
	if strings.ContainsAny(in.Title, "\r\n") {
		strategyFail(400, "invalid_title")
	}
	strategySafeText(in.Body, strategy.MaxContentBytes)
	for _, text := range []string{in.Assessment.Conditions, in.Assessment.Evidence, in.Assessment.Limitations} {
		if text != "" {
			strategySafeText(text, 2000)
		}
	}
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
				valid = set("local ssh database docker redis kubernetes apisix prometheus victoriametrics")[v]
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
	return StrategyAssetView{stringOf(a["id"]), stringOf(a["title"]), scopeFromRow(a), strategy.AssetKind(stringOf(a["kind"])), int64(integer(a["revision"])), stringOf(a["deletedAt"]) != "", ""}
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
		if !valid && a["kind"] == "asset_revision" && b["kind"] == "asset_revision" {
			valid = s.row("SELECT 1 FROM strategyPromotions WHERE assetId=? AND revision=? AND originAssetId=? AND originRevision=?", assetID, a["revision"], b["aggregateId"], b["revision"]) != nil
		}
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
	s.exec("INSERT INTO strategyAssessments VALUES(?,?,?)", a["id"], revision, jsonText(in.Assessment))
	policy := s.strategyDefaultReuse(in.Kind)
	if in.Reuse != nil {
		policy = *in.Reuse
	}
	s.exec("INSERT INTO strategyReusePolicies VALUES(?,?,?,?,?)", a["id"], revision, jsonText(policy), in.ModelHash, jsonText(in.ToolHashes))
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
		sources := []string{source}
		for _, row := range s.rows("SELECT DISTINCT x.id FROM strategyRevisionSources rs JOIN strategySourceEvents x ON x.id=rs.sourceId WHERE rs.assetId=? AND rs.revision IN (?,?) AND x.kind<>'manual_authoring'", id, parent, expected) {
			sources = append(sources, stringOf(row["id"]))
		}
		s.strategyWriteRevision(ctx, a, revision, parent, in, sources, strategy.UserConfirmed, "local_user")
		s.exec("INSERT INTO strategyPromotions SELECT assetId,?,originAssetId,originRevision,originHash FROM strategyPromotions WHERE assetId=? AND revision IN (?,?) ORDER BY revision DESC LIMIT 1", revision, id, parent, expected)
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
	view.Reuse, _, _ = s.strategyReusePolicy(id, revision, view.Value.Kind)
	view.Review = s.strategyReview(id, revision)
	view.Asset.ReviewStatus = s.strategyReview(id, int64(integer(a["revision"]))).Decision
	if row := s.row("SELECT body FROM strategyAssessments WHERE assetId=? AND revision=?", id, revision); row != nil {
		view.Assessment = strategyDecode[strategy.Assessment](stringOf(row["body"]))
	}
	if !s.strategyPromotionAvailable(id, revision) {
		view.SourcesAvailable = false
		view.Available = false
		view.Value.Body = ""
		view.Assessment = strategy.Assessment{}
		view.Reuse = s.strategyDefaultReuse(view.Value.Kind)
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
			v := assetView(a)
			v.ReviewStatus = s.strategyReview(v.ID, v.Revision).Decision
			out = append(out, v)
		}
		return out
	})
}

type StrategyAssetInput struct {
	Title         string
	Kind          strategy.AssetKind
	Body          string
	Applicability strategy.Applicability
	Assessment    strategy.Assessment
	Reuse         *legacystrategy.ReusePolicy
	ModelHash     string
	ToolHashes    map[string]string
}
