package web

import (
	"errors"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
	"testing"
)

func TestSecurityCatalogProjectAndResourceCreate(t *testing.T) {
	b, _ := fixture(t)
	project := b.Store.CreateProject("Catalog fixture")
	resource := b.Store.CreateResource(stringOf(project["id"]), "host", "ssh", Object{"host": "192.0.2.1", "port": 22, "username": "fixture", "authMethod": "password"})
	rows, err := b.Engine.SecurityCatalogResources(b.Context, stringOf(project["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("catalog resources %d", len(rows))
	}
	var before int64
	for _, row := range rows {
		if row.ID == resource["id"] {
			before = row.ConnectionRevision
		}
	}
	_ = b.Store.EditTerminalResource(stringOf(resource["id"]), "renamed", object(resource["ssh"]), false)
	rows, err = b.Engine.SecurityCatalogResources(b.Context, stringOf(project["id"]))
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == resource["id"] && row.ConnectionRevision != before {
			t.Fatal("rename changed connection revision")
		}
	}
}

func TestSecurityCatalogAmbiguousCommitRequiresReviewedCurrentSnapshot(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("Crash fixture")
	pid := stringOf(p["id"])
	resource := b.Store.CreateResource(pid, "host", "ssh", Object{"host": "192.0.2.1", "port": 22, "username": "fixture", "authMethod": "password"})
	rid := stringOf(resource["id"])
	path := "/api/projects/" + pid + "/security"
	apiTest(t, h, "PUT", path+"/policy", Object{"actionId": "policy", "expectedRevision": 0, "policy": Object{"schemaVersion": 1, "mode": "restricted", "resourceIDs": []string{rid}, "rules": []Object{}}}, 200)
	failure := errors.New("simulated response lost after local commit")
	if err := b.Engine.MutateSecurityCatalog(b.Context, func() error { return failure }, rid); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	rows, err := b.Engine.SecurityCatalogResources(b.Context, pid)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == rid && (row.State != "ready" || row.ConnectionRevision != 1) {
			t.Fatalf("known rollback failed %+v", row)
		}
	}
	changeHost := func(host string) {
		b.Store.update(func() any {
			b.Store.exec("UPDATE resourceConnections SET config=? WHERE resourceId=?", jsonText(Object{"host": host, "port": 22, "username": "fixture", "authMethod": "password"}), rid)
			return nil
		})
	}
	if err := b.Engine.MutateSecurityCatalog(b.Context, func() error { changeHost("192.0.2.2"); return failure }, rid); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	rows, err = b.Engine.SecurityCatalogResources(b.Context, pid)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == rid && row.State != "changing" {
			t.Fatalf("ambiguous commit not quarantined %+v", row)
		}
	}
	stale := apiTest(t, h, "POST", path+"/catalog/preview-reconciliation", Object{}, 200)
	changeHost("192.0.2.3")
	apiTest(t, h, "POST", path+"/catalog/confirm-reconciliation", Object{"actionId": "stale", "expectedRevision": 1, "digest": stale["Digest"]}, 409)
	current := apiTest(t, h, "POST", path+"/catalog/preview-reconciliation", Object{}, 200)
	apiTest(t, h, "POST", path+"/catalog/confirm-reconciliation", Object{"actionId": "current", "expectedRevision": 1, "digest": current["Digest"]}, 200)
	rows, err = b.Engine.SecurityCatalogResources(b.Context, pid)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == rid && (row.State != "ready" || row.ConnectionRevision != 2 || !strings.Contains(row.ConnectionIdentity, "192.0.2.3")) {
			t.Fatalf("wrong confirmed connection %+v", row)
		}
	}
}

func TestSecurityCatalogReadsLiveSessionLocalDenyWithoutChangingConfirmedAuthority(t *testing.T) {
	b, h := fixture(t)
	id, rid := newSession(t, h)
	pid := stringOf(b.Store.Session(id)["projectId"])
	options := b.Store.Options(id)
	options["denyLocalExecution"] = true
	b.Store.SaveOptions(id, options)
	view, err := b.securityCatalogSnapshot(b.Context, ai.SecurityCatalogQuery{ProjectID: pid, SessionID: id, ResourceIDs: []string{rid}})
	if err != nil || !view.HardLocalDeny {
		t.Fatal("saved live local deny not authoritative", view.HardLocalDeny, err)
	}
	options["denyLocalExecution"] = false
	b.Store.SaveOptions(id, options)
	view, err = b.securityCatalogSnapshot(b.Context, ai.SecurityCatalogQuery{ProjectID: pid, SessionID: id, ResourceIDs: []string{rid}})
	if err != nil || view.HardLocalDeny {
		t.Fatal(view.HardLocalDeny, err)
	}
}
