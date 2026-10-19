package web

// Local execution belongs to the application, not to a removable connection.
// Keep existing IDs and settings so historical references and shell preferences
// continue to resolve when recovering an older deleted or nested local entry.
func (s *Store) ensureBuiltinLocalResources(project string) {
	for _, p := range s.rows("SELECT id FROM projects WHERE "+activeProjectsSQL+" AND (?='' OR id=?)", project, project) {
		pid := stringOf(p["id"])
		locals := s.rows("SELECT id FROM resources WHERE projectId=? AND kind='local' ORDER BY rowid", pid)
		if len(locals) == 0 {
			id := ident()
			s.exec("INSERT INTO resources(id,projectId,name,kind,description,status) VALUES(?,?,?,'local',?,'available')", id, pid, "Local machine", "This server's built-in local command terminal (no remote host connection)")
			locals = []Object{{"id": id}}
		}
		for _, resource := range locals {
			id := resource["id"]
			s.exec("DELETE FROM navigationTrash WHERE kind='resource' AND id=?", id)
			if node := s.row("SELECT id,parentId FROM resourceTree WHERE resourceId=?", id); node != nil && stringOf(node["parentId"]) != "" {
				position := len(s.treeChildren(pid, "", ""))
				s.exec("UPDATE resourceTree SET parentId=NULL,position=? WHERE id=?", position, node["id"])
			}
		}
	}
}

func (s *Store) builtinLocalNode(node Object) bool {
	return node["kind"] == "resource" && s.row("SELECT id FROM resources WHERE id=? AND kind='local'", node["resourceId"]) != nil
}
