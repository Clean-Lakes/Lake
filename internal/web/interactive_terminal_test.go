package web

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestInteractiveStartupShowsOneHomePrompt(t *testing.T) {
	for _, shell := range []string{"sh", "bash", "zsh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			if _, err := exec.LookPath(shell); err != nil {
				t.Skip("shell unavailable")
			}
			b, h := fixture(t)
			id, ref := newSession(t, h)
			term := b.Terminals.OpenInteractive(context.Background(), id, ref, shell)
			tid := stringOf(term["id"])
			time.Sleep(250 * time.Millisecond)
			home, _ := os.UserHomeDir()
			if cwd := stringOf(b.Store.Terminal(id, tid)["cwd"]); cwd != home {
				t.Fatalf("cwd = %q, want home %q", cwd, home)
			}
			output := stringOf(b.Store.History(id, tid)["output"])
			if strings.Count(output, "@") != 1 {
				t.Fatalf("startup emitted extra prompts: %q", output)
			}
			screen := strings.TrimSpace(b.Terminals.Screen(id, tid, "viewport", 30, 10000))
			if !regexp.MustCompile(`^\[[^\]\r\n]+ ~\][#$%]$`).MatchString(screen) {
				t.Fatalf("expected one home prompt: %q", screen)
			}
		})
	}
}

func TestInteractiveShPromptRedrawUsesVisibleWidth(t *testing.T) {
	if err := exec.Command("/bin/sh", "-c", `test -n "${BASH_VERSION-}"`).Run(); err != nil {
		t.Skip("/bin/sh is not Bash")
	}
	b, h := fixture(t)
	id, ref := newSession(t, h)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	term := b.Terminals.OpenInteractive(ctx, id, ref, "sh")
	tid := stringOf(term["id"])
	b.Terminals.Input(id, tid, "cd /tmp\r", false)
	deadline := time.Now().Add(2 * time.Second)
	for b.Store.Terminal(id, tid)["cwd"] != "/tmp" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if b.Store.Terminal(id, tid)["cwd"] != "/tmp" {
		t.Fatal("shell did not enter test directory")
	}
	for _, cols := range []int{120, 80, 50, 100} {
		b.Terminals.Resize(id, tid, cols, 30)
		time.Sleep(100 * time.Millisecond)
		b.Terminals.Input(id, tid, "\x0c", false) // Readline redraw, without running a command.
		time.Sleep(100 * time.Millisecond)
		// A long CI hostname can wrap across rows in a narrow terminal.
		screen := strings.ReplaceAll(strings.TrimSpace(b.Terminals.Screen(id, tid, "viewport", 30, 10000)), "\n", "")
		if !regexp.MustCompile(`^\[[^\]\r\n]+ /tmp\][#$]$`).MatchString(screen) {
			t.Fatalf("prompt corrupted after resize to %d columns: %q", cols, screen)
		}
	}
}

func TestInitialTerminalResizePreservesInputAndHistory(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	tid := stringOf(term["id"])
	b.Terminals.Resize(id, tid, 40, 25)
	time.Sleep(150 * time.Millisecond)
	screen := b.Terminals.Screen(id, tid, "viewport", 25, 10000)
	if strings.Count(screen, "@") != 1 {
		t.Fatalf("initial narrow prompt duplicated: %q", screen)
	}
	b.Terminals.Input(id, tid, "printf 'preserved-history\\n'\r", false)
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "preserved-history\r\n") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	b.Terminals.Input(id, tid, "printf 'preserved-", false)
	b.Terminals.Resize(id, tid, 120, 25)
	time.Sleep(100 * time.Millisecond)
	// A resize can move old output from the viewport into scrollback.
	// The durable terminal history must retain the completed command.
	if !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "preserved-history\r\n") {
		t.Fatal("resize cleared command history")
	}
	b.Terminals.Input(id, tid, "input\\n'\r", false)
	deadline = time.Now().Add(2 * time.Second)
	for !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "preserved-input\r\n") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "preserved-input\r\n") {
		t.Fatal("resize lost partially typed command")
	}
}

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
func TestInteractiveOutputOnlyHistorySkipsCommandEntries(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	tid := stringOf(term["id"])
	b.Terminals.Input(id, tid, "printf 'output-only-check\\n'\r", false)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "output-only-check\r\n") && len(objects(b.Store.History(id, tid)["entries"])) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	path := "/api/sessions/" + id + "/terminals/" + tid + "/history"
	full := apiTest(t, h, "GET", path, nil, 200)
	compact := apiTest(t, h, "GET", path+"?outputOnly=1", nil, 200)
	if len(objects(full["entries"])) == 0 || len(objects(compact["entries"])) != 0 {
		t.Fatal("output-only history must omit command entries")
	}
	if compact["output"] != full["output"] || object(compact["terminal"])["interactive"] != true {
		t.Fatal("output-only history lost terminal output or metadata")
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
