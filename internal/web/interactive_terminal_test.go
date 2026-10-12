package web

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestInteractiveUserShellPromptInputAndCompletion(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "sh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			if _, err := exec.LookPath(shell); err != nil {
				t.Skip("shell unavailable")
			}
			b, h := fixture(t)
			id, ref := newSession(t, h)
			term := b.Terminals.OpenInteractive(context.Background(), id, ref, shell)
			tid := stringOf(term["id"])
			if term["interactive"] != true || b.sessionSnapshot(id)["terminals"] == nil {
				t.Fatal("missing interactive metadata")
			}
			b.Terminals.Input(id, tid, "printf 'classic-shell-result\\n'\r", false)
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				history := b.Store.History(id, tid)
				if strings.Contains(stringOf(history["output"]), "classic-shell-result\r\n") && b.Store.Terminal(id, tid)["status"] == "ready" {
					if !strings.Contains(stringOf(history["output"]), "@") {
						t.Fatal("real shell prompt missing")
					}
					if shell != "sh" && len(objects(history["entries"])) != 1 {
						t.Fatal("raw command was not recorded")
					}
					b.Terminals.Input(id, tid, "\x1b[A", false) // Shell history navigation is accepted at the prompt.
					b.Terminals.Input(id, tid, "\x03", false)
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			t.Fatal("interactive command did not finish", b.Store.Terminal(id, tid)["status"])
		})
	}
}
func TestManagedTerminalStillRejectsIdleUserRawInput(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	apiTest(t, h, "POST", "/api/sessions/"+id+"/terminals/"+tid+"/input", Object{"data": "pwd\r"}, 409)
	raw := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	rawID := stringOf(raw["id"])
	b.Terminals.Control(id, rawID, "agent")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/terminals/"+rawID+"/input", Object{"data": "pwd\r"}, 409)
}
