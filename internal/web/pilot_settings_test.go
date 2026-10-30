package web

import (
	"database/sql"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"path/filepath"
	"testing"
)

func TestPilotDefaultIsFrozenForEachNewTask(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	enabled, automatic := true, false
	settings := b.Store.UpdatePilotSettings(project, 0, &enabled, &automatic)
	first, err := b.Store.CreateSRETask(ai.SRETask{SessionID: session, RequestID: "first", Goal: "只读检查", Scope: []string{resource}, Mode: "plan_only"})
	if err != nil || first.Pilot == nil || first.Pilot.AutoAdvance {
		t.Fatal("new task did not capture guided default", err)
	}
	automatic = true
	b.Store.UpdatePilotSettings(project, integer(settings["revision"]), nil, &automatic)
	saved, err := b.Store.LoadSRETask(session, first.ID)
	if err != nil || saved.Pilot.AutoAdvance {
		t.Fatal("future default rewrote an existing task", err)
	}
	other := b.Store.CreateSession(project, "Another task", nil)
	second, err := b.Store.CreateSRETask(ai.SRETask{SessionID: stringOf(other["id"]), RequestID: "second", Goal: "只读检查", Scope: []string{resource}, Mode: "plan_only"})
	if err != nil || second.Pilot == nil || !second.Pilot.AutoAdvance {
		t.Fatal("next task ignored the saved automatic default", err)
	}
}

func TestPilotSettingsDefaultRevisionAndLegacyCompatibility(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	path := "/api/projects/" + project + "/pilot"
	initial := apiTest(t, h, "GET", path, nil, 200)
	if initial["enabled"] != false || initial["autoAdvance"] != false || integer(initial["revision"]) != 0 {
		t.Fatal("Pilot is not default off", initial)
	}
	first := apiTest(t, h, "PUT", path, Object{"enabled": true, "expectedRevision": 0}, 200)
	if first["enabled"] != true || first["autoAdvance"] != false || !b.Store.SREEnabled(project) {
		t.Fatal("enablement sources diverged", first)
	}
	apiTest(t, h, "PUT", path, Object{"autoAdvance": true, "expectedRevision": 0}, 409)
	next := apiTest(t, h, "PUT", path, Object{"autoAdvance": true, "expectedRevision": first["revision"]}, 200)
	if next["enabled"] != true || next["autoAdvance"] != true {
		t.Fatal("partial update overwrote enablement", next)
	}
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": false}, 200)
	after := apiTest(t, h, "GET", path, nil, 200)
	if after["enabled"] != false || after["autoAdvance"] != true || integer(after["revision"]) != integer(next["revision"])+1 {
		t.Fatal("legacy API reset Pilot preferences", after)
	}
	for _, body := range []Object{{"enabled": true}, {"expectedRevision": 3}, {"expectedRevision": 3.5, "enabled": true}, {"expectedRevision": 3, "enabled": "true"}, {"expectedRevision": 3, "autoAdvance": 1}, {"expectedRevision": 3, "unknown": true}} {
		apiTest(t, h, "PUT", path, body, 400)
	}
}

func TestPilotSettingsRejectToggleWhileProjectRunsButAllowFutureDefault(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	path := "/api/projects/" + project + "/pilot"
	b.messageMu.Lock()
	b.runningMessages = map[string]bool{session: true}
	b.messageMu.Unlock()
	apiTest(t, h, "PUT", path, Object{"enabled": true, "expectedRevision": 0}, 409)
	next := apiTest(t, h, "PUT", path, Object{"autoAdvance": true, "expectedRevision": 0}, 200)
	if next["enabled"] != false || next["autoAdvance"] != true {
		t.Fatal("future default changed running enablement", next)
	}
	b.messageMu.Lock()
	delete(b.runningMessages, session)
	b.messageMu.Unlock()
}

func TestPilotUpgradeDefaultsOffExactlyOnce(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := stringOf(store.CreateProject("Pilot migration")["id"])
	store.SetSREEnabled(project, true)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	// Recreate the actual pre-Pilot schema with an explicitly enabled project.
	db, err := sql.Open("sqlite", filepath.Join(dir, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"DROP TABLE sreProjectSettings", "CREATE TABLE sreProjectSettings(projectId TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0)"} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO sreProjectSettings VALUES(?,1)", project); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	settings := store.PilotSettings(project)
	if settings["enabled"] != false || settings["autoAdvance"] != false {
		t.Fatal("old SRE setting auto-enabled Pilot", settings)
	}
	if old := store.row("SELECT legacyEnabled FROM sreProjectSettings WHERE projectId=?", project); integer(old["legacyEnabled"]) != 1 {
		t.Fatal("migration provenance lost", old)
	}
	enabled := true
	store.UpdatePilotSettings(project, integer(settings["revision"]), &enabled, &enabled)
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if saved := store.PilotSettings(project); saved["enabled"] != true || saved["autoAdvance"] != true {
		t.Fatal("restart overwrote explicit Pilot preferences", saved)
	}
}
