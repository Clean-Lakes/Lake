package web

import (
	"reflect"
	"testing"
)

func TestResourceTreeHierarchyOrderScopeAndPersistence(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ref := stringOf(b.Store.CreateResource(project, "Remote fixture", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})["id"])
	otherResource := b.Store.CreateResource(project, "second fixture", "ssh", Object{})
	otherRef := stringOf(otherResource["id"])
	endpoint := "/api/projects/" + project + "/resource-tree"
	edit := func(data Object, status int) []Object {
		return objects(apiTest(t, h, "POST", endpoint, data, status)["nodes"])
	}
	create := func(name, parent string) string {
		nodes := edit(Object{"operation": "create", "name": name, "parentId": parent}, 200)
		for _, node := range nodes {
			if node["name"] == name {
				return stringOf(node["id"])
			}
		}
		t.Fatal("created folder missing")
		return ""
	}
	a := create("Production", "")
	child := create("Databases", a)
	z := create("Other", "")
	edit(Object{"operation": "move", "nodeId": ref, "parentId": child}, 200)
	edit(Object{"operation": "move", "nodeId": z, "beforeId": otherRef}, 200)
	before := jsonText(b.Store.Catalog()["resourceTree"])
	edit(Object{"operation": "move", "nodeId": a, "parentId": child}, 400)
	edit(Object{"operation": "move", "nodeId": child, "parentId": child}, 400)
	edit(Object{"operation": "move", "nodeId": a, "parentId": otherRef}, 400)
	edit(Object{"operation": "move", "nodeId": z, "beforeId": ref}, 400)
	foreign := b.Store.CreateProject("foreign fixture")
	foreignTree := b.Store.EditResourceTree(stringOf(foreign["id"]), Object{"operation": "create", "name": "Foreign"})
	foreignFolder := ""
	for _, node := range foreignTree {
		if node["kind"] == "folder" {
			foreignFolder = stringOf(node["id"])
		}
	}
	edit(Object{"operation": "move", "nodeId": a, "parentId": foreignFolder}, 403)
	edit(Object{"operation": "rename", "nodeId": foreignFolder, "name": "not allowed"}, 403)
	// Compare only this project's rows; the foreign project was legitimately created.
	var original []Object
	for _, node := range objects(parsed(before)) {
		if node["projectId"] == project {
			original = append(original, node)
		}
	}
	var current []Object
	for _, node := range objects(b.Store.Catalog()["resourceTree"]) {
		if node["projectId"] == project {
			current = append(current, node)
		}
	}
	if !reflect.DeepEqual(objects(parsed(jsonText(original))), objects(parsed(jsonText(current)))) {
		t.Fatal("rejected tree edit partially changed navigation")
	}
	edit(Object{"operation": "rename", "nodeId": child, "name": "Database servers"}, 200)
	edit(Object{"operation": "delete", "nodeId": a}, 200)
	for _, node := range objects(b.Store.Catalog()["resourceTree"]) {
		if node["id"] == child && node["parentId"] != nil {
			t.Fatal("folder removal did not promote children")
		}
		if node["id"] == ref && node["parentId"] != child {
			t.Fatal("resource identity/location was lost")
		}
	}
	edit(Object{"operation": "delete", "nodeId": ref}, 400)
	b.Store.AssertResource(id, ref)
	if len(stringsOf(b.Store.Session(id)["resourceIds"])) != 3 {
		t.Fatal("folder edits restricted conversation resource references")
	}
	dir := b.Store.Dir
	saved := jsonText(b.Store.Catalog()["resourceTree"])
	b.Close()
	reopened, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if jsonText(reopened.Catalog()["resourceTree"]) != saved {
		t.Fatal("hierarchy/order did not survive restart")
	}
	reopened.AssertResource(id, ref)
}

func TestResourceTreeSeedsLegacyResourcesWithoutResettingLayout(t *testing.T) {
	b, _ := fixture(t)
	project := b.Store.CreateProject("legacy fixture")
	projectID := stringOf(project["id"])
	b.Store.CreateResource(projectID, "Added first", "ssh", Object{})
	b.Store.CreateResource(projectID, "Added second", "ssh", Object{})
	b.Store.update(func() any { b.Store.exec("DELETE FROM resourceTree"); b.Store.seedResourceTree(); return nil })
	rows := objects(b.Store.Catalog()["resourceTree"])
	if len(rows) != 3 {
		t.Fatal("legacy resource migration lost resources")
	}
	for i, node := range rows {
		if node["parentId"] != nil || integer(node["position"]) != i {
			t.Fatal("legacy root order was not retained")
		}
	}
	folders := b.Store.EditResourceTree(projectID, Object{"operation": "create", "name": "Persistent folder"})
	for _, node := range folders {
		if node["kind"] == "folder" {
			b.Store.EditResourceTree(projectID, Object{"operation": "move", "nodeId": rows[1]["id"], "parentId": node["id"]})
			break
		}
	}
	saved := jsonText(b.Store.Catalog()["resourceTree"])
	b.Store.update(func() any { b.Store.seedResourceTree(); return nil })
	if jsonText(b.Store.Catalog()["resourceTree"]) != saved {
		t.Fatal("migration reset an existing folder placement")
	}
}

func TestResourceTreeMovePreservesDepthLimitForWholeSubtree(t *testing.T) {
	b, _ := fixture(t)
	project := b.Store.CreateProject("depth fixture")
	pid := stringOf(project["id"])
	parent := ""
	first := ""
	for depth := 0; depth < 32; depth++ {
		nodes := b.Store.EditResourceTree(pid, Object{"operation": "create", "name": "nested", "parentId": parent})
		for _, node := range nodes {
			if node["kind"] == "folder" && stringOf(node["parentId"]) == parent {
				parent = stringOf(node["id"])
				break
			}
		}
		if depth == 0 {
			first = parent
		}
	}
	expectPanic(t, 400, func() {
		b.Store.EditResourceTree(pid, Object{"operation": "create", "name": "too deep", "parentId": parent})
	})
	expectPanic(t, 400, func() {
		b.Store.EditResourceTree(pid, Object{"operation": "move", "nodeId": first, "parentId": parent})
	})
	for _, node := range b.Store.EditResourceTree(pid, Object{"operation": "create", "name": "outside"}) {
		if node["name"] == "outside" {
			expectPanic(t, 400, func() {
				b.Store.EditResourceTree(pid, Object{"operation": "move", "nodeId": first, "parentId": node["id"]})
			})
		}
	}
}
