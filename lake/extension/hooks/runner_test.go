package hooks

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testHookWorkspace(t *testing.T, declaration string) (string, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".lake"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ".lake", "hooks.json")
	if err := os.WriteFile(path, []byte(declaration), 0600); err != nil {
		t.Fatal(err)
	}
	return root, path
}

func TestHookDefaultDenyApprovalAndDigestInvalidation(t *testing.T) {
	root, path := testHookWorkspace(t, `{"version":1,"hooks":[{"event":"SessionStart","command":"hook.sh"}]}`)
	marker := filepath.Join(root, "ran")
	script := "#!/bin/sh\necho ran > ran\necho ok\n"
	if err := os.WriteFile(filepath.Join(root, "hook.sh"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	runner, err := Load(root)
	if err != nil || len(runner.Digest) != 64 {
		t.Fatalf("hook config=%+v err=%v", runner, err)
	}
	if _, err := runner.Run(context.Background(), SessionStart, nil, func(_, _, _ string) (bool, error) { return true, nil }); err != ErrDisabled {
		t.Fatalf("hook default state: %v", err)
	}
	runner.Enabled = true
	results, err := runner.Run(context.Background(), SessionStart, nil, func(_, _, _ string) (bool, error) { return false, nil })
	if err != nil || len(results) != 1 || results[0].Status != "denied" {
		t.Fatalf("denied hook=%+v err=%v", results, err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("denied hook executed")
	}
	t.Setenv("LAKE_HOOK_PARENT_SECRET", "test-only-secret")
	results, err = runner.Run(context.Background(), SessionStart, nil, func(kind, _, _ string) (bool, error) { return kind == "hook", nil })
	if err != nil || len(results) != 1 || results[0].Status != "completed" || !strings.Contains(results[0].Stdout, "ok") {
		t.Fatalf("approved hook=%+v err=%v", results, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "hook.sh"), []byte(script+"echo changed\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Run(context.Background(), SessionStart, nil, func(_, _, _ string) (bool, error) { return true, nil }); err != ErrChanged {
		t.Fatalf("changed Hook command retained permission: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "hook.sh"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"hooks":[{"event":"SessionStart","command":"hook.sh","args":["changed"]}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := runner.Run(context.Background(), SessionStart, nil, func(_, _, _ string) (bool, error) { return true, nil }); err != ErrChanged {
		t.Fatalf("changed hook declaration retained permission: %v", err)
	}
}

func TestHookRejectsEscapesAndBoundsOutput(t *testing.T) {
	for _, command := range []string{"../outside.sh", "/bin/sh"} {
		root, _ := testHookWorkspace(t, `{"version":1,"hooks":[{"event":"PreToolUse","command":"`+command+`"}]}`)
		if _, err := Load(root); err == nil {
			t.Fatalf("escaped command accepted: %s", command)
		}
	}
	root, _ := testHookWorkspace(t, `{"version":1,"hooks":[{"event":"PreToolUse","command":"hook.sh"}]}`)
	if err := os.WriteFile(filepath.Join(root, "hook.sh"), []byte("#!/bin/sh\nprintf '%10000s' x\n"), 0700); err != nil {
		t.Fatal(err)
	}
	runner, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	runner.Enabled = true
	results, err := runner.Run(context.Background(), PreToolUse, map[string]string{"tool": "demo"}, func(_, _, _ string) (bool, error) { return true, nil })
	if err != nil || len(results) != 1 || len(results[0].Stdout) > 8192 || !results[0].Truncated {
		length := 0
		if len(results) != 0 {
			length = len(results[0].Stdout)
		}
		t.Fatalf("unbounded output: length=%d err=%v", length, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if _, err := runner.Run(ctx, PreToolUse, nil, func(_, _, _ string) (bool, error) { return true, nil }); err == nil {
		t.Fatal("cancelled hook context was accepted")
	}
}

func TestHookRejectsSymlinkEscapeAndReportsRuntimeTimeout(t *testing.T) {
	outside := filepath.Join(t.TempDir(), "outside.sh")
	if err := os.WriteFile(outside, []byte("#!/bin/sh\necho outside\n"), 0700); err != nil {
		t.Fatal(err)
	}
	root, _ := testHookWorkspace(t, `{"version":1,"hooks":[{"event":"PreToolUse","command":"hook.sh"}]}`)
	path := filepath.Join(root, "hook.sh")
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root); err == nil {
		t.Fatal("symlink escape was accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\nwhile :; do :; done\n"), 0700); err != nil {
		t.Fatal(err)
	}
	runner, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	runner.Enabled = true
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	results, err := runner.Run(ctx, PreToolUse, nil, func(_, _, _ string) (bool, error) { return true, nil })
	if err == nil || len(results) != 1 || results[0].Status != "failed" {
		t.Fatalf("timeout result=%+v err=%v", results, err)
	}
}
