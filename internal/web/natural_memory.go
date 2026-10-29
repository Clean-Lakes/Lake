package web

import (
	"strings"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// Natural preferences are opt-in; the operational V2 gate remains unchanged.
const naturalMemoryAutomaticReady = true
const naturalMemoryPolicyVersion = 2

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
	enabled, consent := false, 0
	if row != nil {
		enabled = integer(row["autoEnabled"]) == 1 && integer(row["consentVersion"]) == naturalMemoryPolicyVersion
		consent = integer(row["consentVersion"])
	}
	out := Object{"scope": scope, "revision": revision, "epoch": epoch, "autoEnabled": enabled, "automaticReady": naturalMemoryAutomaticReady && !s.memoryV2, "consentVersion": consent,
		"policyVersion":         naturalMemoryPolicyVersion,
		"recallSettings":        s.naturalRecallSettings(ctx),
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
		if auto && s.memoryV2 {
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
		s.exec("INSERT INTO naturalMemorySettings VALUES(?,?,?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET revision=excluded.revision,epoch=excluded.epoch,autoEnabled=excluded.autoEnabled,consentVersion=excluded.consentVersion", scope, expected+1, integer(old["epoch"])+1, auto, naturalMemoryPolicyVersion)
		if auto {
			s.exec("INSERT INTO naturalPreferenceConsent VALUES(?,?) ON CONFLICT(scopeKey) DO UPDATE SET enabledAt=excluded.enabledAt", scope, now())
		}
		result := Object{"revision": expected + 1, "epoch": integer(old["epoch"]) + 1, "autoEnabled": auto}
		s.naturalSaveReceipt(scope, key, digest, result)
		return result
	})
}

func boolOf(v any) bool { b, _ := v.(bool); return b }
