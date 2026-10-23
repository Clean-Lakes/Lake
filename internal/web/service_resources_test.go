package web

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceResourceAddition(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	nodes := objects(apiTest(t, h, "POST", "/api/projects/"+project+"/resource-tree", Object{"operation": "create", "name": "Services"}, 200)["nodes"])
	folder := ""
	for _, n := range nodes {
		if n["name"] == "Services" {
			folder = stringOf(n["id"])
		}
	}
	for _, tc := range []struct {
		kind     string
		settings Object
		secret   string
	}{
		{"database", Object{"driver": "mysql", "host": "localhost", "username": "app", "password": "synthetic-mysql-password"}, "synthetic-mysql-password"},
		{"database", Object{"driver": "postgres", "host": "localhost", "username": "app", "password": "synthetic-postgres-password"}, "synthetic-postgres-password"},
		{"redis", Object{"host": "localhost", "username": "app", "db": 3, "password": "synthetic-redis-password"}, "synthetic-redis-password"},
		{"kubernetes", Object{"endpoint": "https://cluster.example:6443/", "namespace": "apps", "context": "production", "token": "synthetic-k8s-token"}, "synthetic-k8s-token"},
		{"apisix", Object{"endpoint": "http://localhost:9180", "apiKey": "synthetic-admin-key"}, "synthetic-admin-key"},
		{"prometheus", Object{"endpoint": "https://metrics.example/prometheus", "username": "metrics", "password": "synthetic-metrics-password"}, "synthetic-metrics-password"},
		{"victoriametrics", Object{"endpoint": "https://vm.example/select/2/prometheus", "token": "synthetic-vm-token"}, "synthetic-vm-token"},
	} {
		t.Run(tc.kind+stringOf(tc.settings["driver"]), func(t *testing.T) {
			r := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"name": "Service " + tc.kind, "kind": tc.kind, "parentId": folder, "settings": tc.settings}, 201)
			if r["kind"] != tc.kind {
				t.Fatal("incorrect resource kind")
			}
			settings := object(r["settings"])
			ref := stringOf(settings["credentialRef"])
			path := filepath.Join(b.Models.Home, "secrets", ref)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var secret Object
			if json.Unmarshal(data, &secret) != nil || !strings.Contains(string(data), tc.secret) {
				t.Fatal("secret was not saved")
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("secret file is not private")
			}
			for _, payload := range []any{r, b.Store.Catalog(), b.Store.Snapshot(sid)} {
				if strings.Contains(jsonText(payload), tc.secret) {
					t.Fatal("secret leaked into public state")
				}
			}
			found := false
			for _, n := range objects(b.Store.Catalog()["resourceTree"]) {
				if n["resourceId"] == r["id"] {
					found = n["parentId"] == folder
				}
			}
			if !found {
				t.Fatal("resource not filed into requested folder")
			}
			if !strings.Contains(jsonText(b.Store.Session(sid)["resourceIds"]), stringOf(r["id"])) {
				t.Fatal("new resource missing from existing session")
			}
		})
	}
}

func TestServiceResourceRejectsInvalidSettingsAndCleansCredentials(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	endpoint := "/api/projects/" + project + "/resources"
	cases := []Object{
		{"kind": "database", "settings": Object{"driver": "mysql", "host": "localhost", "port": 0}},
		{"kind": "database", "settings": Object{"driver": "postgres", "host": "localhost", "port": 5432.5}},
		{"kind": "database", "settings": Object{"driver": "postgres", "host": "localhost", "sslmode": "insecure"}},
		{"kind": "redis", "settings": Object{"host": "localhost", "db": -1}},
		{"kind": "redis", "settings": Object{"host": "localhost", "db": "invalid"}},
		{"kind": "redis", "settings": Object{"host": "-oInjected"}},
		{"kind": "redis", "settings": Object{"host": "localhost", "tls": "false"}},
		{"kind": "redis", "settings": Object{"host": "localhost", "credentialRef": "/tmp/outside-secret"}},
		{"kind": "kubernetes", "settings": Object{"endpoint": "https://cluster.example", "password": "synthetic-unused"}},
		{"kind": "prometheus", "settings": Object{"endpoint": "https://metrics.example", "token": "synthetic-unused", "password": "synthetic-unused"}},
		{"kind": "victoriametrics", "settings": Object{"endpoint": "https://vm.example", "privateKey": "do-not-store"}},
		{"kind": "unknown", "settings": Object{"endpoint": "https://service.example"}},
	}
	for _, bad := range []string{"", "file:///tmp/service", "https://user:password@example.com", "https://example.com?token=secret", "https://example.com#secret", "https://example.com:0", "https://example.com:65536", "https://example.com\n"} {
		cases = append(cases, Object{"kind": "apisix", "settings": Object{"endpoint": bad, "apiKey": "synthetic-unused"}})
	}
	before := len(objects(b.Store.Catalog()["resources"]))
	for _, input := range cases {
		input["name"] = "invalid"
		apiTest(t, h, "POST", endpoint, input, 400)
	}
	// Name validation happens after preparing credentials; failure must remove them.
	apiTest(t, h, "POST", endpoint, Object{"name": "", "kind": "redis", "settings": Object{"host": "localhost", "password": "synthetic-unused"}}, 400)
	files, _ := filepath.Glob(filepath.Join(b.Models.Home, "secrets", "service-secret-*"))
	if len(files) != 0 || len(objects(b.Store.Catalog()["resources"])) != before {
		t.Fatal("failed creation left credentials or resource rows")
	}
}

func TestServiceResourceSchemaUpgrade(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite3", filepath.Join(dir, "lake-web.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	old := strings.Replace(schema, "CHECK(kind IN ('local','ssh','database','docker','redis','kubernetes','apisix','prometheus','victoriametrics'))", "CHECK(kind IN ('local','ssh','database','docker','redis'))", 1)
	if _, err = db.Exec(old); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO projects VALUES('p','existing','2026-10-01'); INSERT INTO resources VALUES('r','p','Redis','redis','localhost','available'); INSERT INTO resourceConnections VALUES('r','{"host":"localhost"}');`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	for i := 0; i < 2; i++ {
		store, err := OpenStore(dir)
		if err != nil {
			t.Fatal(err)
		}
		if store.Resource("r")["kind"] != "redis" {
			t.Fatal("existing resource lost")
		}
		if i == 0 {
			for _, kind := range []string{"kubernetes", "apisix", "prometheus", "victoriametrics"} {
				store.CreateResource("p", kind, kind, Object{"endpoint": "https://example.com"})
			}
		}
		if len(objects(store.Catalog()["resources"])) != 6 {
			t.Fatal("resources were lost across migration/reopen")
		}
		if rows := store.rows("PRAGMA foreign_key_check"); len(rows) != 0 {
			t.Fatal("foreign keys broken")
		}
		store.Close()
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "lake-web.before-go-*.sqlite"))
	if len(backups) != 1 {
		t.Fatal("migration backup missing or repeated")
	}
}
