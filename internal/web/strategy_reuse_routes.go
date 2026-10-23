package web

import (
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"strings"
)

func (b *Server) strategyReuseRoute(w http.ResponseWriter, r *http.Request, ctx StrategyContext, scope strategy.Scope, suffix, key string) bool {
	if suffix != "/usage" && !strings.HasPrefix(suffix, "/usage/") {
		return false
	}
	if ctx.ProjectID == "" {
		strategyFail(404, "project_required")
	}
	sid := r.URL.Query().Get("sessionId")
	if suffix == "/usage" && r.Method == "GET" {
		if sid == "" {
			items := strategyMust(strategyCall(b.Store, false, func() []Object {
				return b.Store.rows("SELECT id,title FROM sessions WHERE projectId=? ORDER BY updatedAt DESC,id LIMIT 50", ctx.ProjectID)
			}))
			reply(w, 200, Object{"sessions": items})
			return true
		}
		strategyMust(strategyCall(b.Store, false, func() bool {
			if b.Store.session(sid)["projectId"] != ctx.ProjectID {
				strategyFail(404, "usage_unavailable")
			}
			return true
		}))
		records, err := b.Engine.StrategyUsageHistory(r.Context(), sid, r.URL.Query().Get("before"), 20)
		if err != nil {
			strategyFail(503, "usage_unavailable")
		}
		items := []Object{}
		for _, m := range records {
			view := Object{"requestId": m.RequestID, "turnId": m.TurnID, "preparedAt": m.PreparedAt, "status": "prepared", "selected": m.SelectedAssets, "omitted": m.OmittedAssets, "reasons": m.AssetSelectionReasons}
			if !b.strategySafeText(jsonText(view)) {
				continue
			}
			feedback := strategyMust(strategyCall(b.Store, false, func() []Object {
				return b.Store.rows("SELECT assetId,revision,contentHash,outcome,feedbackRevision FROM strategyUsageFeedback WHERE projectId=? AND sessionId=? AND requestId=?", ctx.ProjectID, sid, m.RequestID)
			}))
			view["feedback"] = feedback
			items = append(items, view)
		}
		next := ""
		if len(records) == 20 {
			next = records[len(records)-1].RequestID
		}
		reply(w, 200, Object{"items": items, "nextCursor": next})
		return true
	}
	parts := strings.Split(strings.Trim(suffix, "/"), "/")
	if len(parts) == 3 && parts[2] == "feedback" && r.Method == "POST" {
		in := strategyBody[struct {
			SessionID        string               `json:"sessionId"`
			Ref              strategy.RevisionRef `json:"ref"`
			ExpectedRevision int64                `json:"expectedRevision"`
			Outcome          string               `json:"outcome"`
			Suspend          bool                 `json:"suspend"`
		}](r, "sessionId", "ref", "expectedRevision", "outcome", "suspend")
		strategyMust(strategyCall(b.Store, false, func() bool {
			if b.Store.session(in.SessionID)["projectId"] != ctx.ProjectID {
				strategyFail(404, "usage_unavailable")
			}
			return true
		}))
		// Exact request lookup is bounded but not limited to the latest history page.
		m, err := b.Engine.StrategyUsageRequest(r.Context(), in.SessionID, parts[1])
		if err != nil {
			strategyFail(404, "usage_unavailable")
		}
		found := false
		for _, ref := range m.SelectedAssets {
			if ref == in.Ref {
				found = true
			}
		}
		if !found {
			strategyFail(409, "asset_not_in_request")
		}
		result := strategyMust(b.Store.StrategyUsageFeedback(ctx, key, in.SessionID, parts[1], in.Ref, in.ExpectedRevision, in.Outcome, in.Suspend))
		if in.Suspend {
			b.Engine.InvalidateStrategies(ctx.ProjectID)
		}
		reply(w, 200, result)
		return true
	}
	strategyFail(405, "unsupported_operation")
	return true
}
