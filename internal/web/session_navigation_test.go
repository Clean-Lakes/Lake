package web

import "testing"

func TestSessionNavigationScopeRevisionAndStableActivity(t *testing.T) {
	b, h := fixture(t)
	p := stringOf(b.Store.CreateProject("Navigation")["id"])
	other := stringOf(b.Store.CreateProject("Other")["id"])
	a := b.Store.CreateSession(p, "A", nil)
	c := b.Store.CreateSession(p, "C", nil)
	foreign := b.Store.CreateSession(other, "Foreign", nil)
	path := "/api/projects/" + p + "/session-navigation"
	move := func(id string, pinned bool, before any, revision int, status int) Object {
		return apiTest(t, h, "POST", path, Object{"sessionId": id, "pinned": pinned, "beforeId": before, "revision": revision}, status)
	}
	aID, cID := stringOf(a["id"]), stringOf(c["id"])
	move(stringOf(foreign["id"]), true, nil, 0, 404)
	for _, resource := range objects(b.Store.Catalog()["resources"]) {
		if resource["projectId"] == p && resource["kind"] == "local" {
			hidden := b.Store.ResourceTerminalSession(stringOf(resource["id"]))
			move(stringOf(hidden["id"]), true, nil, 0, 404)
			break
		}
	}
	move(aID, false, foreign["id"], 0, 404)
	move(aID, false, aID, 0, 400)
	apiTest(t, h, "POST", path, Object{"sessionId": aID, "pinned": "true", "revision": 0}, 400)
	apiTest(t, h, "POST", path, Object{"sessionId": aID, "pinned": true}, 400)
	saved := move(aID, false, cID, 0, 200)
	if integer(saved["navigationPosition"]) != 0 || integer(b.Store.Session(cID)["navigationPosition"]) != 1 {
		t.Fatal("manual order missing")
	}
	if saved["updatedAt"] != a["updatedAt"] || saved["status"] != a["status"] {
		t.Fatal("sorting changed conversation activity")
	}
	move(cID, true, nil, 0, 409)
	if b.Store.Session(cID)["pinned"] != false {
		t.Fatal("stale request changed grouping")
	}
	saved = move(aID, true, nil, 1, 200)
	if saved["pinned"] != true || integer(saved["navigationRevision"]) != 2 {
		t.Fatal("pin missing")
	}
	move(cID, false, aID, 2, 404)
	move(cID, true, aID, 2, 200)
	if integer(b.Store.Session(cID)["navigationPosition"]) != 0 || integer(b.Store.Session(aID)["navigationPosition"]) != 1 {
		t.Fatal("pinned reorder missing")
	}
	saved = move(aID, false, nil, 3, 200)
	if saved["pinned"] != false || integer(saved["navigationRevision"]) != 4 {
		t.Fatal("unpin missing")
	}
	for _, session := range objects(b.Store.Catalog()["sessions"]) {
		if session["projectId"] == p && integer(session["navigationRevision"]) != 4 {
			t.Fatal("catalog has inconsistent revision")
		}
	}
}

func TestSessionNavigationSurvivesRestartAndDeletedTargets(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p := stringOf(s.CreateProject("Persistent")["id"])
	a := stringOf(s.CreateSession(p, "Pinned", nil)["id"])
	b := stringOf(s.CreateSession(p, "Ordinary", nil)["id"])
	s.MoveSessionNavigation(p, Object{"sessionId": a, "pinned": true, "revision": float64(0)})
	s.MoveSessionNavigation(p, Object{"sessionId": b, "pinned": false, "revision": float64(1)})
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.Session(a)["pinned"] != true || integer(s.Session(b)["navigationRevision"]) != 2 {
		t.Fatal("navigation lost after restart")
	}
	s.DeleteSession(a)
	expectPanic(t, 404, func() {
		s.MoveSessionNavigation(p, Object{"sessionId": b, "pinned": true, "beforeId": a, "revision": float64(2)})
	})
	if integer(s.Session(b)["navigationRevision"]) != 2 || s.Session(b)["pinned"] != false {
		t.Fatal("invalid move partially applied")
	}
}
