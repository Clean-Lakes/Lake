package web

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestRemoteShellCwdKeepsTargetFilesystemPaths(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Store.CreateTerminal(id, ref)
	l := &liveTerminal{id: stringOf(term["id"]), session: id, shell: "sh", remote: true}
	want := "/root/远程 directory"
	b.Terminals.hook(l, "9003;0;"+want)
	if !l.hooks || b.Store.Terminal(id, l.id)["cwd"] != want {
		t.Fatal("remote cwd was interpreted as a local client path")
	}
	for _, invalid := range []string{"relative/path", "C:/local/path", "/root/\x1b[31m", "/root/\ninvalid"} {
		b.Terminals.hook(l, "9003;0;"+invalid)
		if b.Store.Terminal(id, l.id)["cwd"] != want {
			t.Fatal("invalid remote cwd replaced the observation")
		}
	}
}

func TestShellHooksPersistentStateAndCapabilities(t *testing.T) {
	for _, shell := range []string{"sh", "bash", "zsh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			if _, err := exec.LookPath(shell); err != nil {
				t.Skip(shell + " unavailable")
			}
			b, h := fixture(t)
			id, ref := newSession(t, h)
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			term := b.Terminals.OpenShell(ctx, id, ref, shell)
			tid := stringOf(term["id"])
			deadline := time.Now().Add(time.Second)
			for b.Terminals.Capabilities(id, tid)["commandBlocks"] != true && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if b.Terminals.Capabilities(id, tid)["commandBlocks"] != true {
				t.Fatal("hooks handshake failed", shell)
			}
			dir := t.TempDir()
			command := "cd " + quote(dir) + "; export LAKE_HOOK_VALUE=kept"
			if shell == "fish" {
				command = "cd " + quote(dir) + "; set -gx LAKE_HOOK_VALUE kept"
			}
			run := func(command string) Object {
				entry := b.Terminals.Execute(id, tid, "user", command, "")
				return b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
			}
			result := run(command)
			if result["exitCode"] == nil || integer(result["exitCode"]) != 0 {
				t.Fatal(result)
			}
			result = run("printf '%s:%s' \"$PWD\" \"$LAKE_HOOK_VALUE\"")
			if !strings.Contains(stringOf(result["output"]), dir+":kept") {
				t.Fatal(result)
			}
			deadline = time.Now().Add(time.Second)
			for b.Store.Terminal(id, tid)["cwd"] != dir && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if b.Store.Terminal(id, tid)["cwd"] != dir {
				t.Fatal("cwd not observed", b.Store.Terminal(id, tid))
			}
			run("printf repeat")
			run("printf repeat")
			b.Terminals.Close(id, tid)
			if b.Terminals.Capabilities(id, tid)["commandBlocks"] != false {
				t.Fatal("closed terminal advertises execution")
			}
		})
	}
}

func TestShellHookPartialFramesBounded(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	l := b.Terminals.get(id, tid)
	l.mu.Lock()
	defer l.mu.Unlock()
	out := b.Terminals.stripHooks(l, "prefix\x1b]900")
	if out != "prefix" {
		t.Fatal(out)
	}
	out = b.Terminals.stripHooks(l, "3;0;/tmp\a suffix")
	if out != " suffix" || b.Store.Terminal(id, tid)["cwd"] != "/tmp" {
		t.Fatal(out)
	}
	b.Terminals.stripHooks(l, "\x1b]9003;"+strings.Repeat("x", 17000))
	if l.hooks || len(l.hookPartial) > 16384 {
		t.Fatal("unbounded frame")
	}
}

func TestRawAgentInputHooksCaptureOutputAndCompletion(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			if _, err := exec.LookPath(shell); err != nil {
				t.Skip(shell + " unavailable")
			}
			b, h := fixture(t)
			id, ref := newSession(t, h)
			term := b.Terminals.OpenShell(context.Background(), id, ref, shell)
			tid := stringOf(term["id"])
			b.Terminals.Control(id, tid, "agent")
			if _, err := b.bridge(context.Background(), id, "terminal_send_input", Object{"terminal_id": tid, "input": "printf raw-hook-result", "append_enter": true}, true); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(2 * time.Second)
			for b.Store.Terminal(id, tid)["status"] != "ready" && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			entries := objects(b.Store.History(id, tid)["entries"])
			if len(entries) != 1 || entries[0]["status"] != "completed" || !strings.Contains(stringOf(entries[0]["output"]), "raw-hook-result") {
				t.Fatal("raw input not captured", entries)
			}
		})
	}
}

func TestShellExitAndExecDoNotReplayUnknownCommands(t *testing.T) {
	for _, shell := range []string{"sh", "bash", "zsh", "fish"} {
		program, err := exec.LookPath("true")
		if err != nil {
			t.Fatal(err)
		}
		for _, command := range []string{"exit 0", "exec " + quote(program)} {
			t.Run(shell+"/"+command, func(t *testing.T) {
				if _, err := exec.LookPath(shell); err != nil {
					t.Skip(shell + " unavailable")
				}
				b, h := fixture(t)
				id, ref := newSession(t, h)
				ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
				defer cancel()
				term := b.Terminals.OpenShell(ctx, id, ref, shell)
				tid := stringOf(term["id"])
				entry := b.Terminals.Execute(id, tid, "user", command, "")
				result := b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
				if result["status"] != "unknown" || result["exitCode"] != nil || b.Terminals.Capabilities(id, tid)["commandBlocks"] != false {
					t.Fatal("shell exit claimed a framed success or retained execution", result)
				}
				fresh := b.Terminals.OpenShell(ctx, id, ref, shell)
				if fresh["generation"] == term["generation"] {
					t.Fatal("shell generation reused")
				}
				if len(objects(b.Store.History(id, stringOf(fresh["id"]))["entries"])) != 0 {
					t.Fatal("interrupted command replayed")
				}
			})
		}
	}
}

func TestHookFailureKeepsScreenButRejectsExecute(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash unavailable")
	}
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.OpenShell(context.Background(), id, ref, "bash")
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	// Hold input stable; inject malformed integration data, not a command.
	l := b.Terminals.get(id, tid)
	l.mu.Lock()
	b.Terminals.stripHooks(l, "\x1b]9003;"+strings.Repeat("x", 17000))
	l.mu.Unlock()
	caps := b.Terminals.Capabilities(id, tid)
	if caps["screen"] != true || caps["commandBlocks"] != false {
		t.Fatal(caps)
	}
	if _, err := b.bridge(context.Background(), id, "terminal_execute_command", Object{"terminal_id": tid, "command": "pwd"}, true); err == nil {
		t.Fatal("execution bypassed degraded integration")
	}
	if _, err := b.bridge(context.Background(), id, "read_terminal_screen", Object{"terminal_id": tid}, false); err != nil {
		t.Fatal("screen reading lost during downgrade", err)
	}
}
