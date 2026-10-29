package web

import (
	"context"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
)

func (s *Store) naturalRecallSettings(ctx StrategyContext) Object {
	scope := s.strategyAuthorize(ctx, naturalScope(ctx))
	row := s.row("SELECT * FROM naturalRecallSettings WHERE scopeKey=?", scope)
	return Object{"revision": integer(row["revision"]), "useEnabled": integer(row["useEnabled"]) == 1}
}
func (s *Store) SetNaturalRecallSettings(ctx StrategyContext, key string, expected int, enabled bool) (Object, error) {
	return strategyCall(s, true, func() Object {
		scope := s.strategyEnsureScope(ctx, naturalScope(ctx))
		old := s.naturalRecallSettings(ctx)
		replay, digest := s.naturalReceipt(scope, key, Object{"operation": "recall_settings", "expectedRevision": expected, "useEnabled": enabled})
		if replay != nil {
			return replay
		}
		if expected < 0 || integer(old["revision"]) != expected {
			naturalFail(409, "revision_conflict")
		}
		s.exec("INSERT INTO naturalRecallSettings VALUES(?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET revision=excluded.revision,useEnabled=excluded.useEnabled", scope, expected+1, enabled)
		out := Object{"revision": expected + 1, "useEnabled": enabled}
		s.naturalSaveReceipt(scope, key, digest, out)
		return out
	})
}
func (s *Store) recallPreferences(ctx StrategyContext, q ai.NaturalRecallQuery) ([]ai.NaturalRecallItem, error) {
	return strategyCall(s, false, func() []ai.NaturalRecallItem {
		if ctx.ProjectID != "" {
			s.strategyAuthorize(ctx, naturalScope(ctx))
		}
		if q.Offset < 0 || q.Offset > 1000 || len(q.Query) > 256 || len(q.ID) > 128 {
			naturalFail(400, "invalid_page")
		}
		out := []ai.NaturalRecallItem{}
		blocked := map[string]bool{}
		scopes := []string{}
		if ctx.ProjectID != "" && boolOf(s.naturalRecallSettings(ctx)["useEnabled"]) {
			scopes = append(scopes, "project:"+ctx.ProjectID)
		}
		if boolOf(s.naturalRecallSettings(StrategyContext{})["useEnabled"]) {
			scopes = append(scopes, "user")
		}
		for _, scope := range scopes {
			// Metadata scan is bounded; body retrieval is separately limited below.
			for _, entry := range s.rows("SELECT id,topic,revision FROM naturalPreferenceEntries WHERE scopeKey=? AND state='active' ORDER BY id LIMIT 1000", scope) {
				topic, id := stringOf(entry["topic"]), stringOf(entry["id"])
				if scope == "user" && blocked[topic] {
					continue
				}
				if scope != "user" {
					blocked[topic] = true
				}
				if q.ID != "" && q.ID != id {
					continue
				}
				if q.ID != "" && q.Revision != integer(entry["revision"]) {
					naturalFail(409, "revision_conflict")
				}
				view := s.naturalPreferenceView(scope, id, 0)
				if view["state"] != "active" || stringOf(view["body"]) == "" {
					continue
				}
				available := true
				for _, support := range objects(view["sources"]) {
					available = available && boolOf(support["available"])
				}
				if !available {
					continue
				}
				body := stringOf(view["body"])
				if scope == "user" {
					r := s.row("SELECT sourceProject FROM naturalPreferenceRevisions WHERE entryId=? AND revision=?", id, entry["revision"])
					if !s.naturalGlobalTextSafe(stringOf(r["sourceProject"]), body, topic) {
						continue
					}
				}
				if q.Query != "" && !strings.Contains(strings.ToLower(topic+" "+body), strings.ToLower(q.Query)) {
					continue
				}
				name := "project"
				if scope == "user" {
					name = "user"
				}
				out = append(out, ai.NaturalRecallItem{ID: id, Revision: integer(entry["revision"]), Scope: name, Topic: topic, Body: body, Hash: memoryHash(body)})
				if q.ID != "" {
					return out
				}
				if len(out) >= q.Offset+12 {
					break
				}
			}
			if len(out) >= q.Offset+12 {
				break
			}
		}
		if q.ID != "" {
			naturalFail(404, "entry_unavailable")
		}
		if q.Offset >= len(out) {
			return []ai.NaturalRecallItem{}
		}
		return out[q.Offset:]
	})
}
func (b *Server) naturalRecallProvider(ctx context.Context, id string, q ai.NaturalRecallQuery) (out []ai.NaturalRecallItem, err error) {
	defer func() {
		if recover() != nil {
			out = nil
			err = errors.New("memory preference service unavailable")
		}
	}()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	session := b.Store.Session(id)
	if session == nil {
		return nil, errors.New("memory session unavailable")
	}
	out, err = b.Store.recallPreferences(StrategyContext{ProjectID: stringOf(session["projectId"])}, q)
	if err != nil {
		return nil, err
	}
	for _, item := range out {
		if b.Terminals.containsCredential(item.Body) || b.Models.strategyContainsProviderSecret(item.Body) || !ai.SafeMemoryContent(item.Body, ai.Model{}) {
			return nil, errors.New("memory preference contains sensitive content")
		}
	}
	return out, nil
}
