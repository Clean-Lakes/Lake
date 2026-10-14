package web

import (
	"testing"
)

func TestSessionPresentationProjectScopeAndRevision(t *testing.T) {
	b, h := fixture(t)
	p := stringOf(b.Store.CreateProject("Workspace")["id"])
	other := stringOf(b.Store.CreateProject("Other")["id"])
	id := stringOf(b.Store.CreateSession(p, "Database investigation", nil)["id"])
	tag := apiTest(t, h, "POST", "/api/projects/"+p+"/tags", Object{"name": "Database", "color": "purple"}, 201)
	foreign := apiTest(t, h, "POST", "/api/projects/"+other+"/tags", Object{"name": "External", "color": "green"}, 201)
	path := "/api/sessions/" + id + "/presentation"
	apiTest(t, h, "PUT", path, Object{"icon": "database", "tagIds": []string{stringOf(foreign["id"])}, "revision": 0}, 404)
	apiTest(t, h, "PUT", path, Object{"icon": "javascript:alert(1)", "tagIds": []string{}, "revision": 0}, 400)
	apiTest(t, h, "PUT", path, Object{"icon": "database", "tagIds": []string{stringOf(tag["id"]), stringOf(tag["id"])}, "revision": 0}, 400)
	saved := apiTest(t, h, "PUT", path, Object{"icon": "database", "tagIds": []string{stringOf(tag["id"])}, "revision": 0}, 200)
	if saved["icon"] != "database" || len(objects(saved["tags"])) != 1 || integer(saved["presentationRevision"]) != 1 {
		t.Fatal("presentation not saved")
	}
	apiTest(t, h, "PUT", path, Object{"icon": "chat", "tagIds": []string{}, "revision": 0}, 409)
	if b.Store.Session(id)["icon"] != "database" {
		t.Fatal("stale write replaced newer metadata")
	}
	apiTest(t, h, "PUT", "/api/tags/"+stringOf(tag["id"]), Object{"name": "Data", "color": "blue"}, 200)
	if objects(b.Store.Session(id)["tags"])[0]["name"] != "Data" {
		t.Fatal("tag rename missing from session")
	}
	apiTest(t, h, "DELETE", "/api/tags/"+stringOf(tag["id"]), nil, 200)
	if len(objects(b.Store.Session(id)["tags"])) != 0 {
		t.Fatal("deleted tag left an association")
	}
	apiTest(t, h, "POST", "/api/projects/"+p+"/tags", Object{"name": "Invalid", "color": "url(evil)"}, 400)
	apiTest(t, h, "POST", "/api/projects/"+other+"/tags", Object{"name": "External", "color": "red"}, 409)
}

func TestSessionPresentationSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := stringOf(s.CreateProject("Persistent")["id"])
	session := stringOf(s.CreateSession(project, "Report", nil)["id"])
	tag := s.CreateWorkspaceTag(project, Object{"name": "Operations", "color": "green"})
	s.SetSessionPresentation(session, Object{"icon": "chart", "tagIds": []any{tag["id"]}, "revision": float64(0)})
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	saved := s.Session(session)
	if saved["icon"] != "chart" || integer(saved["presentationRevision"]) != 1 || len(objects(saved["tags"])) != 1 {
		t.Fatal("metadata lost after restart")
	}
	if len(objects(s.Catalog()["tags"])) != 1 {
		t.Fatal("catalog omitted saved tags")
	}
}
