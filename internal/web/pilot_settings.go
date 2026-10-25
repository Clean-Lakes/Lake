package web

import (
	"net/http"
	"strings"
)

// Pilot uses the existing SRE enablement source. Defaults are persisted once,
// rather than reinterpreting a user's choice whenever the application opens.
func (s *Store) pilotSettings(project string) Object {
	required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
	row := s.row("SELECT enabled,autoAdvance,revision FROM sreProjectSettings WHERE projectId=?", project)
	return Object{"enabled": integer(row["enabled"]) == 1, "autoAdvance": integer(row["autoAdvance"]) == 1, "revision": integer(row["revision"])}
}

func (s *Store) PilotSettings(project string) Object {
	return s.read(func() any { return s.pilotSettings(project) }).(Object)
}

func (s *Store) UpdatePilotSettings(project string, expected int, enabled, automatic *bool) Object {
	return s.update(func() any {
		current := s.pilotSettings(project)
		if integer(current["revision"]) != expected {
			fail(409, "Lake Pilot 设置已更新，请刷新后重试")
		}
		if enabled != nil {
			current["enabled"] = *enabled
		}
		if automatic != nil {
			current["autoAdvance"] = *automatic
		}
		current["revision"] = expected + 1
		s.exec("INSERT INTO sreProjectSettings(projectId,enabled,autoAdvance,revision,pilotVersion,pilotConfigured) VALUES(?,?,?,?,1,1) ON CONFLICT(projectId) DO UPDATE SET enabled=excluded.enabled,autoAdvance=excluded.autoAdvance,revision=excluded.revision,pilotVersion=1,pilotConfigured=1", project, current["enabled"], current["autoAdvance"], current["revision"])
		s.pilotSettingsEvents(project)
		return current
	}).(Object)
}

func (s *Store) pilotSettingsEvents(project string) {
	for _, row := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
		s.event(stringOf(row["id"]), "session")
	}
}

func (b *Server) assertPilotSettingsIdleLocked(project string) {
	sessions := b.Store.read(func() any { return b.Store.rows("SELECT id FROM sessions WHERE projectId=?", project) }).([]Object)
	for _, session := range sessions {
		id := stringOf(session["id"])
		if b.messageBusyLocked(id) || b.Store.ActiveWorkflowRun(id) != "" {
			fail(409, "项目仍有运行任务，请先暂停后再切换 Lake Pilot")
		}
	}
}

func (b *Server) pilotSettingsRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "pilot" {
		return false
	}
	project := parts[2]
	b.Store.Project(project)
	switch method {
	case "GET":
		reply(w, 200, b.Store.PilotSettings(project))
	case "PUT":
		data := body(w, r, 2048)
		for key := range data {
			if key != "enabled" && key != "autoAdvance" && key != "expectedRevision" {
				fail(400, "不支持的 Lake Pilot 设置字段")
			}
		}
		revision, ok := data["expectedRevision"].(float64)
		if !ok || revision < 0 || revision != float64(int(revision)) {
			fail(400, "expectedRevision 须为非负整数")
		}
		var enabled, automatic *bool
		if value, exists := data["enabled"]; exists {
			v, ok := value.(bool)
			if !ok {
				fail(400, "enabled 须为布尔值")
			}
			enabled = &v
		}
		if value, exists := data["autoAdvance"]; exists {
			v, ok := value.(bool)
			if !ok {
				fail(400, "autoAdvance 须为布尔值")
			}
			automatic = &v
		}
		if enabled == nil && automatic == nil {
			fail(400, "请提供至少一个 Lake Pilot 设置字段")
		}
		b.messageMu.Lock()
		defer b.messageMu.Unlock()
		current := b.Store.PilotSettings(project)
		if enabled != nil && *enabled != current["enabled"] {
			b.assertPilotSettingsIdleLocked(project)
		}
		reply(w, 200, b.Store.UpdatePilotSettings(project, int(revision), enabled, automatic))
	default:
		fail(405, "Method not allowed")
	}
	return true
}
