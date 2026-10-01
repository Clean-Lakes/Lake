package code

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPatchChangesMultipleFilesAndRestoresPrivateCheckpoint(t *testing.T) {
	project := t.TempDir()
	for _, name := range []string{"a.go", "b.go"} {
		if err := os.WriteFile(filepath.Join(project, name), []byte("before\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	w, err := Open(project)
	if err != nil {
		t.Fatal(err)
	}
	checkpoints, err := NewCheckpointStore(t.TempDir(), "session-1", w)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := w.PreviewPatch([]PatchFile{{Path: "a.go", Content: "after a\n"}, {Path: "b.go", Content: "after b\n"}})
	if err != nil || !strings.Contains(preview.Diff, "-before") || !strings.Contains(preview.Diff, "+after a") {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	id, err := checkpoints.Apply(preview)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.go", "b.go"} {
		data, err := os.ReadFile(filepath.Join(project, name))
		if err != nil || !strings.HasPrefix(string(data), "after") {
			t.Fatalf("%s=%q err=%v", name, data, err)
		}
	}
	manifest := filepath.Join(checkpoints.Root(), id, "manifest.json")
	info, err := os.Stat(manifest)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("checkpoint file mode=%v err=%v", info, err)
	}
	parent, err := os.Stat(filepath.Dir(manifest))
	if err != nil || parent.Mode().Perm() != 0700 {
		t.Fatalf("checkpoint directory mode=%v err=%v", parent, err)
	}
	restore, err := checkpoints.PreviewRestore(id)
	if err != nil || !strings.Contains(restore.Diff, "+before") {
		t.Fatalf("restore=%+v err=%v", restore, err)
	}
	if _, err := checkpoints.Apply(restore); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.go", "b.go"} {
		data, err := os.ReadFile(filepath.Join(project, name))
		if err != nil || string(data) != "before\n" {
			t.Fatalf("%s=%q err=%v", name, data, err)
		}
	}
}

func TestPatchRejectsStaleOrSensitiveFilesBeforeAnyWrite(t *testing.T) {
	project := t.TempDir()
	for _, name := range []string{"a.go", "b.go"} {
		if err := os.WriteFile(filepath.Join(project, name), []byte("before\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	w, err := Open(project)
	if err != nil {
		t.Fatal(err)
	}
	checkpoints, err := NewCheckpointStore(t.TempDir(), "session-1", w)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.PreviewPatch([]PatchFile{{Path: ".env", Content: "secret"}}); err == nil {
		t.Fatal("credential path accepted")
	}
	if _, err := w.PreviewPatch([]PatchFile{{Path: "a.go", Content: strings.Repeat("x", 1024*1024+1)}}); err == nil {
		t.Fatal("oversized file accepted")
	}
	preview, err := w.PreviewPatch([]PatchFile{{Path: "a.go", Content: "after a\n"}, {Path: "b.go", Content: "after b\n"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "b.go"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := checkpoints.Apply(preview); err == nil {
		t.Fatal("stale batch applied")
	}
	data, _ := os.ReadFile(filepath.Join(project, "a.go"))
	if string(data) != "before\n" {
		t.Fatalf("first file changed despite stale second: %q", data)
	}
}

func TestCheckpointRejectsSymlinkedStorageRoot(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lakeRoot := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(lakeRoot, "checkpoints")); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCheckpointStore(lakeRoot, "session-1", w); err == nil {
		t.Fatal("symlinked checkpoint root accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "session-1")); !os.IsNotExist(err) {
		t.Fatalf("storage escaped through symlink: %v", err)
	}
}

func TestCheckpointRestoreRejectsSymlinkedManifestDirectory(t *testing.T) {
	project := t.TempDir()
	if err := os.WriteFile(filepath.Join(project, "a.go"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	w, err := Open(project)
	if err != nil {
		t.Fatal(err)
	}
	checkpoints, err := NewCheckpointStore(t.TempDir(), "session-1", w)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	manifest, _ := json.Marshal(checkpointManifest{ProjectRoot: w.Root, SessionID: "session-1", Entries: []checkpointEntry{{Path: "a.go", Content: "before\n", Existed: true, Mode: 0600}}})
	if err := os.WriteFile(filepath.Join(outside, "manifest.json"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	if err := os.Symlink(outside, filepath.Join(checkpoints.Root(), id)); err != nil {
		t.Fatal(err)
	}
	if _, err := checkpoints.PreviewRestore(id); err == nil {
		t.Fatal("symlinked checkpoint was accepted")
	}
}
