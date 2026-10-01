package code

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewAndApplyRequireUnchangedFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "main.go")
	if err := os.WriteFile(path, []byte("package main\nconst answer = 1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	w, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := w.PreviewReplace("main.go", "answer = 1", "answer = 2")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("changed externally\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := w.ApplyChange(preview); err == nil {
		t.Fatal("stale edit succeeded")
	}
	preview, err = w.PreviewReplace("main.go", "changed externally", "done")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.ApplyChange(preview); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "done\n" {
		t.Fatalf("data=%q err=%v", data, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode=%v", info.Mode())
	}
}

func TestCreateAndRunInsideWorkspace(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.PreviewCreate("../outside", "bad"); err == nil {
		t.Fatal("outside create accepted")
	}
	preview, err := w.PreviewCreate("hello.txt", "hello\n")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.ApplyChange(preview); err != nil {
		t.Fatal(err)
	}
	if err := w.ApplyChange(preview); err == nil {
		t.Fatal("duplicate create accepted")
	}
	result, err := w.Run(context.Background(), "pwd; cat hello.txt")
	if err != nil || result.ExitCode != 0 || !strings.Contains(result.Stdout, w.Root) || !strings.Contains(result.Stdout, "hello") {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestGitDiffReportsRealChange(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(w.Root, "sample.txt")
	if err := os.WriteFile(file, []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.Root, ".env"), []byte("SECRET=old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "sample.txt", ".env"}, {"-c", "user.name=Lake Test", "-c", "user.email=lake@example.invalid", "commit", "-qm", "initial"}} {
		if out, err := exec.Command("git", append([]string{"-C", w.Root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
	}
	if err := os.WriteFile(file, []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.Root, "new.txt"), []byte("new line\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.Root, ".env"), []byte("SECRET=hidden\n"), 0600); err != nil {
		t.Fatal(err)
	}
	diff, err := w.GitDiff(context.Background())
	if err != nil || !strings.Contains(diff, "-before") || !strings.Contains(diff, "+after") || !strings.Contains(diff, "+new line") || strings.Contains(diff, "SECRET=hidden") {
		t.Fatalf("diff=%q err=%v", diff, err)
	}
}
