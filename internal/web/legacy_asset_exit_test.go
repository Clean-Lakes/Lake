package web

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestLegacyAssetExitClosesAllRoutesBeforeBodyOrReceiptReplay(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	pid := stringOf(b.Store.Session(sid)["projectId"])
	for _, base := range []string{"/api/strategy", "/api/projects/" + pid + "/strategy"} {
		for _, suffix := range []string{"", "/settings", "/assets", "/assets/old/revisions/1", "/assets/old/bindings", "/assets/old/review", "/assets/old/promote", "/sources", "/proposals", "/experiments", "/experiments/old/report", "/experiments/old/resume", "/experiments/old/save-candidate", "/fixtures", "/usage", "/usage/old/feedback", "/imports", "/lineage"} {
			for _, method := range []string{"GET", "POST", "PATCH", "DELETE"} {
				result := strategyHTTP(t, h, method, base+suffix, "old-successful-key", "{invalid", 410)
				if result["code"] != "strategy_assets_retired" {
					t.Fatal(result)
				}
			}
		}
	}
	for _, base := range []string{"/api/natural-memory", "/api/projects/" + pid + "/natural-memory"} {
		for _, suffix := range []string{"/legacy", "/legacy/old/preview", "/legacy/old/carry", "/preferences", "/preferences/old/revisions/1", "/changes", "/changes/old/undo"} {
			for _, method := range []string{"GET", "POST"} {
				strategyHTTP(t, h, method, base+suffix, "", "{invalid", 410)
			}
		}
		settings := strategyHTTP(t, h, "GET", base+"/settings", "", "", 200)
		if _, exists := settings["preferenceSettings"]; exists {
			t.Fatal("legacy switches still exposed")
		}
	}
	strategyHTTP(t, h, "POST", "/api/projects/missing/strategy/assets", "", "{invalid", 404)
	strategyHTTP(t, h, "POST", "/api/projects/missing/natural-memory/legacy/old/carry", "", "{invalid", 404)
	for _, origin := range []bool{false, true} {
		req, _ := http.NewRequest("GET", h.URL+"/api/strategy/assets", nil)
		req.Host = "localhost:4177"
		want := 401
		if origin {
			req.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
			req.Header.Set("Origin", "https://foreign.example")
			want = 403
		}
		res, e := h.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatal("retirement bypassed authentication/origin", res.StatusCode)
		}
	}
	if integer(b.Store.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"]) != 0 {
		t.Fatal("retired route wrote an asset")
	}
}

func TestLegacyAssetV6ExitArchivesExactStateAndDoesNotConvertOrRevive(t *testing.T) {
	s, ctx, scope := strategyFixture(t)
	enableStrategyFixture(t, s)
	a, v := naturalAdopt(t, s, ctx, scope)
	p, _ := s.PreviewNaturalMemory(ctx, a.AssetID)
	if _, e := s.CarryNaturalPreference(ctx, a.AssetID, "carry", stringOf(p["previewToken"]), 0); e != nil {
		t.Fatal(e)
	}
	for _, kind := range []strategy.AssetKind{strategy.UserPreference, strategy.DomainProcedure, strategy.ToolGuidance, strategy.ReportGuidance} {
		input := StrategyAssetInput{Title: "archival " + string(kind), Kind: kind, Body: "EXACT_PRIVATE_" + string(kind), Applicability: strategy.Applicability{Profiles: []string{"core"}}}
		if _, e := s.CreateStrategyAsset(ctx, scope, ident(), input); e != nil {
			t.Fatal(e)
		}
	}
	_, e := s.SetNaturalMemorySettings(ctx, "natural-consent", 0, true)
	if e != nil {
		t.Fatal(e)
	}
	before := map[string][]Object{}
	for _, table := range []string{"strategyAssets", "strategyRevisions", "strategyRevisionContent", "strategyRevisionSources", "strategyBindings", "strategySourceEvents", "naturalMemoryLinks", "naturalMemoryChanges", "naturalMemorySettings", "naturalRecallSettings"} {
		before[table] = s.rows("SELECT * FROM " + table + " ORDER BY rowid")
	}
	settings := s.rows("SELECT * FROM strategySettings ORDER BY scopeKey")
	dir := s.Dir
	s.Close()
	// A real pre-V7 layout, not a toggle that re-enables retired product code.
	db, _ := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	_, e = db.Exec("DROP TABLE legacyAssetArchive;DROP TABLE legacyAssetSettingsArchive;DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=6),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(6,?)", strategySchemaHash())
	db.Close()
	if e != nil {
		t.Fatal(e)
	}
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer func() { s.Close() }()
	for table, rows := range before {
		if !reflect.DeepEqual(rows, s.rows("SELECT * FROM "+table+" ORDER BY rowid")) {
			t.Fatalf("upgrade changed original %s", table)
		}
	}
	if !reflect.DeepEqual(settings, s.rows("SELECT * FROM legacyAssetSettingsArchive ORDER BY scopeKey")) {
		t.Fatal("original enable choices were not archived")
	}
	if integer(s.row("SELECT COUNT(*) AS n FROM legacyAssetArchive")["n"]) != len(before["strategyAssets"]) {
		t.Fatal("archive missing assets")
	}
	for _, row := range s.rows("SELECT body FROM strategySettings") {
		set := strategyDecode[strategy.Settings](stringOf(row["body"]))
		if set.MasterEnabled || set.ApplyEnabled || set.LearnEnabled || set.CorrectEnabled || set.OnlineCorrectEnabled {
			t.Fatal("old switches retained authority")
		}
	}
	if integer(s.row("SELECT COUNT(*) AS n FROM naturalPreferenceEntries")["n"]) != 0 {
		t.Fatal("legacy body silently converted to a new preference")
	}
	path := filepath.Join(t.TempDir(), "retired.json")
	if e = ExportLegacyAssets(context.Background(), dir, path); e != nil {
		t.Fatal(e)
	}
	raw, _ := os.ReadFile(path)
	info, _ := os.Lstat(path)
	if !platform.Private(path, info) {
		t.Fatal("private archive permissions missing")
	}
	var out struct {
		RuntimeUse bool
		Tables     map[string][]Object
	}
	if e = json.Unmarshal(raw, &out); e != nil {
		t.Fatal(e)
	}
	if out.RuntimeUse || jsonText(out.Tables["strategyRevisionContent"]) != jsonText(before["strategyRevisionContent"]) {
		t.Fatal("export lost exact original content")
	}
	if _, ok := out.Tables["modelSettings"]; ok {
		t.Fatal("export included provider config")
	}
	if e = ExportLegacyAssets(context.Background(), dir, path); e == nil {
		t.Fatal("overwrote an export")
	}
	again, _ := os.ReadFile(path)
	if string(again) != string(raw) {
		t.Fatal("failed export modified existing file")
	}
	archive := s.rows("SELECT * FROM legacyAssetArchive ORDER BY rowid")
	events := s.rows("SELECT * FROM strategyEvents ORDER BY rowid")
	s.Close()
	s, e = OpenStore(dir)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(archive, s.rows("SELECT * FROM legacyAssetArchive ORDER BY rowid")) || !reflect.DeepEqual(events, s.rows("SELECT * FROM strategyEvents ORDER BY rowid")) {
		t.Fatal("restart repeated retirement")
	}
	// Explicit withdrawal must erase live archive bodies, while immutable hashes remain.
	if _, e = s.ForgetStrategySource(ctx, v.Value.SourceIDs[0], "withdraw", true); e != nil {
		t.Fatal(e)
	}
	erased := filepath.Join(t.TempDir(), "after-withdrawal.json")
	if e = ExportLegacyAssets(context.Background(), dir, erased); e != nil {
		t.Fatal(e)
	}
	bytes, _ := os.ReadFile(erased)
	if strings.Contains(string(bytes), v.Value.Body) {
		t.Fatal("archive export resurrected withdrawn content")
	}
}

