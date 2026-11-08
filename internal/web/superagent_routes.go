package web

import (
	"errors"
	"net/http"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"gorm.io/gorm"
)

func (b *Server) superagentRoute(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 6 && parts[0] == "api" && parts[1] == "projects" && parts[3] == "superagent" && parts[4] == "specialists" {
		b.Store.Project(parts[2])
		if r.Method != "DELETE" {
			fail(405, "Method not allowed")
		}
		revision, valid := body(w, r, 1024)["revision"].(float64)
		if !valid || revision < 0 || revision != float64(int64(revision)) {
			fail(400, "专员版本无效，请刷新后重试")
		}
		err := b.Engine.DeleteSuperSpecialist(r.Context(), parts[2], parts[5], int64(revision))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			fail(404, "专员不存在")
		}
		if errors.Is(err, ai.ErrSpecialistRevision) {
			fail(409, err.Error())
		}
		aiFailure(err)
		reply(w, 200, Object{"deleted": true})
		return true
	}
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "superagent" {
		return false
	}
	project := parts[2]
	b.Store.Project(project)
	switch r.Method {
	case "POST":
		domain, err := b.ensureSuperProject(r.Context(), project)
		aiFailure(err)
		reply(w, 200, domain)
	case "GET":
		cursor := b.Store.read(func() any {
			return integer(b.Store.row("SELECT COALESCE(MAX(seq),0) AS n FROM events")["n"])
		})
		domain, active, err := b.Engine.SuperProject(r.Context(), project)
		aiFailure(err)
		if active {
			b.reconcileSuperSessionRoles(domain)
		}
		workers, err := b.Engine.SuperWorkers(r.Context(), project)
		aiFailure(err)
		for _, worker := range workers {
			b.ensureSuperWorkerSession(project, worker.SessionID, worker.Task.Title)
		}
		channels := b.reconcileSpecialistChannels(r.Context(), project)
		attention := map[string]bool{}
		responding := map[string]bool{}
		waiting, err := b.Engine.SuperInteractionSessions(r.Context(), project)
		aiFailure(err)
		b.Store.read(func() any {
			for _, row := range b.Store.rows("SELECT id FROM sessions WHERE projectId=? AND status IN ('waiting_approval','investigating')", project) {
				waiting = append(waiting, stringOf(row["id"]))
			}
			return nil
		})
		seen := map[string]bool{}
		for _, session := range waiting {
			if seen[session] {
				continue
			}
			seen[session] = true
			ch, err := b.Engine.SpecialistChannelForWorker(r.Context(), project, session)
			if err != nil {
				continue
			}
			view, err := b.Engine.Snapshot(session)
			if err == nil && (view.Question != nil || view.Pending != nil || b.hostKeyPrompt(session) != nil) {
				attention[ch.ID] = true
			} else if err == nil && view.ReplyStatus == "running" {
				responding[ch.ID] = true
			}
		}
		for i := range channels {
			channels[i].NeedsConfirmation = attention[channels[i].ID]
			channels[i].Running = channels[i].Running || responding[channels[i].ID]
		}
		b.populateSpecialistReads(project, channels)
		reply(w, 200, Object{"active": active, "project": domain, "workers": workers, "channels": channels, "cursor": cursor})
	default:
		fail(405, "Method not allowed")
	}
	return true
}
