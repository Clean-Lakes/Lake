package ai

import (
	"context"
	"errors"
	"testing"
)

func TestSecurityMCPLateCatalogCannotBlessReconfiguredServer(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"})
	ctx := context.Background()
	metadata, storage := hash("endpoint-one"), hash("file-one")
	if err := e.BootstrapSecurityMCP(ctx, []SecurityMCPUpdate{{ID: "server", MetadataDigest: metadata, StorageDigest: storage, Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if err := e.RecordSecurityMCPCatalog(ctx, "server", 1, map[string]any{"tools": []map[string]any{{"name": "inspect"}}}); err != nil {
		t.Fatal(err)
	}
	binding, err := e.PutSecurityMCPBinding(ctx, SecurityMCPBindingAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "bind", ProjectID: "project"}, ServerID: "server", Enabled: true, ToolNames: []string{"inspect"}})
	if err != nil || binding.Revision != 1 {
		t.Fatalf("binding %+v %v", binding, err)
	}
	if err = e.MutateSecurityMCP(ctx, []string{"server"}, storage, func() ([]SecurityMCPUpdate, error) {
		return []SecurityMCPUpdate{{ID: "server", MetadataDigest: hash("endpoint-two"), StorageDigest: hash("file-two"), Enabled: true, ConnectionChanged: true}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = e.RecordSecurityMCPCatalog(ctx, "server", 1, map[string]any{"tools": []map[string]any{{"name": "inspect"}}}); err == nil {
		t.Fatal("late old-endpoint response updated new catalog")
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	var row securityMCPRevisionRow
	if err = db.First(&row, "id = ?", "server").Error; err != nil {
		t.Fatal(err)
	}
	if row.ConfigRevision != 2 || row.ToolNames != "[]" {
		t.Fatalf("stale catalog restored %+v", row)
	}
	rejected := errors.New("validation rejected without writing file")
	err = e.MutateSecurityMCP(ctx, []string{"server"}, row.StorageDigest, func() ([]SecurityMCPUpdate, error) {
		return []SecurityMCPUpdate{{ID: row.ID, MetadataDigest: row.MetadataDigest, StorageDigest: row.StorageDigest, Enabled: true}}, rejected
	})
	if !errors.Is(err, rejected) {
		t.Fatal(err)
	}
	if err = db.First(&row, "id = ?", "server").Error; err != nil || row.State != "ready" || row.ConfigRevision != 2 {
		t.Fatalf("known failed config write quarantined unchanged server %+v %v", row, err)
	}
}
