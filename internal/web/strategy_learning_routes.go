package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"net/http"
	"strings"
)

func (b *Server) strategyLearningRoute(w http.ResponseWriter, r *http.Request, ctx StrategyContext, scope strategy.Scope, suffix, key string) bool {
	if !strings.HasPrefix(suffix, "/proposals") && !strings.HasPrefix(suffix, "/sources") {
		return false
	}
	if ctx.ProjectID == "" {
		strategyFail(404, "project_required")
	}
	parts := strings.Split(strings.Trim(suffix, "/"), "/")
	if suffix == "/proposals" {
		if r.Method == "GET" {
			limit := strategyPage(r, "limit", 50)
			if limit < 1 || limit > 50 {
				strategyFail(400, "invalid_page")
			}
			items := strategyMust(strategyCall(b.Store, false, func() []Object {
				out := []Object{}
				for _, job := range b.Store.rows("SELECT id,status,errorCode,attempts,createdAt,updatedAt,runtimeId,dispatchState FROM strategyJobs WHERE accessProjectId=? AND kind='proposal' AND (createdAt,id) < (COALESCE((SELECT createdAt FROM strategyJobs WHERE id=? AND accessProjectId=?),'~'),COALESCE(NULLIF(?,''),'~')) ORDER BY createdAt DESC,id DESC LIMIT ?", ctx.ProjectID, r.URL.Query().Get("after"), ctx.ProjectID, r.URL.Query().Get("after"), limit) {
					job["sourceIds"] = b.Store.strategyJobSources(stringOf(job["id"]))
					if run := b.Store.row("SELECT usageJSON,status,resultJSON FROM strategyProposalRuns WHERE jobId=?", job["id"]); run != nil {
						job["usage"] = strategyDecode[Object](stringOf(run["usageJSON"]))
						job["runStatus"] = run["status"]
						available := strategyValidationCode(func() { b.Store.strategySourceSet(ctx, b.Store.strategyJobSources(stringOf(job["id"]))) }) == ""
						if available && run["resultJSON"] != "" && b.strategySafeText(stringOf(run["resultJSON"])) {
							job["result"] = strategyDecode[strategyProposalResult](stringOf(run["resultJSON"]))
						}
					}
					if asset := b.Store.row("SELECT r.assetId,r.revision FROM strategyRevisions r JOIN strategyAssets a ON a.id=r.assetId WHERE r.createdBy=? AND a.deletedAt='' ORDER BY r.revision DESC LIMIT 1", "job:"+stringOf(job["id"])); asset != nil {
						job["assetId"] = asset["assetId"]
						job["revision"] = asset["revision"]
					}
					out = append(out, job)
				}
				return out
			}))
			next := ""
			if len(items) == int(limit) {
				next = stringOf(items[len(items)-1]["id"])
			}
			reply(w, 200, Object{"items": items, "nextCursor": next})
			return true
		}
		if r.Method == "POST" {
			in := strategyBody[struct {
				SourceIDs        []string `json:"sourceIds"`
				AssetID          string   `json:"assetId"`
				ExpectedRevision int64    `json:"expectedRevision"`
			}](r, "sourceIds", "assetId", "expectedRevision")
			reply(w, 200, strategyMust(b.Store.QueueStrategyProposal(ctx, key, StrategyJobInput{Scope: scope, Kind: "proposal", AssetID: in.AssetID, ExpectedRevision: in.ExpectedRevision, SourceIDs: in.SourceIDs})))
			return true
		}
	}
	if len(parts) == 3 && parts[0] == "proposals" && parts[2] == "cancel" && r.Method == "POST" {
		strategyBody[struct{}](r)
		reply(w, 200, strategyMust(b.Store.CancelStrategyJob(ctx, parts[1], key)))
		return true
	}
	if suffix == "/sources" {
		if r.Method == "GET" {
			limit := strategyPage(r, "limit", 50)
			if limit < 1 || limit > 50 {
				strategyFail(400, "invalid_page")
			}
			items := strategyMust(strategyCall(b.Store, false, func() []Object {
				out := []Object{}
				for _, row := range b.Store.rows("SELECT id FROM strategySourceEvents WHERE scopeKey=? AND kind IN ('user_correction','task_outcome') AND (createdAt,id) < (COALESCE((SELECT createdAt FROM strategySourceEvents WHERE id=? AND scopeKey=?),'~'),COALESCE(NULLIF(?,''),'~')) ORDER BY createdAt DESC,id DESC LIMIT ?", "project:"+ctx.ProjectID, r.URL.Query().Get("after"), "project:"+ctx.ProjectID, r.URL.Query().Get("after"), limit) {
					source := b.Store.strategySource(ctx, stringOf(row["id"]), false)
					view := Object{"id": source["id"], "kind": source["kind"], "sessionId": source["sessionId"], "contentHash": source["contentHash"], "availability": source["availability"], "createdAt": source["createdAt"], "summary": source["summary"]}
					if source["availability"] == "available" {
						var text string
						if source["kind"] == "user_correction" {
							text = stringOf(b.Store.row("SELECT text FROM messages WHERE id=?", source["messageId"])["text"])
						} else {
							turn := b.Store.row("SELECT turnId,userMessageId,snapshotJSON FROM strategyLearningTurns WHERE sourceId=?", source["id"])
							view["turnId"] = turn["turnId"]
							snapshot := strategyDecode[ai.StrategyTurnSnapshot](stringOf(turn["snapshotJSON"]))
							view["outcome"] = snapshot.Status
							view["profile"] = snapshot.Profile
							view["evidence"] = snapshot.Evidence
							text = stringOf(b.Store.row("SELECT text FROM messages WHERE id=?", turn["userMessageId"])["text"])
						}
						if b.strategySafeText(text) {
							view["userText"] = text
						}
					}
					out = append(out, view)
				}
				return out
			}))
			next := ""
			if len(items) == int(limit) {
				next = stringOf(items[len(items)-1]["id"])
			}
			reply(w, 200, Object{"items": items, "nextCursor": next})
			return true
		}
		if r.Method == "POST" {
			in := strategyBody[struct {
				MessageID string `json:"messageId"`
			}](r, "messageId")
			text := strategyMust(strategyCall(b.Store, false, func() string {
				msg := b.Store.row("SELECT m.text FROM messages m JOIN sessions s ON s.id=m.sessionId WHERE m.id=? AND m.role='user' AND s.projectId=?", in.MessageID, ctx.ProjectID)
				if msg == nil {
					strategyFail(404, "source_unavailable")
				}
				return stringOf(msg["text"])
			}))
			if len(text) > 8192 || !b.strategySafeText(text) {
				strategyFail(400, "unsafe_source")
			}
			reply(w, 200, strategyMust(b.Store.RegisterStrategyMessageSource(ctx, in.MessageID, key)))
			return true
		}
	}
	if len(parts) == 2 && parts[0] == "sources" && r.Method == "DELETE" {
		strategyBody[struct{}](r)
		result := strategyMust(b.Store.ForgetStrategySource(ctx, parts[1], key, true))
		b.Engine.InvalidateStrategies(ctx.ProjectID)
		reply(w, 200, result)
		return true
	}
	strategyFail(405, "unsupported_operation")
	return true
}
