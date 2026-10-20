package ai

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestResourceImportPermissions(t *testing.T) {
	p := DefaultPermissions()
	c := Config{Permissions: &p}
	if kind, err := approvalKind(c, "import_resources", "write", nil); err != nil || kind != "resource_import" {
		t.Fatal("import must require write authorization")
	}
	p.SilentWriteFiles = true
	if kind, err := approvalKind(c, "import_resources", "write", nil); err != nil || kind != "" {
		t.Fatal("silent import permission ignored")
	}
	p.SilentReadFiles = false
	if kind, err := approvalKind(c, "preview_resource_import", "readonly", nil); err != nil || kind != "file_read" {
		t.Fatal("file-read permission ignored")
	}
	p.SilentReadFiles = true
	p.DenyLocalExecution = true
	if _, err := approvalKind(c, "preview_resource_import", "readonly", map[string]any{"localFileRead": true}); err == nil {
		t.Fatal("local file restriction ignored")
	}
	if kind, err := approvalKind(c, "preview_resource_import", "readonly", map[string]any{"localFileRead": false}); err != nil || kind != "" {
		t.Fatal("user upload incorrectly treated as local execution")
	}
}

func TestFileAndSQLPermissionEffects(t *testing.T) {
	for _, kind := range []string{"file_read", "file_write_silent", "readonly_sql", "readonly_pg_sql", "readonly_pg_sql_silent"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fixture")
			permissions := DefaultPermissions()
			call := Call{ID: "permission-fixture", Name: "read", Arguments: js(map[string]any{"path": path})}
			assets := []Asset{}
			marker := "permission file contents"
			expectApproval := "file_read"
			switch kind {
			case "file_read":
				permissions.SilentReadFiles = false
				os.WriteFile(path, []byte(marker), 0600)
			case "file_write_silent":
				permissions.SilentWriteFiles = true
				expectApproval = ""
				call = Call{ID: call.ID, Name: "write", Arguments: js(map[string]any{"path": path, "content": marker})}
			case "readonly_sql", "readonly_pg_sql", "readonly_pg_sql_silent":
				permissions.SilentReadSQL = kind == "readonly_pg_sql_silent"
				expectApproval = "readonly_sql"
				if permissions.SilentReadSQL {
					expectApproval = ""
				}
				marker = "42"
				os.WriteFile(path, nil, 0600)
				assets = []Asset{{ID: "db", Kind: "database", Settings: map[string]any{"driver": "sqlite", "path": path}}}
				call = Call{ID: call.ID, Name: "execute_sql", Arguments: js(map[string]any{"asset_ref": assetAlias("db"), "sql": "SELECT 42 AS answer"})}
				if kind != "readonly_sql" {
					// A real disposable SQLite table exercises the catalog-named
					// query through dispatch and approval without a remote database.
					db, _, err := databaseOpen(assets[0], false, "")
					if err != nil {
						t.Fatal(err)
					}
					_, err = db.Exec("CREATE TABLE pg_stat_activity(answer INTEGER); INSERT INTO pg_stat_activity VALUES(42)")
					db.Close()
					if err != nil {
						t.Fatal(err)
					}
					call.Arguments = js(map[string]any{"asset_ref": assetAlias("db"), "sql": "SELECT answer FROM pg_stat_activity"})
				}
			}
			var resultSeen atomic.Bool
			m, close := fakeModel(t, func(n int, body map[string]any) any {
				if n == 1 {
					return response("", call)
				}
				messages := arr(body["messages"])
				if strings.Contains(str(obj(messages[len(messages)-1])["content"]), marker) || kind == "file_write_silent" {
					resultSeen.Store(true)
				}
				return response("complete")
			})
			defer close()
			e := engineFor(t, m, nil)
			if err := e.Configure("case", Config{Model: m, Profile: "core", Runtime: "local", Assets: assets, Permissions: &permissions}); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			go func() { done <- e.Chat(ctx, "case", "permission fixture", nil) }()
			if expectApproval != "" {
				p := waitApproval(t, e)
				if p.Kind != expectApproval || resultSeen.Load() {
					t.Fatal("file/SQL operation bypassed its required decision")
				}
				if err := e.Decision("case", p.ID, true, ""); err != nil {
					t.Fatal(err)
				}
			}
			if err := <-done; err != nil || !resultSeen.Load() {
				t.Fatal("approved operation did not return real data", err)
			}
			if kind == "file_write_silent" {
				contents, err := os.ReadFile(path)
				if err != nil || string(contents) != marker {
					t.Fatal("silent write preference was not applied")
				}
			}
		})
	}
}

