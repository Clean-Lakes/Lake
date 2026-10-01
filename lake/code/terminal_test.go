package code

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTerminalSessionFixedRootAndClose(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := NewTerminalSession(w)
	if err != nil {
		t.Fatal(err)
	}
	result, err := session.Run(context.Background(), "pwd")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(result.Stdout) != w.Root || result.WorkingDirectory != w.Root || result.User == "" {
		t.Fatalf("result=%+v", result)
	}
	t.Setenv("LAKE_TERMINAL_TEST_SECRET", "must-not-pass")
	result, err = session.Run(context.Background(), `printf '%s' "$LAKE_TERMINAL_TEST_SECRET"`)
	if err != nil || result.Stdout != "" {
		t.Fatalf("terminal inherited private environment: %+v %v", result, err)
	}
	if _, err := session.Run(context.Background(), "pwd\nwhoami"); err == nil {
		t.Fatal("multiple lines accepted")
	}
	session.Close()
	if _, err := session.Run(context.Background(), "pwd"); err == nil {
		t.Fatal("closed session accepted command")
	}
}

func TestTerminalCloseCancelsRunningShell(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session, err := NewTerminalSession(w)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := session.Run(context.Background(), "sleep 30"); done <- err }()
	deadline := time.Now().Add(time.Second)
	for {
		session.mu.Lock()
		started := session.cancel != nil
		session.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shell did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	session.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("close did not cancel shell")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shell survived session close")
	}
}

func TestTerminalRetainsDirectoryAndEnvironment(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(w.Root, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	s, err := NewTerminalSession(w)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first, err := s.Run(context.Background(), "cd sub && export LAKE_TASK_VALUE=kept")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Run(context.Background(), `printf '%s\n' "$LAKE_TASK_VALUE"; pwd; printf err >&2; false`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(second.Stdout, "kept\n") || second.ExitCode != 1 || second.Stderr != "err" || second.WorkingDirectory != first.NextDirectory || s.CurrentDirectory() != filepath.Join(w.Root, "sub") {
		t.Fatalf("persistent state failed: %+v", second)
	}
	// PWD is editable shell state; directory metadata must come from the shell's
	// actual physical directory rather than trusting that variable.
	spoofed, err := s.Run(context.Background(), "export PWD=/pretend")
	if err != nil || spoofed.NextDirectory != filepath.Join(w.Root, "sub") || s.CurrentDirectory() != filepath.Join(w.Root, "sub") {
		t.Fatalf("editable PWD changed directory metadata: %+v %v", spoofed, err)
	}
}

func TestStreamTerminalProtocolAndBrokenShell(t *testing.T) {
	// Match the remote fd3/stdout transport with a real, disposable local shell.
	cmd := exec.Command("sh", "-c", "exec 3>&1; exec sh")
	cmd.Dir = t.TempDir()
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	errout, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s, err := NewStreamTerminal(cmd.Dir, "test", in, out, errout, func() error { return cmd.Process.Kill() })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	defer cmd.Wait()
	result, err := s.Run(context.Background(), "export LAKE_STREAM_VALUE=kept; printf abc; printf def >&2")
	if err != nil || result.Stdout != "abc" || result.Stderr != "def" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	result, err = s.Run(context.Background(), `printf '%s' "$LAKE_STREAM_VALUE"`)
	if err != nil || result.Stdout != "kept" {
		t.Fatalf("state not retained: %+v %v", result, err)
	}
	if _, err = s.Run(context.Background(), "exit 0"); err == nil || !s.IsClosed() {
		t.Fatal("broken protocol was not closed")
	}
}
