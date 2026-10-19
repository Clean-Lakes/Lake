package web

import (
	"strings"
	"testing"
)

func TestNavigationResourceArchiveScopeHistoryAndRestore(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ref := stringOf(b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})["id"])
	project := stringOf(b.Store.Session(id)["projectId"])
	resource := b.Store.CreateResource(project, "db fixture", "database", Object{"driver": "mysql", "host": "localhost", "port": 3306, "credentialRef": "synthetic-private-reference"})
	rid := stringOf(resource["id"])
	message := b.Store.AddMessage(id, "user", "history preserved", nil)
	archive := func(kind, rid string, status int) {
		apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": kind, "id": rid}, status)
	}
	archive("resource", rid, 200)
	expectPanic(t, 404, func() { b.Store.Resource(rid) })
	expectPanic(t, 404, func() { b.Store.AssertResource(id, rid) })
	if len(stringsOf(b.Store.Session(id)["resourceIds"])) != 2 {
		t.Fatal("deleted resource still available")
	}
	trash := apiTest(t, h, "GET", "/api/navigation-trash", nil, 200)
	if strings.Contains(jsonText(trash), "synthetic-private-reference") {
		t.Fatal("trash exposes connection settings")
	}
	b.Store.update(func() any { b.Store.seedResourceTree(); return nil })
	for _, node := range objects(b.Store.Catalog()["resourceTree"]) {
		if node["resourceId"] == rid {
			t.Fatal("deleted resource reseeded")
		}
	}
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "resource", "id": rid}, 200)
	if b.Store.Resource(rid)["name"] != resource["name"] || object(b.Store.Resource(rid)["settings"])["credentialRef"] != "synthetic-private-reference" {
		t.Fatal("restoration lost identity or credentials")
	}
	if objects(b.Store.Snapshot(id)["messages"])[0]["id"] != message["id"] {
		t.Fatal("history changed")
	}
	originalOrder := jsonText(b.Store.Catalog()["resourceTree"])
	archive("resource", ref, 200)
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "resource", "id": ref}, 200)
	b.Store.AssertResource(id, ref)
	if jsonText(b.Store.Catalog()["resourceTree"]) != originalOrder {
		t.Fatal("restoration changed sibling order")
	}
	b.Store.Status(id, "investigating")
	archive("resource", rid, 409)
	b.Store.Status(id, "completed")
	term := b.Store.CreateTerminal(id, rid)
	archive("resource", rid, 409)
	b.Store.TerminalStatus(id, stringOf(term["id"]), "disconnected")
	archive("resource", rid, 200)
	dir := b.Store.Dir
	b.Close()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	expectPanic(t, 404, func() { store.Resource(rid) })
	store.RestoreNavigation("resource", rid)
	store.AssertResource(id, rid)
}
func TestNavigationFoldersAllLevelsPromoteAndRestore(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ref := stringOf(b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})["id"])
	project := stringOf(b.Store.Session(id)["projectId"])
	folder := func(name, parent string) string {
		for _, node := range b.Store.EditResourceTree(project, Object{"operation": "create", "name": name, "parentId": parent}) {
			if node["name"] == name {
				return stringOf(node["id"])
			}
		}
		t.Fatal("folder missing")
		return ""
	}
	parent := folder("parent", "")
	child := folder("child", parent)
	b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": ref, "parentId": child})
	b.Store.EditResourceTree(project, Object{"operation": "delete", "nodeId": child})
	b.Store.AssertResource(id, ref)
	node := b.Store.read(func() any { return b.Store.treeNode(project, ref) }).(Object)
	if node["parentId"] != parent {
		t.Fatal("folder deletion lost contents")
	}
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "folder", "id": child}, 200)
	node = b.Store.read(func() any { return b.Store.treeNode(project, ref) }).(Object)
	if node["parentId"] != child {
		t.Fatal("restoration did not regroup unchanged children")
	}
	b.Store.EditResourceTree(project, Object{"operation": "delete", "nodeId": parent})
	b.Store.RestoreNavigation("folder", parent)
	if b.Store.read(func() any { return b.Store.treeNode(project, child) }).(Object)["parentId"] != parent {
		t.Fatal("root folder restore failed")
	}
	foreign := b.Store.CreateProject("foreign")
	expectPanic(t, 403, func() {
		b.Store.EditResourceTree(stringOf(foreign["id"]), Object{"operation": "delete", "nodeId": child})
	})
}
func TestNavigationProjectArchiveRestoresScopeAndBlocksMutation(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	ref := stringOf(b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})["id"])
	project := stringOf(b.Store.Session(id)["projectId"])
	b.Store.AddMessage(id, "user", "keep this history", nil)
	apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "project", "id": project}, 200)
	catalog := b.Store.Catalog()
	if len(objects(catalog["projects"])) != 0 || len(objects(catalog["resources"])) != 0 || len(objects(catalog["sessions"])) != 0 || len(objects(catalog["resourceTree"])) != 0 {
		t.Fatal("project not hidden atomically")
	}
	expectPanic(t, 404, func() { b.Store.CreateResource(project, "bad", "local", Object{}) })
	expectPanic(t, 404, func() { b.Store.CreateSession(project, "bad", nil) })
	expectPanic(t, 404, func() { b.Store.Session(id) })
	expectPanic(t, 404, func() { b.Store.Resource(ref) })
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "project", "id": project}, 200)
	b.Store.AssertResource(id, ref)
	if len(objects(b.Store.Snapshot(id)["messages"])) != 1 {
		t.Fatal("project archive lost conversations")
	}
	apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "resource", "id": ref}, 200)
	apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "project", "id": project}, 200)
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "resource", "id": ref}, 409)
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "project", "id": project}, 200)
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "resource", "id": ref}, 200)
	b.Store.AssertResource(id, ref)
}

