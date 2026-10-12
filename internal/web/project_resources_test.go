package web

import (
	"testing"
)

func TestProjectResourcesAvailableAcrossSessions(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("Shared resources")
	pid := stringOf(p["id"])
	one := apiTest(t, h, "POST", "/api/projects/"+pid+"/sessions", Object{}, 201)
	first := stringsOf(one["resourceIds"])[0]
	// This represents an older client which selected only the first resource.
	second := b.Store.CreateResource(pid, "Second host", "ssh", Object{"host": "127.0.0.1", "port": 22, "username": "synthetic"})
	secondID := stringOf(second["id"])
	two := apiTest(t, h, "POST", "/api/projects/"+pid+"/sessions", Object{"resourceIds": []string{first}}, 201)
	ids := []string{stringOf(one["id"]), stringOf(two["id"])}
	for _, id := range ids {
		snap := apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
		if len(objects(snap["resources"])) != 2 {
			t.Fatalf("session %s does not expose both project resources", id)
		}
		refs := references(b.Store, id, []any{Object{"kind": "file-ssh", "asset_ref": secondID, "path": "/etc/os-release"}})
		if len(refs) != 1 || refs[0]["asset_ref"] != secondID {
			t.Fatal("project file reference did not resolve to the exact resource")
		}
	}
	before := map[string]int{}
	for _, id := range ids {
		before[id] = len(b.Store.Events(id, 0))
	}
	late := b.Store.CreateResource(pid, "Later host", "ssh", Object{"host": "127.0.0.2", "port": 22, "username": "synthetic"})
	for _, id := range ids {
		snap := apiTest(t, h, "GET", "/api/sessions/"+id+"/snapshot", nil, 200)
		if len(objects(snap["resources"])) != 3 {
			t.Fatal("new project resource missing from retained session")
		}
		b.Store.AssertResource(id, stringOf(late["id"]))
		events := b.Store.Events(id, 0)
		if len(events) != before[id]+1 || events[len(events)-1]["type"] != "session" {
			t.Fatal("resource addition did not notify the retained session")
		}
	}
	other := b.Store.CreateProject("Isolated project")
	foreign := b.Store.CreateSession(stringOf(other["id"]), "", nil)
	foreignRef := stringsOf(foreign["resourceIds"])[0]
	apiTest(t, h, "POST", "/api/projects/"+pid+"/sessions", Object{"resourceIds": []string{foreignRef}}, 400)
	apiTest(t, h, "POST", "/api/sessions/"+ids[0]+"/terminals", Object{"resourceId": foreignRef}, 404)
	expectPanic(t, 404, func() {
		references(b.Store, ids[0], []any{Object{"kind": "file-local", "asset_ref": foreignRef, "path": "/etc/os-release"}})
	})
	// Shared resource visibility does not share terminals or their command history.
	term := b.Store.CreateTerminal(ids[0], first)
	expectPanic(t, 404, func() { b.Store.Terminal(ids[1], stringOf(term["id"])) })
}

func TestProjectResourceScopeSurvivesReopenAndEmptyProject(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p := s.CreateProject("Retained project")
	pid := stringOf(p["id"])
	// An empty project can start a conversation before resources are added.
	s.update(func() any { s.exec("DELETE FROM resources WHERE projectId=?", pid); return nil })
	old := s.CreateSession(pid, "", nil)
	sid := stringOf(old["id"])
	if len(stringsOf(old["resourceIds"])) != 0 {
		t.Fatal("empty project unexpectedly has resources")
	}
	added := s.CreateResource(pid, "Added later", "local", Object{})
	ref := stringOf(added["id"])
	s.Close()
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if ids := stringsOf(s.Session(sid)["resourceIds"]); len(ids) != 1 || ids[0] != ref {
		t.Fatal("resource scope was frozen at session creation or lost after reopen")
	}
	s.AssertResource(sid, ref)
}
