package web

func optionalTreeID(value any) string {
	if value == nil {
		return ""
	}
	id, ok := value.(string)
	if !ok || len(id) > 120 {
		fail(400, "目录标识无效")
	}
	return id
}

func (s *Store) treeNode(project, id string) Object {
	n := required(s.row("SELECT * FROM resourceTree WHERE id=?", id), "Resource navigation node")
	if n["projectId"] != project {
		fail(403, "只能整理当前项目的资源")
	}
	return n
}

func (s *Store) treeParent(project, parent, moving string) int {
	depth := 0
	for ; parent != ""; depth++ {
		if depth >= 32 {
			fail(400, "目录层级最多 32 级")
		}
		if parent == moving {
			fail(400, "不能移入自身或子目录")
		}
		n := s.treeNode(project, parent)
		if n["kind"] != "folder" {
			fail(400, "资源不能作为目录")
		}
		parent = stringOf(n["parentId"])
	}
	return depth
}

func (s *Store) treeChildren(project, parent, exclude string) []Object {
	return s.rows("SELECT * FROM resourceTree WHERE projectId=? AND COALESCE(parentId,'')=? AND id!=? ORDER BY position,id", project, parent, exclude)
}

func (s *Store) treeOrder(nodes []Object) {
	for i, n := range nodes {
		s.exec("UPDATE resourceTree SET position=? WHERE id=?", i, n["id"])
	}
}

func (s *Store) seedResourceTree() {
	for _, r := range s.rows("SELECT r.id,r.projectId FROM resources r LEFT JOIN resourceTree n ON n.resourceId=r.id WHERE n.id IS NULL AND NOT EXISTS(SELECT 1 FROM navigationTrash d WHERE (d.kind='resource' AND d.id=r.id) OR (d.kind='project' AND d.id=r.projectId)) ORDER BY r.rowid") {
		position := integer(s.row("SELECT COALESCE(MAX(position),-1)+1 AS next FROM resourceTree WHERE projectId=? AND parentId IS NULL", r["projectId"])["next"])
		s.exec("INSERT INTO resourceTree(id,projectId,kind,resourceId,position) VALUES(?,?,'resource',?,?)", r["id"], r["projectId"], r["id"], position)
	}
}

// Navigation edits do not modify resources, connection settings or session
// bindings. A removed folder promotes its children instead of deleting them.
func (s *Store) EditResourceTree(project string, data Object) []Object {
	return s.update(func() any {
		s.activeProject(project)
		operation := stringOf(data["operation"])
		id, parent, before := optionalTreeID(data["nodeId"]), optionalTreeID(data["parentId"]), optionalTreeID(data["beforeId"])
		switch operation {
		case "create":
			if s.treeParent(project, parent, "") >= 32 {
				fail(400, "目录层级最多 32 级")
			}
			position := len(s.treeChildren(project, parent, ""))
			var parentValue any
			if parent != "" {
				parentValue = parent
			}
			s.exec("INSERT INTO resourceTree(id,projectId,parentId,kind,name,position) VALUES(?,?,?,'folder',?,?)", ident(), project, parentValue, text(data["name"], "目录名称", 120), position)
		case "rename":
			n := s.treeNode(project, id)
			if n["kind"] != "folder" {
				fail(400, "这里只能修改目录名称")
			}
			s.exec("UPDATE resourceTree SET name=? WHERE id=?", text(data["name"], "目录名称", 120), id)
		case "move":
			n := s.treeNode(project, id)
			if s.builtinLocalNode(n) {
				fail(400, "本地终端为内置入口，固定在资源根目录，不能移动")
			}
			parentDepth := s.treeParent(project, parent, id)
			height := integer(s.row("WITH RECURSIVE subtree(id,depth) AS (SELECT id,1 FROM resourceTree WHERE id=? UNION ALL SELECT n.id,t.depth+1 FROM resourceTree n JOIN subtree t ON n.parentId=t.id) SELECT MAX(depth) AS height FROM subtree", id)["height"])
			if parentDepth+height > 32 {
				fail(400, "目录层级最多 32 级")
			}
			if before == id {
				fail(400, "排序目标不能是自身")
			}
			if before != "" {
				target := s.treeNode(project, before)
				if s.builtinLocalNode(target) {
					fail(400, "本地终端固定在资源列表顶部，请选择其他排序位置")
				}
				if stringOf(target["parentId"]) != parent {
					fail(400, "排序目标不属于目标目录")
				}
			}
			oldParent := stringOf(n["parentId"])
			var parentValue any
			if parent != "" {
				parentValue = parent
			}
			s.exec("UPDATE resourceTree SET parentId=? WHERE id=?", parentValue, id)
			children := s.treeChildren(project, parent, id)
			ordered := []Object{}
			for _, child := range children {
				if child["id"] == before {
					ordered = append(ordered, n)
				}
				ordered = append(ordered, child)
			}
			if before == "" {
				ordered = append(ordered, n)
			}
			s.treeOrder(ordered)
			if oldParent != parent {
				s.treeOrder(s.treeChildren(project, oldParent, ""))
			}
		case "delete":
			n := s.treeNode(project, id)
			if n["kind"] != "folder" {
				fail(400, "移除目录不会删除资源")
			}
			parent = stringOf(n["parentId"])
			children := s.treeChildren(project, id, "")
			payload := Object{"parentId": n["parentId"], "position": n["position"], "childrenIds": []string{}}
			ids := []string{}
			for _, child := range children {
				ids = append(ids, stringOf(child["id"]))
			}
			payload["childrenIds"] = ids
			s.trashEntry("folder", id, project, stringOf(n["name"]), payload)
			ordered := []Object{}
			for _, sibling := range s.treeChildren(project, parent, "") {
				if sibling["id"] == id {
					ordered = append(ordered, children...)
				} else {
					ordered = append(ordered, sibling)
				}
			}
			s.exec("UPDATE resourceTree SET parentId=? WHERE parentId=?", n["parentId"], id)
			s.exec("DELETE FROM resourceTree WHERE id=?", id)
			s.treeOrder(ordered)
		default:
			fail(400, "不支持的目录操作")
		}
		for _, session := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(session["id"]), "session")
		}
		return s.rows("SELECT * FROM resourceTree WHERE projectId=? ORDER BY position,id", project)
	}).([]Object)
}

// fileResource places a freshly created resource under the given folder. A new
// resource starts at the root level, so a folder only needs a move.
func (b *Server) fileResource(project string, resource Object, parent string) {
	if parent == "" {
		return
	}
	b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": stringOf(resource["id"]), "parentId": parent})
}
