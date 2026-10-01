package credential

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileVaultRoundTripAndPermissions(t *testing.T) {
	root := t.TempDir()
	vault := FileVault{Root: root}
	if err := vault.PutModelAPIKey("mimo", []byte("private-model-key")); err != nil {
		t.Fatal(err)
	}
	key, err := vault.LoadModelAPIKey("mimo")
	if err != nil || string(key) != "private-model-key" {
		t.Fatalf("model key round trip failed: %v", err)
	}
	ref, err := vault.Import([]byte("private-ssh-key"))
	if err != nil || !strings.HasPrefix(ref, "file:ssh/") {
		t.Fatalf("SSH import failed: %s %v", ref, err)
	}
	sshKey, err := vault.Load(ref)
	if err != nil || string(sshKey) != "private-ssh-key" {
		t.Fatalf("SSH key round trip failed: %v", err)
	}
	for _, path := range []string{
		filepath.Join(root, "secrets", "model", "mimo"),
		filepath.Join(root, "secrets", "ssh", strings.TrimPrefix(ref, "file:ssh/")),
	} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("secret file permissions: %s: %v", path, err)
		}
		info, err = os.Stat(filepath.Dir(path))
		if err != nil || info.Mode().Perm() != 0700 {
			t.Fatalf("secret directory permissions: %s: %v", path, err)
		}
	}
	if err := vault.Delete(ref); err != nil {
		t.Fatal(err)
	}
	if _, err := vault.Load(ref); !os.IsNotExist(err) {
		t.Fatalf("deleted SSH key still loads: %v", err)
	}
}

func TestFileVaultNeverLoadsOldKeychainReference(t *testing.T) {
	vault := FileVault{Root: t.TempDir()}
	if _, err := vault.Load("keychain:ssh/1234"); err == nil || !strings.Contains(err.Error(), "migrate") {
		t.Fatalf("old reference must require explicit migration: %v", err)
	}
}

func TestFileVaultRejectsUnsafeFile(t *testing.T) {
	root := t.TempDir()
	vault := FileVault{Root: root}
	if err := vault.PutModelAPIKey("mimo", []byte("test")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "secrets", "model", "mimo")
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := vault.LoadModelAPIKey("mimo"); err == nil {
		t.Fatal("world-readable credential accepted")
	}
}
