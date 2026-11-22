package web

import (
	"net/http"
	"strings"
)

// Keep the previous tag tables for existing databases and legacy imports.
const presentationSchema = `
CREATE TABLE IF NOT EXISTS workspaceTags(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL,UNIQUE(projectId,name));
CREATE TABLE IF NOT EXISTS sessionPresentation(sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,icon TEXT NOT NULL DEFAULT 'chat',revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessionTags(sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,tagId TEXT NOT NULL REFERENCES workspaceTags(id) ON DELETE CASCADE,PRIMARY KEY(sessionId,tagId));`

func (s *Store) decorateSession(r Object) {
	s.decorateSessionNavigation(r)
	p := s.row("SELECT icon,revision FROM sessionPresentation WHERE sessionId=?", r["id"])
	r["icon"], r["presentationRevision"] = "chat", 0
	if p != nil {
		r["icon"], r["presentationRevision"] = p["icon"], p["revision"]
	}
}

func (s *Store) SetSessionPresentation(id string, data Object) Object {
	icon := stringOf(data["icon"])
	if !set("chat document terminal server database network code chart bug shield book box")[icon] {
		fail(400, "Invalid session icon")
	}
	if _, present := data["tagIds"]; present {
		fail(http.StatusGone, "项目标签已移除")
	}
	revision, ok := data["revision"].(float64)
	if !ok || revision < 0 || revision != float64(int64(revision)) {
		fail(400, "Presentation revision required")
	}
	return s.update(func() any {
		session := s.session(id)
		if integer(session["presentationRevision"]) != int(revision) {
			fail(409, "会话图标已变更，请刷新后重试")
		}
		s.exec("INSERT INTO sessionPresentation(sessionId,icon,revision) VALUES(?,?,1) ON CONFLICT(sessionId) DO UPDATE SET icon=excluded.icon,revision=sessionPresentation.revision+1", id, icon)
		s.event(id, "session")
		return s.session(id)
	}).(Object)
}

func (b *Server) presentationRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	p := strings.Split(strings.Trim(name, "/"), "/")
	if len(p) == 4 && p[0] == "api" && p[1] == "projects" && p[3] == "session-navigation" && method == "POST" {
		reply(w, 200, b.Store.MoveSessionNavigation(p[2], body(w, r, 8192)))
		return true
	}
	if len(p) == 4 && p[0] == "api" && p[1] == "sessions" && p[3] == "presentation" && method == "PUT" {
		reply(w, 200, b.Store.SetSessionPresentation(p[2], body(w, r, 8192)))
		return true
	}
	return false
}
