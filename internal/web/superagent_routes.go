package web

import (
	"net/http"
	"strings"
)

func (b *Server) superagentRoute(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
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
			}
		}
		for i := range channels {
			channels[i].NeedsConfirmation = attention[channels[i].ID]
		}
		reply(w, 200, Object{"active": active, "project": domain, "workers": workers, "channels": channels, "cursor": cursor})
	default:
		fail(405, "Method not allowed")
	}
	return true
}
