package code

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceReadsAndSearchesOnlyInsideProject(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "main.go"), []byte("package main\nfunc main() {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("SECRET=never show"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.go")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape.go")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, ".env"), filepath.Join(root, "linked.env")); err != nil {
		t.Fatal(err)
	}
	w, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	files, err := w.List(context.Background(), ".go", 20)
	if err != nil || len(files) != 1 || files[0] != "src/main.go" {
		t.Fatalf("files=%v err=%v", files, err)
	}
	result, err := w.Read("src/main.go", 1, 10)
	if err != nil || len(result.Lines) != 3 || !strings.Contains(result.Lines[1], "func main") {
		t.Fatalf("read=%+v err=%v", result, err)
	}
	hits, err := w.Search(context.Background(), `func main`, 10)
	if err != nil || len(hits) != 1 || hits[0].Path != "src/main.go" {
		t.Fatalf("hits=%+v err=%v", hits, err)
	}
	for _, path := range []string{"../outside.go", "escape.go", ".env", "linked.env"} {
		if _, err := w.Read(path, 1, 10); err == nil {
			t.Fatalf("read allowed %s", path)
		}
	}
}

func TestWorkspaceRejectsSecretRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".lake", "secrets")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root); err == nil {
		t.Fatal("secret directory was accepted as workspace")
	}
}
