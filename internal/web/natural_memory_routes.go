package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) naturalMemoryCheck(v any) {
	raw := jsonText(v)
	model := b.Models.Active()
	if model == nil {
		model = &ai.Model{}
	}
	if b.Terminals.containsCredential(raw) || b.Models.strategyContainsProviderSecret(raw) || !ai.SafeMemoryContent(raw, *model) {
		naturalFail(400, "sensitive_content")
	}
}
func (b *Server) naturalMemoryReply(w http.ResponseWriter, v any) {
	b.naturalMemoryCheck(v)
	reply(w, 200, v)
}
func (b *Server) naturalMemoryRoute(w http.ResponseWriter, r *http.Request, path string) (handled bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	var ctx StrategyContext
	var rest []string
	if len(parts) >= 2 && parts[0] == "api" && parts[1] == "natural-memory" {
		rest = parts[2:]
	} else if len(parts) >= 4 && parts[0] == "api" && parts[1] == "projects" && parts[3] == "natural-memory" {
		ctx.ProjectID = parts[2]
		rest = parts[4:]
	} else {
		return false
	}
	handled = true
	defer func() {
		if p := recover(); p != nil {
			status, code := 500, "natural_memory_storage_error"
			switch e := p.(type) {
			case *StrategyError:
				status, code = e.Status, e.Code
			case *Failure:
				status, code = e.Status, "natural_memory_scope_unavailable"
			}
			reply(w, status, Object{"error": "记忆内容或设置已变化，请刷新后重试", "code": code})
		}
	}()
	strategyMust(b.Store.NaturalMemorySettings(ctx)) // Validate the host project before parsing any body.
	suffix := strings.Join(rest, "/")
	method := r.Method
	if len(rest) > 0 && (rest[0] == "legacy" || rest[0] == "preferences" || rest[0] == "changes") {
		reply(w, 410, Object{"error": "旧偏好承接已退出；新自然记忆独立使用", "code": "strategy_assets_retired"})
		return true
	}
	key := r.Header.Get("Idempotency-Key")
	if method != "GET" && (len(key) < 1 || len(key) > 128 || strings.TrimSpace(key) != key) {
		naturalFail(400, "invalid_idempotency_key")
	}
	if suffix == "recall-settings" && method == "PATCH" {
		in := strategyBody[struct {
			ExpectedRevision int  `json:"expectedRevision"`
			UseEnabled       bool `json:"useEnabled"`
		}](r, "expectedRevision", "useEnabled")
		result, err := b.Store.SetNaturalRecallSettings(ctx, key, in.ExpectedRevision, in.UseEnabled)
		if err == nil && !in.UseEnabled {
			b.Engine.InvalidateNaturalRecall(ctx.ProjectID)
		}
		b.naturalMemoryReply(w, strategyMust(result, err))
		return true
	}
	if suffix == "settings" {
		switch method {
		case "GET":
			b.naturalMemoryReply(w, strategyMust(b.Store.NaturalMemorySettings(ctx)))
		case "PATCH":
			in := strategyBody[struct {
				ExpectedRevision int  `json:"expectedRevision"`
				AutoEnabled      bool `json:"autoEnabled"`
			}](r, "expectedRevision", "autoEnabled")
			b.messageMu.Lock()
			result, err := b.Store.SetNaturalMemorySettings(ctx, key, in.ExpectedRevision, in.AutoEnabled)
			if err == nil && !in.AutoEnabled {
				b.pauseNaturalScope(ctx)
			}
			b.messageMu.Unlock()
			b.naturalMemoryReply(w, strategyMust(result, err))
		default:
			naturalFail(405, "method_unavailable")
		}
		return true
	}
	if method == "GET" {
		after := r.URL.Query().Get("after")
		limit := memoryQueryInt(r, "limit", 20)
		if limit < 1 || limit > 50 {
			naturalFail(400, "invalid_page")
		}
		switch suffix {
		case "consolidation":
			b.naturalMemoryReply(w, strategyMust(b.Store.NaturalConsolidationStatus(ctx)))
			return true
		case "conflicts":
			b.naturalMemoryReply(w, strategyMust(b.Store.NaturalConflicts(ctx, after, limit)))
			return true
		case "formed-preferences":
			b.naturalMemoryReply(w, strategyMust(b.Store.NaturalFormedPreferences(ctx, after, limit)))
			return true
		case "formed-changes":
			b.naturalMemoryReply(w, strategyMust(b.Store.NaturalPreferenceChanges(ctx, after, limit)))
			return true
		case "project-entries":
			if ctx.ProjectID == "" {
				b.naturalMemoryReply(w, Object{"items": []Object{}, "total": 0})
				return true
			}
			list := b.Store.ListProjectMemories(ctx.ProjectID, r.URL.Query().Get("query"), memoryQueryInt(r, "offset", 0), limit, true, false)
			// Reuse the version-specific adapter and its exact existing classification.
			list["adapter"] = "project_memory"
			b.naturalMemoryReply(w, list)
			return true
		}
	}
	if len(rest) == 3 && rest[0] == "conflicts" && rest[2] == "reject" && method == "POST" {
		in := strategyBody[struct {
			ExpectedRevision int `json:"expectedRevision"`
		}](r, "expectedRevision")
		b.naturalMemoryReply(w, strategyMust(b.Store.RejectNaturalConflict(ctx, rest[1], key, in.ExpectedRevision)))
		return true
	}
	if len(rest) >= 2 && rest[0] == "formed-preferences" {
		if method == "GET" && len(rest) == 2 {
			b.naturalMemoryReply(w, strategyMust(b.Store.ReadNaturalFormedPreference(ctx, rest[1], 0)))
			return true
		}
		if method == "GET" && len(rest) == 4 && rest[2] == "revisions" {
			n, err := strconv.Atoi(rest[3])
			if err != nil || n < 1 {
				naturalFail(400, "invalid_revision")
			}
			b.naturalMemoryReply(w, strategyMust(b.Store.ReadNaturalFormedPreference(ctx, rest[1], n)))
			return true
		}
		if method == "POST" && len(rest) == 3 && rest[2] == "forget" {
			in := strategyBody[struct {
				ExpectedRevision int `json:"expectedRevision"`
			}](r, "expectedRevision")
			result, err := b.Store.ForgetNaturalPreference(ctx, rest[1], key, in.ExpectedRevision)
			if err == nil {
				b.registerNaturalCaptureCleanup(ctx, rest[1])
				b.Engine.InvalidateNaturalRecall(ctx.ProjectID)
			}
			b.naturalMemoryReply(w, strategyMust(result, err))
			return true
		}
	}
	if len(rest) >= 2 && rest[0] == "formed-changes" {
		if method == "GET" && len(rest) == 2 {
			b.naturalMemoryReply(w, strategyMust(b.Store.NaturalPreferenceChange(ctx, rest[1])))
			return true
		}
		if method == "POST" && len(rest) == 3 && rest[2] == "undo" {
			in := strategyBody[struct {
				ExpectedRevision int `json:"expectedRevision"`
			}](r, "expectedRevision")
			result, err := b.Store.UndoNaturalPreference(ctx, rest[1], key, in.ExpectedRevision)
			if err == nil {
				b.Engine.InvalidateNaturalRecall(ctx.ProjectID)
			}
			b.naturalMemoryReply(w, strategyMust(result, err))
			return true
		}
		if method == "POST" && len(rest) == 3 && rest[2] == "dismiss" {
			strategyBody[struct{}](r)
			b.naturalMemoryReply(w, strategyMust(b.Store.DismissNaturalPreferenceNotice(ctx, rest[1])))
			return true
		}
	}
	if len(rest) == 2 && rest[0] == "project-entries" && method == "GET" {
		if ctx.ProjectID == "" {
			naturalFail(404, "entry_unavailable")
		}
		b.naturalMemoryReply(w, b.Store.ReadProjectMemory(ctx.ProjectID, rest[1], false))
		return true
	}
	naturalFail(405, "method_unavailable")
	return true
}

func (b *Server) registerNaturalCaptureCleanup(ctx StrategyContext, id string) {
	rows, err := strategyCall(b.Store, false, func() []Object {
		scope := b.Store.strategyAuthorize(ctx, naturalScope(ctx))
		if b.Store.row("SELECT id FROM naturalPreferenceEntries WHERE id=? AND scopeKey=?", id, scope) == nil {
			return nil
		}
		return b.Store.rows("SELECT sourceSession FROM naturalPreferenceSupports WHERE entryId=? UNION SELECT sourceSession FROM naturalPreferenceRevisions WHERE entryId=? UNION SELECT sourceSession FROM naturalPreferenceConflicts WHERE entryId=?", id, id, id)
	})
	if err == nil {
		for _, row := range rows {
			b.registerMemoryOutbox(stringOf(row["sourceSession"]))
		}
	}
}
