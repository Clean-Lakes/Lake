package web

import (
	"testing"
)

// A resource created from a folder row must land in that folder, and an
// unknown or cross-project folder must be rejected instead of silently
// dropping the resource at the root level.
func TestCreateResourceFilesIntoRequestedFolder(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	resourceEndpoint := "/api/projects/" + project + "/resources"
	treeEndpoint := "/api/projects/" + project + "/resource-tree"

	edit := func(data Object, status int) []Object {
		return objects(apiTest(t, h, "POST", treeEndpoint, data, status)["nodes"])
	}
	folderID := ""
	for _, node := range edit(Object{"operation": "create", "name": "Production", "parentId": ""}, 200) {
		if stringOf(node["name"]) == "Production" {
			folderID = stringOf(node["id"])
		}
	}
	if folderID == "" {
		t.Fatal("folder missing after create")
	}

	created := apiTest(t, h, "POST", resourceEndpoint, Object{"kind": "ssh", "name": "filed host", "parentId": folderID, "ssh": Object{"host": "10.7.7.7", "port": 22, "username": "deploy", "authMethod": "password", "password": "Synthetic-folder-password"}}, 201)
	resourceID := stringOf(created["id"])

	filed := false
	for _, node := range objects(b.Store.Catalog()["resourceTree"]) {
		if stringOf(node["resourceId"]) == resourceID {
			filed = stringOf(node["parentId"]) == folderID
		}
	}
	if !filed {
		t.Fatal("resource was not filed into the requested folder")
	}

	// Root-level creation stays unchanged when no folder is requested.
	rooted := apiTest(t, h, "POST", resourceEndpoint, Object{"kind": "ssh", "name": "root host", "ssh": Object{"host": "10.7.7.8", "port": 22, "username": "deploy", "authMethod": "password", "password": "Synthetic-root-password"}}, 201)
	for _, node := range objects(b.Store.Catalog()["resourceTree"]) {
		if stringOf(node["resourceId"]) == stringOf(rooted["id"]) && stringOf(node["parentId"]) != "" {
			t.Fatal("resource without a folder must stay at the root level")
		}
	}

	// An unknown folder is rejected; the resource must not be created either.
	apiTest(t, h, "POST", resourceEndpoint, Object{"kind": "ssh", "name": "bad folder", "parentId": "missing-folder", "ssh": Object{"host": "10.7.7.10", "port": 22, "username": "deploy", "authMethod": "password", "password": "Synthetic-bad-password"}}, 404)

	other := apiTest(t, h, "POST", "/api/projects", Object{"name": "Other project"}, 201)
	apiTest(t, h, "POST", "/api/projects/"+stringOf(other["id"])+"/resources", Object{"kind": "ssh", "name": "cross project", "parentId": folderID, "ssh": Object{"host": "10.7.7.11", "port": 22, "username": "deploy", "authMethod": "password", "password": "Synthetic-cross-password"}}, 403)
}
