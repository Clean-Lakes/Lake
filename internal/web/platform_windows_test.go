//go:build windows

package web

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWindowsPrivateACLRejectsPublicAccess(t *testing.T) {
	root := filepath.Join(t.TempDir(), "private")
	if err := platform.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "credential")
	if err := os.WriteFile(path, []byte("synthetic-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := platform.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := privateFile(root, path); err != nil {
		t.Fatal("private Windows ACL rejected", err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = privateFile(root, path); err == nil {
		t.Fatal("Everyone-readable credential accepted")
	}
}

func TestWindowsSQLiteLockAndRestart(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data with spaces")
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	project := store.CreateProject("persisted fixture")
	if duplicate, err := OpenStore(dir); err == nil {
		duplicate.Close()
		t.Fatal("second backend acquired data directory")
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if store.Project(stringOf(project["id"]))["name"] != "persisted fixture" {
		t.Fatal("SQLite restart lost data")
	}
}

func TestWindowsConPTYInteractiveAndManagedCommands(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	tid := stringOf(term["id"])
	b.Terminals.Resize(id, tid, 90, 24)
	b.Terminals.Input(id, tid, "printf 'WINDOWS_TERMINAL_FIXTURE\\n'\r", false)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "WINDOWS_TERMINAL_FIXTURE\r\n") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "WINDOWS_TERMINAL_FIXTURE") {
		t.Fatal("ConPTY input/output unavailable")
	}
	managed := b.Terminals.Open(context.Background(), id, ref)
	mid := stringOf(managed["id"])
	b.Terminals.Control(id, mid, "agent")
	entry := b.Terminals.Execute(id, mid, "agent", "printf 'WINDOWS_MANAGED_FIXTURE\\n'", "")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := b.Terminals.Wait(ctx, id, mid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "WINDOWS_MANAGED_FIXTURE") {
		t.Fatal("managed command markers unavailable")
	}
	b.Terminals.Close(id, mid)
	b.Terminals.Close(id, tid)
}
