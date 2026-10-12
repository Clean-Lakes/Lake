package web

import "testing"

func TestRestartDoesNotRepeatHistoricalUnknownOutcomeWarnings(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	p := s.CreateProject("restart fixture")
	session := s.CreateSession(stringOf(p["id"]), "stopped fixture", nil)
	id := stringOf(session["id"])
	ref := stringsOf(session["resourceIds"])[0]
	s.update(func() any {
		s.exec("INSERT INTO actions(id,sessionId,resourceId,command,reason,impact,verification,status,createdAt,updatedAt) VALUES('old-outcome',?,?,?,'','','','unknown',?,?)", id, ref, "fixture command", now(), now())
		s.status(id, "completed")
		return nil
	})
	must(s.Close())
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Session(id)["status"] != "completed" || len(objects(s.Snapshot(id)["messages"])) != 0 {
		t.Fatal("historical outcome generated a new restart warning")
	}
	if s.Action("old-outcome")["status"] != "unknown" {
		t.Fatal("unknown outcome audit was erased")
	}
	s.update(func() any {
		s.exec("UPDATE actions SET status='running' WHERE id='old-outcome'")
		s.status(id, "investigating")
		return nil
	})
	must(s.Close())
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Session(id)["status"] != "failed" || len(objects(s.Snapshot(id)["messages"])) != 1 {
		t.Fatal("actual unfinished work did not receive a restart warning")
	}
	must(s.Close())
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if len(objects(s.Snapshot(id)["messages"])) != 1 {
		t.Fatal("restart warning was duplicated")
	}
}
