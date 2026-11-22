package web

import "testing"

func TestSessionPresentationRevisionAndRetiredTagRoutes(t *testing.T) {
	b, h := fixture(t)
	p := stringOf(b.Store.CreateProject("Workspace")["id"])
	id := stringOf(b.Store.CreateSession(p, "Database investigation", nil)["id"])
	apiTest(t, h, "POST", "/api/projects/"+p+"/tags", Object{"name": "Database", "color": "purple"}, 404)
	apiTest(t, h, "PUT", "/api/tags/old-tag", Object{"name": "Data", "color": "blue"}, 404)
	apiTest(t, h, "DELETE", "/api/tags/old-tag", nil, 404)
	path := "/api/sessions/" + id + "/presentation"
	apiTest(t, h, "PUT", path, Object{"icon": "database", "tagIds": []string{}, "revision": 0}, 410)
	apiTest(t, h, "PUT", path, Object{"icon": "invalid-icon", "revision": 0}, 400)
	saved := apiTest(t, h, "PUT", path, Object{"icon": "database", "revision": 0}, 200)
	if saved["icon"] != "database" || integer(saved["presentationRevision"]) != 1 {
		t.Fatal("presentation not saved")
	}
	apiTest(t, h, "PUT", path, Object{"icon": "chat", "revision": 0}, 409)
	if b.Store.Session(id)["icon"] != "database" {
		t.Fatal("stale write replaced newer metadata")
	}
}

func TestSessionPresentationSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := stringOf(s.CreateProject("Persistent")["id"])
	session := stringOf(s.CreateSession(project, "Report", nil)["id"])
	s.update(func() any {
		s.exec("INSERT INTO workspaceTags(id,projectId,name,color) VALUES(?,?,?,?)", "old-tag", project, "Operations", "green")
		s.exec("INSERT INTO sessionTags(sessionId,tagId) VALUES(?,?)", session, "old-tag")
		return nil
	})
	s.SetSessionPresentation(session, Object{"icon": "chart", "revision": float64(0)})
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	saved := s.Session(session)
	if saved["icon"] != "chart" || integer(saved["presentationRevision"]) != 1 {
		t.Fatal("metadata lost after restart")
	}
	if _, present := saved["tags"]; present {
		t.Fatal("session still exposes retired tags")
	}
	if _, present := s.Catalog()["tags"]; present {
		t.Fatal("catalog still exposes retired tags")
	}
	if association := s.row("SELECT t.name FROM sessionTags st JOIN workspaceTags t ON st.tagId=t.id WHERE st.sessionId=?", session); association["name"] != "Operations" {
		t.Fatal("stored tag association lost after reset")
	}
}
