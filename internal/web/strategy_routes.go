package web

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

type strategyAssetRequest struct {
	ExpectedRevision int64                  `json:"expectedRevision"`
	ParentRevision   int64                  `json:"parentRevision,omitempty"`
	Title            string                 `json:"title"`
	Kind             strategy.AssetKind     `json:"kind"`
	Body             string                 `json:"body"`
	Applicability    strategy.Applicability `json:"applicability"`
}

func (r strategyAssetRequest) input() StrategyAssetInput {
	return StrategyAssetInput{Title: r.Title, Kind: r.Kind, Body: r.Body, Applicability: r.Applicability}
}
func strategyMust[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func strategyExactKeys(raw json.RawMessage, typ reflect.Type) bool {
	if typ.Kind() == reflect.Pointer {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return true
		}
		return strategyExactKeys(raw, typ.Elem())
	}
	if typ.Kind() != reflect.Struct {
		return true
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	allowed := map[string]reflect.Type{}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		name := strings.Split(f.Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			allowed[name] = f.Type
		}
	}
	for key, value := range fields {
		ft, ok := allowed[key]
		if !ok || !strategyExactKeys(value, ft) {
			return false
		}
	}
	return true
}

// Reject duplicate keys, nulls and trailing documents before strict typed
// decoding; encoding/json alone accepts duplicate keys and missing booleans.
func strategyJSONValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	if t == nil {
		return errors.New("null")
	}
	if delim, ok := t.(json.Delim); ok {
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, e := d.Token()
				if e != nil {
					return e
				}
				k, ok := key.(string)
				if !ok || seen[k] {
					return errors.New("duplicate")
				}
				seen[k] = true
				if e = strategyJSONValue(d); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e := strategyJSONValue(d); e != nil {
					return e
				}
			}
		default:
			return errors.New("invalid JSON")
		}
		_, err = d.Token()
	}
	return err
}
func strategyBody[T any](r *http.Request, required ...string) T {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 128001))
	if err != nil || len(raw) > 128000 {
		strategyFail(400, "invalid_body")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if strategyJSONValue(d) != nil {
		strategyFail(400, "invalid_body")
	}
	if _, e := d.Token(); e != io.EOF {
		strategyFail(400, "invalid_body")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		strategyFail(400, "invalid_body")
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			strategyFail(400, "missing_field")
		}
	}
	var out T
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&out) != nil {
		strategyFail(400, "invalid_body")
	}
	// Also reject case aliases accepted by encoding/json, including nested fields.
	if !strategyExactKeys(raw, reflect.TypeOf(out)) {
		strategyFail(400, "unknown_field")
	}
	if budget, ok := fields["budget"]; ok {
		var entries map[string]json.RawMessage
		_ = json.Unmarshal(budget, &entries)
		if len(entries) != 9 {
			strategyFail(400, "invalid_budget")
		}
	}

	return out
}
func strategyPage(r *http.Request, key string, fallback int64) int64 {
	text := r.URL.Query().Get(key)
	if text == "" {
		return fallback
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil || value < 0 {
		strategyFail(400, "invalid_page")
	}
	return value
}
func (b *Server) strategySafeInput(in StrategyAssetInput) {
	model := b.Models.Active()
	if model == nil {
		model = &ai.Model{}
	}
	raw := jsonText(in)
	if b.Terminals.containsCredential(raw) || !ai.SafeMemoryContent(raw, *model) || b.Models.strategyContainsProviderSecret(raw) {
		strategyFail(400, "sensitive_content")
	}
	validateStrategyInput(in)
}
func (b *Server) strategyRoute(w http.ResponseWriter, r *http.Request, path string) (handled bool) {
	var ctx StrategyContext
	scope := strategy.Scope{Kind: strategy.UserScope}
	suffix := ""
	if path == "/api/strategy" || strings.HasPrefix(path, "/api/strategy/") {
		suffix = strings.TrimPrefix(path, "/api/strategy")
	} else {
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) < 4 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "strategy" {
			return false
		}
		ctx.ProjectID = parts[2]
		scope = strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
		suffix = "/" + strings.Join(parts[4:], "/")
	}
	handled = true
	defer func() {
		if p := recover(); p != nil {
			var e *StrategyError
			switch v := p.(type) {
			case *StrategyError:
				e = v
			case *Failure:
				e = &StrategyError{v.Status, "strategy_scope_unavailable"}
			default:
				e = &StrategyError{500, "strategy_internal_error"}
			}
			message := "策略操作失败，请刷新后重试"
			switch e.Status {
			case 400:
				message = "策略参数或正文无效，请检查必填项、适用条件和敏感内容"
			case 404:
				message = "策略或项目不可用"
			case 409:
				message = "策略版本、来源或幂等请求冲突，请刷新后重试"
			case 405:
				message = "此策略操作尚未提供"
			}
			reply(w, e.Status, Object{"error": message, "code": e.Code})
		}
	}()
	// Validate the host project even for unsupported routes; never read a project
	// from the body, current UI state, asset title or filesystem path.
	strategyMust(b.Store.GetStrategySettings(ctx, scope))
	method := r.Method
	key := r.Header.Get("Idempotency-Key")
	if method != "GET" {
		if len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key {
			strategyFail(400, "invalid_idempotency_key")
		}
	}
	mutated := func(result StrategyMutationResult) {
		b.Engine.InvalidateStrategies(ctx.ProjectID)
		reply(w, 200, result)
	}
	if suffix == "/settings" {
		if method == "GET" {
			settings := strategyMust(b.Store.GetStrategySettings(ctx, scope))
			effective := strategyMust(b.Store.EffectiveStrategySettings(ctx))
			source := "saved"
			if settings.Revision == 0 {
				source = "default"
				if ctx.ProjectID != "" {
					source = "inherited"
				}
			}
			reply(w, 200, Object{"settings": settings, "effective": effective.Settings, "source": source, "capabilities": Object{"apply": true, "learn": true, "correct": true, "correctMode": "snapshots_and_trusted_readonly", "onlineCorrect": true}})
			return
		}
		if method == "PATCH" {
			in := strategyBody[struct {
				ExpectedRevision     int64           `json:"expectedRevision"`
				MasterEnabled        bool            `json:"masterEnabled"`
				ApplyEnabled         bool            `json:"applyEnabled"`
				LearnEnabled         bool            `json:"learnEnabled"`
				CorrectEnabled       bool            `json:"correctEnabled"`
				OnlineCorrectEnabled bool            `json:"onlineCorrectEnabled"`
				Budget               strategy.Budget `json:"budget"`
			}](r, "expectedRevision", "masterEnabled", "applyEnabled", "learnEnabled", "correctEnabled", "budget")
			mutated(strategyMust(b.Store.SetStrategySettings(ctx, scope, key, in.ExpectedRevision, StrategySettingsInput{MasterEnabled: in.MasterEnabled, ApplyEnabled: in.ApplyEnabled, LearnEnabled: in.LearnEnabled, CorrectEnabled: in.CorrectEnabled, OnlineCorrectEnabled: in.OnlineCorrectEnabled, Budget: in.Budget})))
			return
		}
	}
	if suffix == "/assets" {
		if method == "GET" {
			limit := strategyPage(r, "limit", 50)
			if limit < 1 || limit > 50 {
				strategyFail(400, "invalid_page")
			}
			items := strategyMust(b.Store.ListStrategyAssets(ctx, scope, r.URL.Query().Get("after"), int(limit)))
			next := ""
			if len(items) == int(limit) {
				next = items[len(items)-1].ID
			}
			reply(w, 200, Object{"items": items, "nextCursor": next})
			return
		}
		if method == "POST" {
			in := strategyBody[strategyAssetRequest](r, "expectedRevision", "title", "kind", "body", "applicability")
			if in.ExpectedRevision != 0 || in.ParentRevision != 0 {
				strategyFail(400, "invalid_revision")
			}
			b.strategySafeInput(in.input())
			reply(w, 200, strategyMust(b.Store.CreateStrategyAsset(ctx, scope, key, in.input())))
			return
		}
	}
	if suffix == "/imports/skill" && method == "POST" {
		in := strategyBody[struct {
			ExpectedRevision int64                  `json:"expectedRevision"`
			Name             string                 `json:"name"`
			Kind             strategy.AssetKind     `json:"kind"`
			Applicability    strategy.Applicability `json:"applicability"`
		}](r, "expectedRevision", "name", "kind", "applicability")
		if in.ExpectedRevision != 0 {
			strategyFail(400, "invalid_revision")
		}
		meta, content, err := b.Extensions.Store.ReadSkill(in.Name, "")
		if err != nil || !meta.Enabled {
			strategyFail(404, "skill_unavailable")
		}
		asset := StrategyAssetInput{Title: meta.Name, Kind: in.Kind, Body: content, Applicability: in.Applicability}
		b.strategySafeInput(asset)
		reply(w, 200, strategyMust(b.Store.importStrategySkill(ctx, scope, key, in.Name, content, asset)))
		return
	}
	if b.strategyExperimentRoute(w, r, ctx, scope, suffix, key) {
		return
	}
	if b.strategyLearningRoute(w, r, ctx, scope, suffix, key) {
		return
	}
	parts := strings.Split(strings.Trim(suffix, "/"), "/")
	if len(parts) >= 2 && parts[0] == "assets" {
		id := parts[1]
		// Ownership check shared by all handlers. A project can bind a global asset,
		// but edits/deletion go through that asset's explicit owner scope.
		latest := strategyMust(strategyCall(b.Store, false, func() StrategyAssetView { return assetView(b.Store.strategyAsset(ctx, id, true)) }))
		owner := func() {
			if latest.Scope != scope {
				strategyFail(404, "asset_unavailable")
			}
		}
		if len(parts) == 2 && method == "DELETE" {
			owner()
			in := strategyBody[struct {
				ExpectedRevision int64 `json:"expectedRevision"`
			}](r, "expectedRevision")
			mutated(strategyMust(b.Store.DeleteStrategyAsset(ctx, id, key, in.ExpectedRevision)))
			return
		}
		if len(parts) == 3 && parts[2] == "revisions" {
			if method == "GET" {
				before := strategyPage(r, "before", latest.Revision+1)
				limit := strategyPage(r, "limit", 50)
				if limit < 1 || limit > 50 {
					strategyFail(400, "invalid_page")
				}
				refs := strategyMust(strategyCall(b.Store, false, func() []Object {
					out := []Object{}
					for _, row := range b.Store.rows("SELECT revision,parentRevision,contentHash,verification,createdAt FROM strategyRevisions WHERE assetId=? AND revision<? ORDER BY revision DESC LIMIT ?", id, before, limit) {
						out = append(out, row)
					}
					return out
				}))
				next := int64(0)
				if len(refs) == int(limit) {
					next = int64(integer(refs[len(refs)-1]["revision"]))
				}
				reply(w, 200, Object{"asset": latest, "items": refs, "nextCursor": next})
				return
			}
			if method == "POST" {
				owner()
				in := strategyBody[strategyAssetRequest](r, "expectedRevision", "parentRevision", "title", "kind", "body", "applicability")
				b.strategySafeInput(in.input())
				reply(w, 200, strategyMust(b.Store.ReviseStrategyAsset(ctx, id, key, in.ExpectedRevision, in.ParentRevision, in.input())))
				return
			}
		}
		if len(parts) == 4 && parts[2] == "revisions" && method == "GET" {
			version, err := strconv.ParseInt(parts[3], 10, 64)
			if err != nil || version < 1 {
				strategyFail(400, "invalid_revision")
			}
			v := strategyMust(b.Store.GetStrategyRevision(ctx, id, version))
			if v.Available {
				b.strategySafeInput(StrategyAssetInput{Title: v.Asset.Title, Kind: v.Value.Kind, Body: v.Value.Body, Applicability: v.Value.Applicability})
			}
			status := strategyMust(strategyCall(b.Store, false, func() []Object {
				out := []Object{}
				for _, id := range v.Value.SourceIDs {
					source := b.Store.strategySource(ctx, id, false)
					if source["kind"] == "skill_import" {
						parts := strings.Split(stringOf(source["originKey"]), ":")
						state := "changed"
						name := ""
						if len(parts) == 4 {
							name = parts[1]
							meta, body, e := b.Extensions.Store.ReadSkill(name, "")
							if e == nil && meta.Enabled && strategy.ContentHash(body) == source["contentHash"] {
								state = "unchanged"
							}
						}
						out = append(out, Object{"name": name, "contentHash": source["contentHash"], "state": state})
					}
				}
				return out
			}))
			reply(w, 200, Object{"asset": v.Asset, "value": v.Value, "available": v.Available, "sourcesAvailable": v.SourcesAvailable, "skillSources": status})
			return
		}
		if len(parts) == 3 && parts[2] == "bindings" {
			if method == "GET" {
				binding, err := b.Store.GetStrategyBinding(ctx, scope, id)
				if err != nil {
					var e *StrategyError
					if errors.As(err, &e) && e.Code == "strategy_binding_unavailable" {
						reply(w, 200, Object{"binding": nil})
						return
					}
					panic(err)
				}
				reply(w, 200, Object{"binding": binding})
				return
			}
			if method == "POST" {
				in := strategyBody[struct {
					Action           string               `json:"action"`
					Ref              strategy.RevisionRef `json:"ref"`
					ExpectedRevision int64                `json:"expectedRevision"`
					Priority         int                  `json:"priority"`
					ExclusionGroup   string               `json:"exclusionGroup"`
				}](r, "action", "ref", "expectedRevision", "priority", "exclusionGroup")
				if in.Ref.AssetID != id {
					strategyFail(400, "invalid_binding")
				}
				mutated(strategyMust(b.Store.BindStrategyAsset(ctx, scope, key, StrategyBindingInput{in.Action, in.Ref, in.ExpectedRevision, in.Priority, in.ExclusionGroup})))
				return
			}
		}
		if len(parts) == 3 && parts[2] == "lineage" && method == "GET" {
			limit := strategyPage(r, "limit", 50)
			if limit < 1 || limit > 50 {
				strategyFail(400, "invalid_page")
			}
			reply(w, 200, strategyMust(b.Store.StrategyLineage(ctx, id, strategyPage(r, "cursor", 0), int(limit))))
			return
		}
	}
	strategyFail(405, "unsupported_operation")
	return
}
