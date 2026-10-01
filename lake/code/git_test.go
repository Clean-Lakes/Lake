package code

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitTestCommand(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
}

func TestGitOverviewAndDiffExcludeSensitiveFiles(t *testing.T) {
	root := t.TempDir()
	gitTestCommand(t, root, "init", "-q")
	gitTestCommand(t, root, "config", "user.email", "test@example.invalid")
	gitTestCommand(t, root, "config", "user.name", "Lake Test")
	if err := os.WriteFile(filepath.Join(root, "safe.txt"), []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestCommand(t, root, "add", "safe.txt")
	gitTestCommand(t, root, "commit", "-qm", "initial")
	if err := os.WriteFile(filepath.Join(root, "safe.txt"), []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("private\n"), 0600); err != nil {
		t.Fatal(err)
	}
	w, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	overview, err := w.GitOverview(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Files) != 1 || overview.Files[0].Path != "safe.txt" {
		t.Fatalf("files=%+v", overview.Files)
	}
	if len(overview.Commits) != 1 || overview.Commits[0].Subject != "initial" {
		t.Fatalf("commits=%+v", overview.Commits)
	}
	if !strings.Contains(overview.Graph, "initial") {
		t.Fatalf("graph=%q", overview.Graph)
	}
	diff, err := w.GitDiffForPath(context.Background(), "safe.txt")
	if err != nil || !strings.Contains(diff, "+after") {
		t.Fatalf("diff=%q error=%v", diff, err)
	}
	gitTestCommand(t, root, "add", "safe.txt")
	diff, err = w.GitDiffForPath(context.Background(), "safe.txt")
	if err != nil || !strings.Contains(diff, "+after") {
		t.Fatalf("staged diff=%q error=%v", diff, err)
	}
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("new line\n"), 0600); err != nil {
		t.Fatal(err)
	}
	diff, err = w.GitDiffForPath(context.Background(), "new.txt")
	if err != nil || !strings.Contains(diff, "+new line") {
		t.Fatalf("untracked diff=%q error=%v", diff, err)
	}
	if _, err := w.GitDiffForPath(context.Background(), ".env"); err == nil {
		t.Fatal("sensitive diff allowed")
	}
}