func TestNavigationArchiveIgnoresUnusableBoundProposals(t *testing.T) {
	for _, lost := range []bool{false, true} {
		name := "closed terminal"
		if lost {
			name = "missing terminal"
		}
		t.Run(name, func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			ref := stringOf(b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})["id"])
			term := b.Store.CreateTerminal(id, ref)
			tid := stringOf(term["id"])
			action := b.Store.AddAction(id, ref, tid, "uptime", "historical proposal")
			b.Store.TerminalStatus(id, tid, "disconnected")
			if lost {
				b.Store.update(func() any {
					b.Store.exec("UPDATE actions SET terminalId='missing-terminal' WHERE id=?", action["id"])
					return nil
				})
			}
			apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "resource", "id": ref}, 200)
			if b.Store.Action(stringOf(action["id"]))["status"] != "pending" {
				t.Fatal("archival changed or executed the historical proposal")
			}
			apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "resource", "id": ref}, 200)
			b.Store.AssertResource(id, ref)
		})
	}
}

func TestNavigationArchiveStillBlocksRunningAndUnboundProposals(t *testing.T) {
	for _, status := range []string{"pending", "running"} {
		t.Run(status, func(t *testing.T) {
			b, h := fixture(t)
			id, _ := newSession(t, h)
			ref := stringOf(b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "SSH fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})["id"])
			term := b.Store.CreateTerminal(id, ref)
			tid := stringOf(term["id"])
			action := b.Store.AddAction(id, ref, tid, "uptime", "active proposal")
			b.Store.TerminalStatus(id, tid, "disconnected")
			b.Store.update(func() any {
				if status == "pending" {
					b.Store.exec("UPDATE actions SET terminalId=NULL WHERE id=?", action["id"])
				} else {
					b.Store.exec("UPDATE actions SET status='running' WHERE id=?", action["id"])
				}
				return nil
			})
			apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "resource", "id": ref}, 409)
			b.Store.AssertResource(id, ref)
		})
	}
}
