package web

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/hinshun/vt10x"
)

func TestTerminalRedactionPreservesOrdinaryCredentialPrefixes(t *testing.T) {
	b, _ := fixture(t)
	b.Models.Save(&ai.Model{URL: "http://localhost:9/v1/chat/completions", Name: "fixture", Protocol: "openai", Key: "ls-model-fixture-key"})
	b.Terminals.authSecrets["pwd-password-fixture"] = true
	for _, output := range []string{"[root@server ~]# l", "[root@server ~]# ls", "[root@server ~]# pwd", "inspect processes", "中文提示 s", "\x1b[32mprompt\x1b[0m ls"} {
		if got := b.Terminals.redact(output); got != output {
			t.Errorf("ordinary terminal text changed: got %q, want %q", got, output)
		}
	}
	if got := b.Terminals.redact("ls-model-fixture-key pwd-password-fixture synthetic-test-auth-token"); got != "[REDACTED] [REDACTED] [REDACTED]" {
		t.Fatal("complete model, SSH and browser credentials must remain redacted")
	}
}

func TestTerminalRedactionAcrossReceivedChunksAndSnapshots(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Store.CreateTerminal(id, ref)
	l := &liveTerminal{id: stringOf(term["id"]), session: id, ready: true, screen: vt10x.New(vt10x.WithSize(100, 30))}
	defer func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.closed = true
		if l.flush != nil {
			l.flush.Stop()
		}
	}()
	appendAndFlush := func(chunk string) string {
		t.Helper()
		b.Terminals.receive(l, chunk)
		l.mu.Lock()
		b.Terminals.flush(l)
		l.mu.Unlock()
		return stringOf(b.Store.History(id, l.id)["output"])
	}
	for _, chunk := range []string{"prompt l", "s"} {
		got := appendAndFlush(chunk)
		if strings.Contains(got, "[REDACTED]") {
			t.Fatal("ordinary per-keystroke echo was redacted")
		}
	}
	// Every flush is derived from the retained raw snapshot, so a credential
	// split across arbitrary PTY reads still matches once its last byte arrives.
	for _, chunk := range []string{"\r\nsynthetic-", "test-auth-", "token"} {
		got := appendAndFlush(chunk)
		if strings.Contains(got, "synthetic-test-auth-token") {
			t.Fatal("complete credential reached stored output")
		}
	}
	if got := stringOf(b.Store.History(id, l.id)["output"]); got != "prompt ls\r\n[REDACTED]" {
		t.Fatal("split credential was not redacted in the accumulated output")
	}
	if got := b.Terminals.screenLocked(l, "tail", 30, 10000); got != "prompt ls\n[REDACTED]" {
		t.Fatal("screen observation did not preserve commands and redact credentials")
	}
}

func TestInteractiveKeystrokesDoNotRedactCommandEndings(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	b.Models.Save(&ai.Model{URL: "http://localhost:9/v1/chat/completions", Name: "fixture", Protocol: "openai", Key: "ls-model-fixture-key"})
	term := b.Terminals.OpenInteractive(context.Background(), id, ref, "bash")
	tid := stringOf(term["id"])
	for _, step := range []struct{ input, suffix string }{{"l", "l"}, {"s", "ls"}, {"\x7f", "l"}, {"s", "ls"}} {
		b.Terminals.Input(id, tid, step.input, false)
		deadline := time.Now().Add(2 * time.Second)
		for {
			screen := strings.TrimSpace(b.Terminals.Screen(id, tid, "tail", 30, 10000))
			if strings.HasSuffix(screen, "# "+step.suffix) || strings.HasSuffix(screen, "$ "+step.suffix) {
				l := b.Terminals.get(id, tid)
				l.mu.Lock()
				b.Terminals.flush(l)
				l.mu.Unlock()
				output := stringOf(b.Store.History(id, tid)["output"])
				if strings.Contains(output, "[REDACTED]") {
					t.Fatal("stored echo contains a false credential marker")
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("interactive command echo was not preserved")
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	b.Terminals.Input(id, tid, "\x15", false) // Clear the unexecuted command.
}