func TestLegacyArchiveMigrationFailureRollsBackAndFutureGuardRunsBeforeRecovery(t *testing.T) {
	s, _, _ := strategyFixture(t)
	dir := s.Dir
	s.Close()
	db, _ := openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	_, e := db.Exec("DROP TABLE legacyAssetArchive;DROP TABLE legacyAssetSettingsArchive;DROP TABLE strategySchemaMeta;CREATE TABLE strategySchemaMeta(version INTEGER PRIMARY KEY CHECK(version=6),schemaHash TEXT NOT NULL);INSERT INTO strategySchemaMeta VALUES(6,?);CREATE TABLE legacyAssetSettingsArchive(conflict INTEGER)", strategySchemaHash())
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	if opened, e := OpenStore(dir); e == nil {
		opened.Close()
		t.Fatal("partial archive migration accepted")
	}
	db, _ = openSQLite(filepath.Join(dir, "lake-web.sqlite"))
	defer db.Close()
	var version, count int
	db.QueryRow("SELECT version FROM strategySchemaMeta").Scan(&version)
	db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name='legacyAssetArchive'").Scan(&count)
	if version != 6 || count != 0 {
		t.Fatal("failed DDL published a partial archive")
	}
}

func TestLegacyExportFailureLeavesDatabaseAndExistingFilesUntouched(t *testing.T) {
	s, _, _ := strategyFixture(t)
	before := s.rows("SELECT * FROM strategyEvents ORDER BY rowid")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dir := t.TempDir()
	path := filepath.Join(dir, "cancelled.json")
	if e := ExportLegacyAssets(ctx, s.Dir, path); e == nil {
		t.Fatal("cancelled export succeeded")
	}
	if _, e := os.Lstat(path); !os.IsNotExist(e) {
		t.Fatal("cancelled export left a final file")
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatal("cancelled export left temporary content")
	}
	protected := filepath.Join(dir, "user-file")
	if e := os.WriteFile(protected, []byte("KEEP"), 0600); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(dir, "output-link")
	if e := os.Symlink(protected, link); e == nil {
		if e = ExportLegacyAssets(context.Background(), s.Dir, link); e == nil {
			t.Fatal("output symlink overwritten")
		}
		body, _ := os.ReadFile(protected)
		if string(body) != "KEEP" {
			t.Fatal("symlink target modified")
		}
	}
	if !reflect.DeepEqual(before, s.rows("SELECT * FROM strategyEvents ORDER BY rowid")) {
		t.Fatal("export ran startup recovery")
	}
	missing := filepath.Join(t.TempDir(), "missing")
	if e := ExportLegacyAssets(context.Background(), missing, filepath.Join(dir, "missing.json")); e == nil {
		t.Fatal("missing Home created")
	}
	if _, e := os.Stat(missing); !os.IsNotExist(e) {
		t.Fatal("export created a Home")
	}
}
