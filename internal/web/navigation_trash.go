package web

import (
	"fmt"
	"net/http"
)

const activeProjectsSQL = "NOT EXISTS(SELECT 1 FROM navigationTrash d WHERE d.kind='project' AND d.id=projects.id)"
const activeResourcesSQL = "NOT EXISTS(SELECT 1 FROM navigationTrash d WHERE (d.kind='resource' AND d.id=resources.id) OR (d.kind='project' AND d.id=resources.projectId))"
const activeSessionsSQL = "NOT EXISTS(SELECT 1 FROM navigationTrash d WHERE d.kind='project' AND d.id=sessions.projectId)"

func (s *Store) activeProject(id string) Object {
	return required(s.row("SELECT * FROM projects WHERE id=? AND "+activeProjectsSQL, id), "Project")
}
func (s *Store) trashEntry(kind, id, project, name string, payload Object) {
	s.exec("INSERT OR REPLACE INTO navigationTrash(kind,id,projectId,name,payload,deletedAt) VALUES(?,?,?,?,?,?)", kind, id, project, name, jsonText(payload), now())
}
func (s *Store) trashRows() []Object {
	return s.rows("SELECT d.kind,d.id,d.projectId,d.name,d.deletedAt,p.name AS projectName FROM navigationTrash d JOIN projects p ON p.id=d.projectId ORDER BY d.deletedAt DESC")
}
func (s *Store) NavigationTrash() []Object {
	return s.read(func() any { return s.trashRows() }).([]Object)
}
func (s *Store) projectIdleForDeletion(project string) {
	if s.row("SELECT id FROM sessions WHERE projectId=? AND status IN ('investigating','waiting_approval') LIMIT 1", project) != nil {
		fail(409, "项目中的 AI 正在处理任务，请先停止并等待本轮结束")
	}
	if s.row("SELECT name FROM sqlite_master WHERE type='table' AND name='workflowRuns'") != nil && s.row("SELECT id FROM workflowRuns WHERE projectId=? AND status='running' LIMIT 1", project) != nil {
		fail(409, "请先停止项目中正在运行的工作流")
	}
}
func (s *Store) resourceIdleForDeletion(ref string) {
	s.resourceIdleForChange(ref, "删除")
}
func (s *Store) resourceIdleForChange(ref, operation string) {
	if s.row("SELECT id FROM terminals WHERE resourceId=? AND status!='disconnected' LIMIT 1", ref) != nil {
		fail(409, fmt.Sprintf("资源仍有连接的终端，请先关闭终端后%s", operation))
	}
	// A proposal bound to a closed/missing terminal cannot be approved or replayed.
	// Keep its history, but do not let that stale proposal permanently block trash.
	// Unbound proposals may still select a new terminal; running work always blocks.
	if s.row(`SELECT a.id FROM actions a WHERE a.resourceId=? AND (
		a.status='running' OR (a.status='pending' AND (
			COALESCE(a.terminalId,'')='' OR EXISTS(
				SELECT 1 FROM terminals t WHERE t.id=a.terminalId
				AND t.resourceId=a.resourceId AND t.status!='disconnected'
			)
		))
	) LIMIT 1`, ref) != nil {
		fail(409, fmt.Sprintf("资源仍有待确认或执行中的操作，请先处理后%s", operation))
	}
}
func (s *Store) ArchiveNavigation(kind, id string) {
	s.update(func() any {
		switch kind {
		case "resource":
			resource := s.resource(id)
			if resource["kind"] == "local" {
				fail(409, "本地终端为内置入口，不能删除")
			}
			project := stringOf(resource["projectId"])
			s.projectIdleForDeletion(project)
			s.resourceIdleForDeletion(id)
			// Docker connections can depend on an SSH resource even without an open terminal.
			for _, connection := range s.rows("SELECT resourceId,config FROM resourceConnections WHERE resourceId IN (SELECT id FROM resources WHERE projectId=? AND id!=? AND "+activeResourcesSQL+")", project, id) {
				if object(parsed(stringOf(connection["config"])))["ssh_asset_ref"] == id {
					fail(409, "此 SSH 资源仍被 Docker 连接引用，请先修改该连接")
				}
			}
			node := s.row("SELECT * FROM resourceTree WHERE resourceId=?", id)
			if node == nil {
				node = Object{}
			}
			s.trashEntry(kind, id, project, stringOf(resource["name"]), node)
			// Evidence from a removed resource must not commit after its scope changes.
			s.strategyArchiveProject(project)
			s.ensureMemorySettings(project)
			s.exec("UPDATE projectMemorySettings SET epoch=epoch+1,updatedAt=? WHERE projectId=?", now(), project)
			s.exec("UPDATE projectMemoryJobs SET status='skipped',lastErrorCode='resource_archived',updatedAt=? WHERE turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE projectId=?) AND status IN ('queued','retry_wait','running')", now(), project)
			s.exec("DELETE FROM resourceTree WHERE resourceId=?", id)
			s.treeOrder(s.treeChildren(project, stringOf(node["parentId"]), ""))
		case "project":
			project := s.activeProject(id)
			s.projectIdleForDeletion(id)
			for _, resource := range s.rows("SELECT id FROM resources WHERE projectId=?", id) {
				s.resourceIdleForDeletion(stringOf(resource["id"]))
			}
			s.strategyArchiveProject(id)
			s.ensureMemorySettings(id)
			s.exec("UPDATE projectMemorySettings SET epoch=epoch+1,updatedAt=? WHERE projectId=?", now(), id)
			s.exec("UPDATE projectMemoryJobs SET status='skipped',lastErrorCode='project_archived',updatedAt=? WHERE turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE projectId=?) AND status IN ('queued','retry_wait','running')", now(), id)
			s.trashEntry(kind, id, id, stringOf(project["name"]), Object{})
		default:
			fail(400, "删除对象类型无效")
		}
		project := id
		if kind == "resource" {
			project = stringOf(s.row("SELECT projectId FROM resources WHERE id=?", id)["projectId"])
		}
		for _, session := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(session["id"]), "session")
		}
		return nil
	})
}
func (s *Store) RestoreNavigation(kind, id string) {
	s.update(func() any {
		item := required(s.row("SELECT * FROM navigationTrash WHERE kind=? AND id=?", kind, id), "Deleted entry")
		project := stringOf(item["projectId"])
		payload := object(parsed(stringOf(item["payload"])))
		if kind != "project" {
			if s.row("SELECT 1 FROM navigationTrash WHERE kind='project' AND id=?", project) != nil {
				fail(409, "请先恢复所属项目")
			}
			s.activeProject(project)
		}
		parent := stringOf(payload["parentId"])
		var parentValue any
		if parent != "" && s.row("SELECT id FROM resourceTree WHERE id=? AND projectId=? AND kind='folder'", parent, project) != nil {
			parentValue = parent
		} else {
			parent = ""
		}
		if parent != "" && s.treeParent(project, parent, "") >= 32 {
			parent = ""
			parentValue = nil
		}
		switch kind {
		case "project":
			required(s.row("SELECT id FROM projects WHERE id=?", id), "Project")
		case "resource":
			required(s.row("SELECT id FROM resources WHERE id=? AND projectId=?", id, project), "Resource")
			s.exec("INSERT INTO resourceTree(id,projectId,parentId,kind,resourceId,position) VALUES(?,?,?,'resource',?,?)", id, project, parentValue, id, len(s.treeChildren(project, parent, "")))
		case "folder":
			s.treeParent(project, parent, "")
			s.exec("INSERT INTO resourceTree(id,projectId,parentId,kind,name,position) VALUES(?,?,?,'folder',?,?)", id, project, parentValue, item["name"], len(s.treeChildren(project, parent, "")))
			for _, child := range stringsOf(payload["childrenIds"]) {
				if node := s.row("SELECT * FROM resourceTree WHERE id=? AND projectId=? AND COALESCE(parentId,'')=?", child, project, parent); node != nil && !s.builtinLocalNode(node) {
					height := integer(s.row("WITH RECURSIVE subtree(id,depth) AS (SELECT id,1 FROM resourceTree WHERE id=? UNION ALL SELECT n.id,t.depth+1 FROM resourceTree n JOIN subtree t ON n.parentId=t.id) SELECT MAX(depth) AS height FROM subtree", child)["height"])
					if s.treeParent(project, parent, "")+1+height <= 32 {
						s.exec("UPDATE resourceTree SET parentId=? WHERE id=?", id, child)
					}
				}
			}
			s.treeOrder(s.treeChildren(project, id, ""))
		default:
			fail(400, "恢复对象类型无效")
		}
		if kind != "project" {
			siblings := s.treeChildren(project, parent, id)
			position := integer(payload["position"])
			if position < 0 {
				position = 0
			}
			if position > len(siblings) {
				position = len(siblings)
			}
			ordered := append([]Object{}, siblings[:position]...)
			ordered = append(ordered, Object{"id": id})
			ordered = append(ordered, siblings[position:]...)
			s.treeOrder(ordered)
		}
		s.exec("DELETE FROM navigationTrash WHERE kind=? AND id=?", kind, id)
		if kind == "project" {
			s.ensureBuiltinLocalResources(project)
			s.seedResourceTree()
		}
		for _, session := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(session["id"]), "session")
		}
		return nil
	})
}
func (b *Server) navigationTrashRoute(w http.ResponseWriter, r *http.Request, name string) bool {
	if name != "/api/navigation-trash" && name != "/api/navigation-delete" {
		return false
	}
	if name == "/api/navigation-trash" && r.Method == "GET" {
		reply(w, 200, Object{"items": b.Store.NavigationTrash()})
		return true
	}
	if r.Method != "POST" {
		fail(405, "Method not allowed")
	}
	data := body(w, r, 4096)
	kind, id := stringOf(data["kind"]), text(data["id"], "id", 120)
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	if name == "/api/navigation-delete" {
		project := id
		if kind == "resource" {
			project = stringOf(b.Store.Resource(id)["projectId"])
		}
		for sid, running := range b.runningMessages {
			if running && b.Store.Session(sid)["projectId"] == project {
				fail(409, "请等待本轮任务结束后删除")
			}
		}
		b.Store.ArchiveNavigation(kind, id)
	} else {
		b.Store.RestoreNavigation(kind, id)
	}
	reply(w, 200, Object{"items": b.Store.NavigationTrash()})
	return true
}