func TestUnreferencedAssetCannotBeReadByModel(t *testing.T) {
	path := filepath.Join(t.TempDir(), "outside-reference")
	const marker = "unreferenced-private-fixture"
	os.WriteFile(path, []byte(marker), 0600)
	var blocked atomic.Bool
	m, close := fakeModel(t, func(n int, body map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "scoped-list", Name: "list_assets", Arguments: `{"pattern":""}`})
		}
		messages := arr(body["messages"])
		result := str(obj(messages[len(messages)-1])["content"])
		if n == 2 {
			if strings.Contains(result, assetAlias("outside")) || !strings.Contains(result, assetAlias("inside")) {
				t.Error("asset discovery exposed unreferenced resource metadata")
			}
			return response("", Call{ID: "outside", Name: "read", Arguments: js(map[string]any{"asset_ref": assetAlias("outside"), "path": path})})
		}
		blocked.Store(strings.Contains(result, "已引用或明确批准") && !strings.Contains(result, marker))
		return response("blocked")
	})
	defer close()
	e := engineFor(t, m, nil)
	p := DefaultPermissions()
	p.BlockUnreferencedAssets = true
	e.Configure("case", Config{Model: m, Runtime: "local", Assets: []Asset{{ID: "inside", Kind: "local"}, {ID: "outside", Kind: "local"}}, Permissions: &p})
	if err := e.Chat(context.Background(), "case", "only referenced resource", []map[string]any{{"asset_ref": "inside"}}); err != nil || !blocked.Load() {
		t.Fatal("model read a resource outside this turn's references", err)
	}
}

func TestDeleteToolFollowsCommandSilence(t *testing.T) {
	for _, silent := range []bool{false, true} {
		t.Run(fmt.Sprint(silent), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "disposable.txt")
			os.WriteFile(path, []byte("delete fixture"), 0600)
			m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
				if n == 1 {
					return response("", Call{ID: "file-delete", Name: "delete", Arguments: js(map[string]any{"path": path})})
				}
				return response("done")
			})
			defer closeModel()
			e := engineFor(t, m, nil)
			p := DefaultPermissions()
			p.SilentCommands = silent
			if err := e.Configure("case", Config{Model: m, Profile: "core", Runtime: "local", Permissions: &p}); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- e.Chat(context.Background(), "case", "delete disposable fixture", nil) }()
			if !silent {
				pending := waitApproval(t, e)
				if pending.Kind != "delete" {
					t.Fatal("missing delete approval")
				}
				if _, err := os.Stat(path); err != nil {
					t.Fatal("delete occurred before approval")
				}
				if err := e.Decision("case", pending.ID, true, pending.Confirmation); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("silent delete stalled awaiting approval")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("delete preference did not execute")
			}
		})
	}
}

func TestSilentDeletionStillResolvesTargetAndTerminal(t *testing.T) {
	p := DefaultPermissions()
	p.SilentCommands = true
	c := Config{Permissions: &p}
	for _, test := range []struct {
		context map[string]any
		kind    string
	}{
		{map[string]any{"destructiveOnly": true}, ""},
		{map[string]any{"destructiveOnly": true, "needsTarget": true}, "resource_select"},
		{map[string]any{"destructiveOnly": true, "needsTerminal": true}, ""},
		{map[string]any{"destructive": true}, ""},
		{map[string]any{"catastrophic": true}, "delete"},
	} {
		kind, err := approvalKind(c, "shell", "dangerous", test.context)
		if err != nil || kind != test.kind {
			t.Fatalf("got %q %v, want %q", kind, err, test.kind)
		}
	}
}
