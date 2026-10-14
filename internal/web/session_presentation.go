package web

import (
	"net/http"
	"strings"
)

const presentationSchema = `
CREATE TABLE IF NOT EXISTS workspaceTags(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL,UNIQUE(projectId,name));
CREATE TABLE IF NOT EXISTS sessionPresentation(sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,icon TEXT NOT NULL DEFAULT 'chat',revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessionTags(sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,tagId TEXT NOT NULL REFERENCES workspaceTags(id) ON DELETE CASCADE,PRIMARY KEY(sessionId,tagId));`

func (s *Store) decorateSession(r Object) {
	p := s.row("SELECT icon,revision FROM sessionPresentation WHERE sessionId=?", r["id"])
	r["icon"], r["presentationRevision"] = "chat", 0
	if p != nil {
		r["icon"], r["presentationRevision"] = p["icon"], p["revision"]
	}
	r["tags"] = s.rows("SELECT t.* FROM workspaceTags t JOIN sessionTags st ON st.tagId=t.id WHERE st.sessionId=? AND t.projectId=? ORDER BY t.name,t.id", r["id"], r["projectId"])
}

func (s *Store) CreateWorkspaceTag(project string, data Object) Object {
	name := text(data["name"], "标签名称", 40)
	color := stringOf(data["color"])
	if !set("gray green blue purple orange red")[color] {
		fail(400, "Invalid tag color")
	}
	return s.update(func() any {
		s.activeProject(project)
		if s.row("SELECT id FROM workspaceTags WHERE projectId=? AND name=?", project, name) != nil {
			fail(409, "标签名称已存在")
		}
		if integer(s.row("SELECT COUNT(*) AS n FROM workspaceTags WHERE projectId=?", project)["n"]) >= 64 {
			fail(400, "每个项目最多 64 个标签")
		}
		id := ident()
		s.exec("INSERT INTO workspaceTags(id,projectId,name,color) VALUES(?,?,?,?)", id, project, name, color)
		return s.row("SELECT * FROM workspaceTags WHERE id=?", id)
	}).(Object)
}

func (s *Store) UpdateWorkspaceTag(id string, data Object) Object {
	name := text(data["name"], "标签名称", 40)
	color := stringOf(data["color"])
	if !set("gray green blue purple orange red")[color] {
		fail(400, "Invalid tag color")
	}
	return s.update(func() any {
		tag := required(s.row("SELECT * FROM workspaceTags WHERE id=?", id), "Tag")
		s.activeProject(stringOf(tag["projectId"]))
		if s.row("SELECT id FROM workspaceTags WHERE projectId=? AND name=? AND id!=?", tag["projectId"], name, id) != nil {
			fail(409, "标签名称已存在")
		}
		s.exec("UPDATE workspaceTags SET name=?,color=? WHERE id=?", name, color, id)
		for _, row := range s.rows("SELECT sessionId FROM sessionTags WHERE tagId=?", id) {
			s.event(stringOf(row["sessionId"]), "session")
		}
		return s.row("SELECT * FROM workspaceTags WHERE id=?", id)
	}).(Object)
}

func (s *Store) DeleteWorkspaceTag(id string) {
	s.update(func() any {
		tag := required(s.row("SELECT * FROM workspaceTags WHERE id=?", id), "Tag")
		s.activeProject(stringOf(tag["projectId"]))
		rows := s.rows("SELECT sessionId FROM sessionTags WHERE tagId=?", id)
		s.exec("DELETE FROM workspaceTags WHERE id=?", id)
		for _, row := range rows {
			s.event(stringOf(row["sessionId"]), "session")
		}
		return nil
	})
}

func (s *Store) SetSessionPresentation(id string, data Object) Object {
	icon := stringOf(data["icon"])
	if !set("chat document terminal server database network code chart bug shield book box")[icon] {
		fail(400, "Invalid session icon")
	}
	raw, ok := data["tagIds"].([]any)
	if !ok || len(raw) > 12 {
		fail(400, "tagIds must contain at most 12 tags")
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, value := range raw {
		tag, ok := value.(string)
		if !ok || tag == "" || seen[tag] {
			fail(400, "Invalid or duplicate tag")
		}
		seen[tag] = true
		tags = append(tags, tag)
	}
	revision, ok := data["revision"].(float64)
	if !ok || revision < 0 || revision != float64(int64(revision)) {
		fail(400, "Presentation revision required")
	}
	return s.update(func() any {
		session := s.session(id)
		if integer(session["presentationRevision"]) != int(revision) {
			fail(409, "会话标签已变更，请刷新后重试")
		}
		for _, tag := range tags {
			if s.row("SELECT id FROM workspaceTags WHERE id=? AND projectId=?", tag, session["projectId"]) == nil {
				fail(404, "Tag not found in session project")
			}
		}
		s.exec("INSERT INTO sessionPresentation(sessionId,icon,revision) VALUES(?,?,1) ON CONFLICT(sessionId) DO UPDATE SET icon=excluded.icon,revision=sessionPresentation.revision+1", id, icon)
		s.exec("DELETE FROM sessionTags WHERE sessionId=?", id)
		for _, tag := range tags {
			s.exec("INSERT INTO sessionTags(sessionId,tagId) VALUES(?,?)", id, tag)
		}
		s.event(id, "session")
		return s.session(id)
	}).(Object)
}

func (b *Server) presentationRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	p := strings.Split(strings.Trim(name, "/"), "/")
	if len(p) == 4 && p[0] == "api" && p[1] == "projects" && p[3] == "tags" && method == "POST" {
		reply(w, 201, b.Store.CreateWorkspaceTag(p[2], body(w, r, 4096)))
		return true
	}
	if len(p) == 3 && p[0] == "api" && p[1] == "tags" {
		if method == "PUT" {
			reply(w, 200, b.Store.UpdateWorkspaceTag(p[2], body(w, r, 4096)))
			return true
		}
		if method == "DELETE" {
			b.Store.DeleteWorkspaceTag(p[2])
			reply(w, 200, Object{"deleted": true})
			return true
		}
	}
	if len(p) == 4 && p[0] == "api" && p[1] == "sessions" && p[3] == "presentation" && method == "PUT" {
		reply(w, 200, b.Store.SetSessionPresentation(p[2], body(w, r, 8192)))
		return true
	}
	return false
}
