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
		domain, active, err := b.Engine.SuperProject(r.Context(), project)
		aiFailure(err)
		workers, err := b.Engine.SuperWorkers(r.Context(), project)
		aiFailure(err)
		reply(w, 200, Object{"active": active, "project": domain, "workers": workers})
	default:
		fail(405, "Method not allowed")
	}
	return true
}
