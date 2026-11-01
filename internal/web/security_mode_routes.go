package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
)

func (b *Server) securityModeRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/security/mode" {
		return false
	}
	b.protect(r)
	if !b.authorized(r) {
		fail(401, "Authentication required")
	}
	if b.Engine == nil {
		fail(503, "Security runtime unavailable")
	}
	projects := []string{}
	b.Store.read(func() any {
		for _, row := range b.Store.rows("SELECT id FROM projects WHERE " + activeProjectsSQL + " ORDER BY id") {
			projects = append(projects, stringOf(row["id"]))
		}
		return nil
	})
	if r.Method == http.MethodGet {
		status, err := b.Engine.SecurityMode(r.Context(), projects)
		aiFailure(err)
		reply(w, 200, status)
		return true
	}
	if r.Method != http.MethodPost {
		fail(405, "Method not allowed")
	}
	data := body(w, r, 8192)
	memoryFields(data, "actionId", "expectedRevision", "mode", "confirmedDigest", "confirmedShadowDifferences")
	if _, present := data["expectedRevision"]; !present {
		fail(400, "expectedRevision required")
	}
	var action ai.SecurityModeAction
	securityDecode(data, &action)
	if action.Mode != "shadow" && action.Mode != "enforced" {
		fail(400, "Invalid security mode")
	}
	action.ActorID = "local-user"
	status, err := b.Engine.SetSecurityMode(r.Context(), action, projects)
	aiFailure(err)
	reply(w, 200, status)
	return true
}
