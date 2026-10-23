package web

import "sort"

// Navigation metadata never changes a conversation's activity or timestamps.
const sessionNavigationSchema = `
CREATE TABLE IF NOT EXISTS projectSessionNavigation(projectId TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessionNavigation(sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,pinned INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL);`

const sidebarVisibleSessionsSQL = activeSessionsSQL + ` AND NOT EXISTS (SELECT 1 FROM aiScopes a WHERE a.sessionId=sessions.id AND (a.scope='resource-terminal' OR (a.scope='enhanced-terminal' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.sessionId=sessions.id))))`

func (s *Store) decorateSessionNavigation(session Object) {
	row := s.row("SELECT pinned,position FROM sessionNavigation WHERE sessionId=?", session["id"])
	session["pinned"] = row != nil && integer(row["pinned"]) != 0
	if row != nil {
		session["navigationPosition"] = row["position"]
	}
	session["navigationRevision"] = 0
	if revision := s.row("SELECT revision FROM projectSessionNavigation WHERE projectId=?", session["projectId"]); revision != nil {
		session["navigationRevision"] = revision["revision"]
	}
}

func (s *Store) MoveSessionNavigation(project string, data Object) Object {
	id := text(data["sessionId"], "sessionId", 200)
	pinned, ok := data["pinned"].(bool)
	if !ok {
		fail(400, "pinned must be boolean")
	}
	before := ""
	if data["beforeId"] != nil {
		var valid bool
		before, valid = data["beforeId"].(string)
		if !valid || before == "" || before == id {
			fail(400, "Invalid insertion target")
		}
	}
	revision, ok := data["revision"].(float64)
	if !ok || revision < 0 || revision > 1e12 || revision != float64(int64(revision)) {
		fail(400, "Navigation revision required")
	}
	return s.update(func() any {
		s.activeProject(project)
		current := s.row("SELECT revision FROM projectSessionNavigation WHERE projectId=?", project)
		if integer(current["revision"]) != int(revision) {
			fail(409, "会话顺序已更新，请刷新后重试")
		}
		rows := s.rows("SELECT id FROM sessions WHERE projectId=? AND "+sidebarVisibleSessionsSQL, project)
		group := []Object{}
		found, target := false, before == ""
		for _, row := range rows {
			session := s.session(stringOf(row["id"]))
			if row["id"] == id {
				found = true
				continue
			}
			if session["pinned"] == pinned {
				group = append(group, session)
				if row["id"] == before {
					target = true
				}
			}
		}
		if !found || !target {
			fail(404, "会话不在当前项目或目标分组中")
		}
		sort.SliceStable(group, func(i, j int) bool {
			a, b := group[i], group[j]
			if (a["navigationPosition"] == nil) != (b["navigationPosition"] == nil) {
				return a["navigationPosition"] == nil
			}
			if a["navigationPosition"] != nil && integer(a["navigationPosition"]) != integer(b["navigationPosition"]) {
				return integer(a["navigationPosition"]) < integer(b["navigationPosition"])
			}
			if a["updatedAt"] != b["updatedAt"] {
				return stringOf(a["updatedAt"]) > stringOf(b["updatedAt"])
			}
			return stringOf(a["id"]) < stringOf(b["id"])
		})
		ids := []string{}
		for _, row := range group {
			if row["id"] == before {
				ids = append(ids, id)
			}
			ids = append(ids, stringOf(row["id"]))
		}
		if before == "" {
			ids = append(ids, id)
		}
		for position, session := range ids {
			s.exec("INSERT INTO sessionNavigation(sessionId,pinned,position) VALUES(?,?,?) ON CONFLICT(sessionId) DO UPDATE SET pinned=excluded.pinned,position=excluded.position", session, pinned, position)
		}
		s.exec("INSERT INTO projectSessionNavigation(projectId,revision) VALUES(?,1) ON CONFLICT(projectId) DO UPDATE SET revision=revision+1", project)
		s.event(id, "session")
		return s.session(id)
	}).(Object)
}
