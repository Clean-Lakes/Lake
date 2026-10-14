package desktopupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func updateCacheFixture(t *testing.T, root, name, complete string) string {
	t.Helper()
	work := filepath.Join(root, name)
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"update-helper.exe", "update.json", "ready", "Lake-1.2.3-windows-x86_64-setup.exe"} {
		if err := os.WriteFile(filepath.Join(work, file), []byte("synthetic package"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if complete != "" {
		if err := os.WriteFile(filepath.Join(work, "complete"), []byte(complete), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return work
}
func TestCleanupCompletedWindowsJobsBoundaries(t *testing.T) {
	root := t.TempDir()
	done := updateCacheFixture(t, root, "job-done", "1.2.3")
	pending := updateCacheFixture(t, root, "job-active", "")
	failed := updateCacheFixture(t, root, "job-failed", "1.2.3")
	os.WriteFile(filepath.Join(failed, "error"), []byte("failure"), 0600)
	future := updateCacheFixture(t, root, "job-future", "9.0.0")
	unknown := updateCacheFixture(t, root, "job-unknown", "1.2.3")
	os.WriteFile(filepath.Join(unknown, "notes.txt"), []byte("user file"), 0600)
	other := updateCacheFixture(t, root, "other", "1.2.3")
	outside := updateCacheFixture(t, t.TempDir(), "job-outside", "1.2.3")
	os.Symlink(outside, filepath.Join(root, "job-link"))
	if err := CleanupCompletedJobs(root, "1.2.4"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(done); !os.IsNotExist(err) {
		t.Fatal("completed package retained")
	}
	for _, path := range []string{pending, failed, future, unknown, other, outside} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal("protected cache removed", path, err)
		}
	}
	if err := CleanupCompletedJobs(root, "1.2.4"); err != nil {
		t.Fatal("cleanup not idempotent", err)
	}
}
func TestCleanupRejectsSymlinkMarkerAndInvalidVersion(t *testing.T) {
	root := t.TempDir()
	work := updateCacheFixture(t, root, "job-marker", "")
	marker := filepath.Join(t.TempDir(), "complete")
	os.WriteFile(marker, []byte("1.2.3"), 0600)
	os.Symlink(marker, filepath.Join(work, "complete"))
	if err := CleanupCompletedJobs(root, "bad"); err == nil {
		t.Fatal("invalid version accepted")
	}
	if err := CleanupCompletedJobs(root, "1.2.4"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(work); err != nil {
		t.Fatal("symlink marker deleted")
	}
}
