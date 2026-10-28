package web

import (
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// N1 does not authorize natural extraction or enable the gated operational V2.
const naturalMemoryAutomaticReady = false
const naturalMemoryPolicyVersion = 1

func naturalFail(status int, code string) { panic(&StrategyError{status, "natural_memory_" + code}) }
func naturalScope(ctx StrategyContext) strategy.Scope {
	if ctx.ProjectID == "" {
		return strategy.Scope{Kind: strategy.UserScope}
	}
	return strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
}
func (s *Store) naturalSettings(ctx StrategyContext) Object {
	scope := naturalScope(ctx)
	key := s.strategyAuthorize(ctx, scope)
	row := s.row("SELECT * FROM naturalMemorySettings WHERE scopeKey=?", key)
	revision, epoch := 0, 0
	if row != nil {
		revision = integer(row["revision"])
		epoch = integer(row["epoch"])
	}
	old := s.strategySettings(scope)
	effective := s.strategyEffective(ctx)
	out := Object{"scope": scope, "revision": revision, "epoch": epoch, "autoEnabled": false, "automaticReady": naturalMemoryAutomaticReady, "consentVersion": 0,
		"policyVersion":         naturalMemoryPolicyVersion,
		"preferenceSettings":    Object{"revision": old.Revision, "epoch": old.Epoch, "masterEnabled": old.MasterEnabled, "applyEnabled": old.ApplyEnabled, "effectiveUseEnabled": effective.Settings.MasterEnabled && effective.Settings.ApplyEnabled},
		"projectMemorySettings": nil, "operationalMemoryVersion": 1}
	if ctx.ProjectID != "" {
		out["projectMemorySettings"] = s.memorySettings(ctx.ProjectID)
	}
	if s.memoryV2 {
		out["operationalMemoryVersion"] = 2
	}
	return out
}
func (s *Store) NaturalMemorySettings(ctx StrategyContext) (Object, error) {
	return strategyCall(s, false, func() Object { return s.naturalSettings(ctx) })
}
func (s *Store) naturalReceipt(scope, key string, request any) (Object, string) {
	if len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key {
		naturalFail(400, "invalid_idempotency_key")
	}
	hash := strategy.ContentHash(jsonText(request))
	r := s.row("SELECT * FROM naturalMemoryReceipts WHERE scopeKey=? AND keyHash=?", scope, strategy.ContentHash(key))
	if r == nil {
		return nil, hash
	}
	if r["requestHash"] != hash {
		naturalFail(409, "idempotency_conflict")
	}
	out := strategyDecode[Object](stringOf(r["resultJSON"]))
	out["replayed"] = true
	return out, hash
}
func (s *Store) naturalSaveReceipt(scope, key, digest string, result Object) {
	s.exec("INSERT INTO naturalMemoryReceipts VALUES(?,?,?,?)", scope, strategy.ContentHash(key), digest, jsonText(result))
}
func (s *Store) SetNaturalMemorySettings(ctx StrategyContext, key string, expected int, auto bool) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyEnsureScope(ctx, naturalScope(ctx))
		if auto {
			naturalFail(409, "automatic_not_ready")
		}
		if expected < 0 {
			naturalFail(400, "invalid_revision")
		}
		old := s.naturalSettings(ctx)
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "settings", "expectedRevision": expected, "autoEnabled": auto})
		if replay != nil {
			return replay
		}
		if integer(old["revision"]) != expected {
			naturalFail(409, "revision_conflict")
		}
		s.exec("INSERT INTO naturalMemorySettings VALUES(?,?,?,0,0) ON CONFLICT(scopeKey) DO UPDATE SET revision=excluded.revision,epoch=excluded.epoch,autoEnabled=0,consentVersion=0", scope, expected+1, integer(old["epoch"])+1)
		result := Object{"revision": expected + 1, "epoch": integer(old["epoch"]) + 1, "autoEnabled": false}
		s.naturalSaveReceipt(scope, key, digest, result)
		return result
	})
}

