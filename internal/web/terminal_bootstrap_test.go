package web

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

// The initialization trigger is written into the PTY, and the login shell echoes
// it before the script can turn echo off. A console repaint can repeat that line
// even after the handshake. It is internal plumbing: neither the published output
// nor the VT screen may show it.
func TestInteractiveStartupHidesBootstrapTrigger(t *testing.T) {
	if platform.Executable("/bin/sh") == "sh.exe" {
		t.Skip("bundled shell runtime unavailable")
	}
	for _, shell := range []string{"sh", "bash"} {
		t.Run(shell, func(t *testing.T) {
			b, h := fixture(t)
			id, ref := newSession(t, h)
			term := b.Terminals.OpenInteractive(context.Background(), id, ref, shell)
			tid := stringOf(term["id"])
			time.Sleep(400 * time.Millisecond)
			// A window change makes the console repaint the lines above the prompt.
			b.Terminals.Resize(id, tid, 100, 30)
			b.Terminals.Resize(id, tid, 80, 24)
			time.Sleep(400 * time.Millisecond)
			output := stringOf(b.Store.History(id, tid)["output"])
			if strings.Contains(output, "__lake_init") {
				t.Fatalf("bootstrap trigger leaked into terminal output: %q", output)
			}
			if !strings.Contains(output, "@") {
				t.Fatalf("terminal output lost its prompt: %q", output)
			}
			screen := b.Terminals.Screen(id, tid, "tail", 200, 20000)
			if strings.Contains(screen, "__lake_init") {
				t.Fatalf("bootstrap trigger leaked into the terminal screen: %q", screen)
			}
		})
	}
}
