//go:build windows

package web

import (
	"context"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWindowsBootstrapAlignsScreenBeforeReady(t *testing.T) {
	for _, shell := range []string{"sh", "bash"} {
		for _, interactive := range []bool{false, true} {
			marker := "\x1eLAKE_READY_fixture\x1f"
			cmd := exec.Command(shellProgram(shell), "-c", terminalInit(shell, marker, interactive))
			cmd.Env = platform.Environment(t.TempDir())
			output, err := cmd.Output()
			if err != nil {
				t.Fatal(err)
			}
			text := string(output)
			reset := "\x1b[H\x1b[2J"
			if strings.Count(text, reset) != 1 || strings.Index(text, reset) > strings.Index(text, marker) {
				t.Fatalf("%s bootstrap did not align ConPTY before readiness: %q", shell, text)
			}
		}
	}
	for _, input := range []string{"echo example", "stty -echo\nprintf example"} {
		if strings.Contains(consoleTerminalScript(input), `\033[2J`) {
			t.Fatal("ordinary input cleared the screen")
		}
	}
}

// Opt-in end-to-end check against an isolated Linux sshd, with /bin/sh backed
// by Bash (as on common RHEL hosts). Unlike the synthetic auth fixture, this
// exercises the remote line editor and ConPTY's screen repaint together.
func TestWindowsRealSSHInitialPrompt(t *testing.T) {
	host := os.Getenv("LAKE_TEST_SSH_PROMPT_HOST")
	if host == "" {
		t.Skip("requires isolated SSH prompt fixture")
	}
	key, err := os.ReadFile(os.Getenv("LAKE_TEST_SSH_PROMPT_PUBLIC_KEY"))
	if err != nil {
		t.Fatal(err)
	}
	b, h := fixture(t)
	id, _ := newSession(t, h)
	known := filepath.Join(t.TempDir(), "known_hosts")
	if err = os.WriteFile(known, []byte(fmt.Sprintf("[%s]:39022 %s", host, key)), 0600); err != nil {
		t.Fatal(err)
	}
	b.Terminals.KnownHosts = known
	cfg, cleanup := prepareSSH(b.Models.Home, Object{"host": host, "port": 39022, "username": "fixture", "authMethod": "password", "password": "synthetic-prompt-test", "shell": "sh"})
	defer cleanup()
	r := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "isolated Linux prompt", "ssh", cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	term := b.Terminals.OpenInteractive(ctx, id, stringOf(r["id"]), "sh")
	tid := stringOf(term["id"])
	time.Sleep(300 * time.Millisecond)
	for _, cols := range []int{55, 120, 70} {
		b.Terminals.Resize(id, tid, cols, 40)
		time.Sleep(300 * time.Millisecond)
		screen := strings.TrimSpace(b.Terminals.Screen(id, tid, "viewport", 40, 10000))
		if strings.Count(screen, "fixture@") != 1 {
			t.Errorf("%d-column initial screen has duplicate prompts: %q; transport=%q", cols, screen, b.Store.History(id, tid)["output"])
		}
	}
}