// The token freezes both the adopted version and every legacy selection condition.
// It is never a grant to read another project or to change a runtime binding.
func (s *Store) naturalPreview(ctx StrategyContext, id string) Object {
	scope := naturalScope(ctx)
	key := s.strategyAuthorize(ctx, scope)
	a := s.strategyAsset(ctx, id, true)
	if scopeFromRow(a) != scope {
		naturalFail(404, "entry_unavailable")
	}
	binding := s.row("SELECT * FROM strategyBindings WHERE scopeKey=? AND assetId=?", key, id)
	revision := int64(integer(a["revision"]))
	if binding != nil {
		revision = int64(integer(binding["revision"]))
	}
	v := s.strategyRevisionView(ctx, id, revision)
	reason := ""
	if v.Value.Kind != strategy.UserPreference && v.Value.Kind != strategy.ReportGuidance {
		reason = "method_requires_export"
	}
	if a["deletedAt"] != "" || !v.Available || !v.SourcesAvailable {
		reason = "source_unavailable"
	}
	if v.Review.Decision == "rejected" {
		reason = "rejected"
	}
	if binding == nil || integer(binding["enabled"]) == 0 {
		reason = "not_adopted"
	}
	until, expirationErr := time.Parse(time.RFC3339, v.Reuse.ValidUntil)
	if reason == "" && (v.Reuse.NeedsReview || v.Reuse.ValidUntil != "" && (expirationErr != nil || !time.Now().UTC().Before(until))) {
		reason = "review_required"
	}
	link := s.row("SELECT * FROM naturalMemoryLinks WHERE scopeKey=? AND assetId=?", key, id)
	linkRevision := 0
	if link != nil {
		linkRevision = integer(link["revision"])
	}
	available := v.Available && v.SourcesAvailable && a["deletedAt"] == ""
	title, body := v.Asset.Title, v.Value.Body
	if !available {
		title, body = "", ""
	}
	snapshot := Object{"ref": v.Value.Ref, "binding": binding, "assetRevision": a["revision"], "title": v.Asset.Title, "applicability": v.Value.Applicability, "reuse": v.Reuse, "assessment": v.Assessment, "review": v.Review, "sourcesAvailable": v.SourcesAvailable, "available": available}
	linkState := ""
	if link != nil {
		linkState = stringOf(link["state"])
		if linkState == "mapped" && link["bindingHash"] != strategy.ContentHash(jsonText(snapshot)) {
			linkState = "conflict"
		}
	}
	return Object{"id": id, "linkState": linkState, "scope": scope, "title": title, "body": body, "contentRevision": revision, "contentHash": v.Value.Ref.ContentHash, "assetRevision": a["revision"],
		"applicability": v.Value.Applicability, "reuse": v.Reuse, "assessment": v.Assessment, "verification": v.Value.Verification,
		"binding": binding, "eligible": reason == "", "reason": reason, "previewToken": strategy.ContentHash(jsonText(snapshot)), "linkRevision": linkRevision, "available": available}
}
func (s *Store) PreviewNaturalMemory(ctx StrategyContext, id string) (Object, error) {
	return strategyCall(s, false, func() Object { return s.naturalPreview(ctx, id) })
}
func (s *Store) naturalLinkView(ctx StrategyContext, id string) Object {
	key := s.strategyAuthorize(ctx, naturalScope(ctx))
	link := s.row("SELECT * FROM naturalMemoryLinks WHERE scopeKey=? AND assetId=?", key, id)
	if link == nil {
		naturalFail(404, "entry_unavailable")
	}
	preview := s.naturalPreview(ctx, id)
	state := stringOf(link["state"])
	if state == "mapped" {
		if !boolOf(preview["available"]) {
			state = "unavailable"
		} else if preview["previewToken"] != link["bindingHash"] {
			state = "conflict"
		}
	}
	// Return the mapped exact version, never silently follow a new legacy binding.
	v := s.strategyRevisionView(ctx, id, int64(integer(link["refRevision"])))
	body, title := v.Value.Body, v.Asset.Title
	if !v.Available || !v.SourcesAvailable || v.Asset.Deleted {
		body, title = "", ""
		if state != "undone" {
			state = "unavailable"
		}
	}
	sources := []Object{}
	for _, sourceID := range v.Value.SourceIDs {
		source := s.strategySource(ctx, sourceID, false)
		sources = append(sources, Object{"id": sourceID, "kind": source["kind"], "availability": source["availability"], "contentHash": source["contentHash"]})
	}
	return Object{"id": id, "category": "preference", "adapter": "legacy_binding", "scope": naturalScope(ctx), "revision": link["revision"], "contentRevision": link["refRevision"], "contentHash": link["refHash"],
		"title": title, "body": body, "state": state, "sources": sources, "applicability": v.Value.Applicability, "reuse": v.Reuse, "assessment": v.Assessment,
		"verification": v.Value.Verification, "binding": preview["binding"], "runtime": "existing_strategy_binding", "updatedAt": link["updatedAt"]}
}
func boolOf(v any) bool { b, _ := v.(bool); return b }
func (s *Store) ReadNaturalPreference(ctx StrategyContext, id string) (Object, error) {
	return strategyCall(s, false, func() Object { return s.naturalLinkView(ctx, id) })
}
func (s *Store) ListNaturalPreferences(ctx StrategyContext, after string, limit int) (Object, error) {
	return strategyCall(s, false, func() Object {
		key := s.strategyAuthorize(ctx, naturalScope(ctx))
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		items := []Object{}
		for _, r := range s.rows("SELECT assetId FROM naturalMemoryLinks WHERE scopeKey=? AND assetId>? ORDER BY assetId LIMIT ?", key, after, limit) {
			v := s.naturalLinkView(ctx, stringOf(r["assetId"]))
			delete(v, "body")
			delete(v, "sources")
			items = append(items, v)
		}
		next := ""
		if len(items) == limit {
			next = stringOf(items[len(items)-1]["id"])
		}
		return Object{"items": items, "nextCursor": next}
	})
}
func (s *Store) ListNaturalLegacy(ctx StrategyContext, after string, limit int) (Object, error) {
	return strategyCall(s, false, func() Object {
		key := s.strategyAuthorize(ctx, naturalScope(ctx))
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		items := []Object{}
		for _, r := range s.rows("SELECT id FROM strategyAssets WHERE scopeKey=? AND deletedAt='' AND id>? ORDER BY id LIMIT ?", key, after, limit) {
			v := s.naturalPreview(ctx, stringOf(r["id"]))
			delete(v, "body")
			delete(v, "assessment")
			delete(v, "previewToken")
			items = append(items, v)
		}
		next := ""
		if len(items) == limit {
			next = stringOf(items[len(items)-1]["id"])
		}
		return Object{"items": items, "nextCursor": next}
	})
}
func (s *Store) CarryNaturalPreference(ctx StrategyContext, id, key, token string, expected int) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyEnsureScope(ctx, naturalScope(ctx))
		// Revalidate host ownership and all dependencies even before receipt replay.
		preview := s.naturalPreview(ctx, id)
		if !boolOf(preview["eligible"]) {
			naturalFail(409, "carry_unavailable")
		}
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "carry", "assetId": id, "previewToken": token, "expectedRevision": expected})
		if replay != nil {
			if s.naturalLinkView(ctx, id)["state"] == "unavailable" {
				naturalFail(409, "carry_unavailable")
			}
			return replay
		}
		if expected < 0 || integer(preview["linkRevision"]) != expected || preview["previewToken"] != token {
			naturalFail(409, "preview_conflict")
		}
		old := s.row("SELECT * FROM naturalMemoryLinks WHERE scopeKey=? AND assetId=?", scope, id)
		if old != nil && old["state"] == "mapped" && old["bindingHash"] == token {
			naturalFail(409, "already_mapped")
		}
		// No body, title, source text or secret is duplicated into the new tables.
		s.exec("INSERT INTO naturalMemoryLinks VALUES(?,?,?,?,?,?,'mapped',?) ON CONFLICT(scopeKey,assetId) DO UPDATE SET revision=excluded.revision,refRevision=excluded.refRevision,refHash=excluded.refHash,bindingHash=excluded.bindingHash,state='mapped',updatedAt=excluded.updatedAt", scope, id, expected+1, preview["contentRevision"], preview["contentHash"], token, now())
		after := s.row("SELECT * FROM naturalMemoryLinks WHERE scopeKey=? AND assetId=?", scope, id)
		change := ident()
		s.exec("INSERT INTO naturalMemoryChanges(id,scopeKey,assetId,beforeJSON,afterJSON,kind,createdAt) VALUES(?,?,?,?,?,'carry',?)", change, scope, id, jsonText(old), jsonText(after), now())
		result := Object{"id": id, "revision": expected + 1, "changeId": change}
		s.naturalSaveReceipt(scope, key, digest, result)
		return result
	})
}
func (s *Store) NaturalMemoryChanges(ctx StrategyContext, after string, limit int) (Object, error) {
	return strategyCall(s, false, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		items := s.rows("SELECT id,assetId,kind,createdAt,undoneBy,afterJSON FROM naturalMemoryChanges WHERE scopeKey=? AND id>? ORDER BY id LIMIT ?", scope, after, limit)
		for _, item := range items {
			snapshot := strategyDecode[Object](stringOf(item["afterJSON"]))
			item["revision"] = snapshot["revision"]
			delete(item, "afterJSON")
		}
		next := ""
		if len(items) == limit {
			next = stringOf(items[len(items)-1]["id"])
		}
		return Object{"items": items, "nextCursor": next}
	})
}
func (s *Store) UndoNaturalMemoryCarry(ctx StrategyContext, change, key string, expected int) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyAuthorize(ctx, naturalScope(ctx))
		row := s.row("SELECT * FROM naturalMemoryChanges WHERE id=? AND scopeKey=?", change, scope)
		if row == nil {
			naturalFail(404, "change_unavailable")
		}
		id := stringOf(row["assetId"])
		preview := s.naturalPreview(ctx, id)
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "undo", "changeId": change, "expectedRevision": expected})
		if replay != nil {
			return replay
		}
		link := s.row("SELECT * FROM naturalMemoryLinks WHERE scopeKey=? AND assetId=?", scope, id)
		prior := strategyDecode[Object](stringOf(row["afterJSON"]))
		if row["kind"] != "carry" || row["undoneBy"] != "" || link == nil || integer(link["revision"]) != expected || jsonText(link) != jsonText(prior) || preview["previewToken"] != link["bindingHash"] || !boolOf(preview["eligible"]) {
			naturalFail(409, "undo_conflict")
		}
		undo := ident()
		before := strategyDecode[Object](stringOf(row["beforeJSON"]))
		if before == nil {
			before = Object{"state": "undone", "refRevision": link["refRevision"], "refHash": link["refHash"], "bindingHash": link["bindingHash"]}
		}
		s.exec("UPDATE naturalMemoryLinks SET revision=revision+1,state=?,refRevision=?,refHash=?,bindingHash=?,updatedAt=? WHERE scopeKey=? AND assetId=?", before["state"], before["refRevision"], before["refHash"], before["bindingHash"], now(), scope, id)
		updated := s.row("SELECT * FROM naturalMemoryLinks WHERE scopeKey=? AND assetId=?", scope, id)
		s.exec("INSERT INTO naturalMemoryChanges(id,scopeKey,assetId,beforeJSON,afterJSON,kind,createdAt) VALUES(?,?,?,?,?,'undo',?)", undo, scope, id, jsonText(link), jsonText(updated), now())
		s.exec("UPDATE naturalMemoryChanges SET undoneBy=? WHERE id=?", undo, change)
		result := Object{"id": id, "revision": expected + 1, "changeId": undo}
		s.naturalSaveReceipt(scope, key, digest, result)
		return result
	})
}
