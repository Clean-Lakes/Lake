package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

type fakeLegacyVault struct {
	modelDeleted bool
	sshDeleted   bool
}

func (*fakeLegacyVault) LoadModelAPIKey(string) ([]byte, error) {
	return []byte("old-model-secret"), nil
}
func (v *fakeLegacyVault) DeleteModelAPIKey(string) error { v.modelDeleted = true; return nil }
func (*fakeLegacyVault) Load(string) ([]byte, error)      { return []byte("old-ssh-secret"), nil }
func (v *fakeLegacyVault) Delete(string) error            { v.sshDeleted = true; return nil }

func TestMigrateSecretsMovesRefsAndDeletesOldItems(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := saveModelConfig(s.Root(), lakeModelConfig{Model: "test", ModelProvider: "mimo", ModelProviders: map[string]providerConfig{"mimo": {BaseURL: "https://example.invalid", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	lake, err := s.CreateLake(ctx, "test-lake", "")
	if err != nil {
		t.Fatal(err)
	}
	resource, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "192.0.2.1", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, resource.ID, "keychain:ssh/0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	legacy := &fakeLegacyVault{}
	var out bytes.Buffer
	if err := migrateSecrets(ctx, s, legacy, &out, &out); err != nil {
		t.Fatal(err)
	}
	if !legacy.modelDeleted || !legacy.sshDeleted || !strings.Contains(out.String(), "模型 API Key 1 个，SSH 私钥 1 个") {
		t.Fatalf("migration incomplete: %s", out.String())
	}
	vault := credential.FileVault{Root: s.Root()}
	key, err := vault.LoadModelAPIKey("mimo")
	if err != nil || string(key) != "old-model-secret" {
		t.Fatalf("migrated model key: %v", err)
	}
	attachments, err := s.ListAttachments(ctx, resource.ID)
	if err != nil || len(attachments) != 1 || !strings.HasPrefix(attachments[0].Ref, "file:ssh/") {
		t.Fatalf("credential ref not moved: %+v, %v", attachments, err)
	}
	key, err = vault.Load(attachments[0].Ref)
	if err != nil || string(key) != "old-ssh-secret" {
		t.Fatalf("migrated SSH key: %v", err)
	}
	info, err := os.Stat(filepath.Join(s.Root(), "secrets", "model", "mimo"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("migrated model key permissions: %v", err)
	}
}
