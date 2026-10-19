package web

import "testing"

func TestBuiltinLocalCannotBeDeletedOrMoved(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	folder := ""
	for _, node := range b.Store.EditResourceTree(project, Object{"operation": "create", "name": "Servers"}) {
		if node["kind"] == "folder" {
			folder = stringOf(node["id"])
		}
	}
	apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "resource", "id": ref}, 409)
	for _, parent := range []string{"", folder} {
		apiTest(t, h, "POST", "/api/projects/"+project+"/resource-tree", Object{"operation": "move", "nodeId": ref, "parentId": parent}, 400)
	}
	remote := b.Store.CreateResource(project, "Remote", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-tree", Object{"operation": "move", "nodeId": remote["id"], "beforeId": ref}, 400)
	apiTest(t, h, "POST", "/api/projects/"+project+"/resource-tree", Object{"operation": "move", "nodeId": remote["id"], "parentId": folder}, 200)
	b.Store.AssertResource(session, ref)
	if node := b.Store.read(func() any { return b.Store.treeNode(project, ref) }).(Object); node["parentId"] != nil {
		t.Fatal("built-in local left root")
	}
	b.Store.EditTerminalResource(ref, "My local shell", Object{"shell": "sh"}, true)
	if b.Store.Resource(ref)["name"] != "My local shell" {
		t.Fatal("shell preferences or name editing were unnecessarily disabled")
	}
	// The built-in resource follows its project lifecycle without preventing project deletion.
	apiTest(t, h, "POST", "/api/navigation-delete", Object{"kind": "project", "id": project}, 200)
	apiTest(t, h, "POST", "/api/navigation-trash", Object{"kind": "project", "id": project}, 200)
	b.Store.AssertResource(session, ref)
}

func TestBuiltinLocalUpgradeRepairsMissingDeletedAndNestedEntries(t *testing.T) {
	b, _ := fixture(t)
	nested := b.Store.CreateProject("Nested")
	deleted := b.Store.CreateProject("Deleted")
	missing := b.Store.CreateProject("Missing")
	hidden := b.Store.CreateProject("Archived project")
	local := func(project Object) string {
		return stringOf(b.Store.read(func() any {
			return b.Store.row("SELECT id FROM resources WHERE projectId=? AND kind='local'", project["id"])
		}).(Object)["id"])
	}
	nestedRef, deletedRef, missingRef, hiddenRef := local(nested), local(deleted), local(missing), local(hidden)
	session := b.Store.CreateSession(stringOf(nested["id"]), "Keep history", nil)
	b.Store.AddMessage(stringOf(session["id"]), "user", "Keep this message", nil)
	b.Store.EditTerminalResource(nestedRef, "Custom local", Object{"shell": "sh"}, true)
	folder := ""
	for _, node := range b.Store.EditResourceTree(stringOf(nested["id"]), Object{"operation": "create", "name": "Old folder"}) {
		if node["kind"] == "folder" {
			folder = stringOf(node["id"])
		}
	}
	// Reproduce persisted layouts from the version where local entries were ordinary resources.
	b.Store.update(func() any {
		b.Store.exec("UPDATE resourceTree SET parentId=? WHERE resourceId=?", folder, nestedRef)
		b.Store.trashEntry("resource", deletedRef, stringOf(deleted["id"]), "Local machine", Object{})
		b.Store.exec("DELETE FROM resourceTree WHERE resourceId=?", deletedRef)
		b.Store.exec("DELETE FROM resourceTree WHERE resourceId=?", missingRef)
		b.Store.exec("DELETE FROM resources WHERE id=?", missingRef)
		b.Store.trashEntry("resource", hiddenRef, stringOf(hidden["id"]), "Local machine", Object{})
		b.Store.exec("DELETE FROM resourceTree WHERE resourceId=?", hiddenRef)
		b.Store.trashEntry("project", stringOf(hidden["id"]), stringOf(hidden["id"]), "Archived project", Object{})
		// A restored old folder must not re-adopt its former local terminal.
		b.Store.trashEntry("folder", "old-folder", stringOf(nested["id"]), "Restored folder", Object{"childrenIds": []string{nestedRef}})
		return nil
	})
	dir := b.Store.Dir
	b.Close()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	for _, project := range []Object{nested, deleted, missing} {
		pid := stringOf(project["id"])
		locals := objects(store.read(func() any { return store.rows("SELECT id FROM resources WHERE projectId=? AND kind='local'", pid) }))
		if len(locals) != 1 {
			t.Fatal("missing or duplicated local entry", len(locals))
		}
		ref := stringOf(locals[0]["id"])
		store.Resource(ref)
		node := store.read(func() any { return store.row("SELECT * FROM resourceTree WHERE resourceId=?", ref) }).(Object)
		if node == nil || node["parentId"] != nil {
			t.Fatal("upgrade did not restore root entry")
		}
	}
	if store.Resource(nestedRef)["name"] != "Custom local" || object(store.Resource(nestedRef)["settings"])["shell"] != "sh" {
		t.Fatal("upgrade lost local identity or preferences")
	}
	store.Resource(deletedRef)
	store.AssertResource(stringOf(session["id"]), nestedRef)
	if len(objects(store.Snapshot(stringOf(session["id"]))["messages"])) != 1 {
		t.Fatal("upgrade changed session history")
	}
	expectPanic(t, 404, func() { store.Resource(hiddenRef) })
	store.RestoreNavigation("project", stringOf(hidden["id"]))
	store.Resource(hiddenRef)
	store.RestoreNavigation("folder", "old-folder")
	if node := store.read(func() any { return store.row("SELECT * FROM resourceTree WHERE resourceId=?", nestedRef) }).(Object); node["parentId"] != nil {
		t.Fatal("restoring an old folder re-nested local terminal")
	}
	before := jsonText(store.Catalog())
	store.update(func() any { store.ensureBuiltinLocalResources(""); store.seedResourceTree(); return nil })
	if jsonText(store.Catalog()) != before {
		t.Fatal("built-in repair is not idempotent")
	}
}
