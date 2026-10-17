package web

import (
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/hinshun/vt10x"
)

func TestConsoleEnvironmentUsesConnectionOverrides(t *testing.T) {
	inherited := []string{"SSH_ASKPASS=0-stale-helper", "Path=old", "LAKE_SSH_SECRET_REF=0-stale-reference", "=C:=C:\\old", "SSH_ASKPASS=correct-helper", "PATH=correct", "LAKE_SSH_SECRET_REF=correct-reference", "__lake_init=correct-init", "=D:=D:\\other"}
	original := append([]string(nil), inherited...)
	got := consoleTerminalEnvironment(inherited)
	want := []string{"=C:=C:\\old", "=D:=D:\\other", "LAKE_SSH_SECRET_REF=correct-reference", "PATH=correct", "SSH_ASKPASS=correct-helper", "__lake_init=correct-init"}
	if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(inherited, original) {
		t.Fatal("ConPTY retained stale inherited authentication values or changed its caller's environment")
	}
}

func TestConsoleSSHInitializationUsesSameFramesAsLocalShell(t *testing.T) {
	marker := "\x1eLAKE_READY_fixture\x1f"
	initialization := terminalInit("sh", marker)
	args := sshArguments(Object{"host": "example.invalid", "port": 22, "username": "fixture", "authMethod": "key", "identityFile": "C:/private folder/id_fixture"}, initialization)
	cmd := exec.Command(`C:\Program Files\Lake\git\usr\bin\ssh.exe`, args...)
	cmd.Env = []string{"HOME=C:/fixture", "__LAKE_INIT=" + initialization, "UNRELATED=kept"}
	originalArgs, originalEnv := append([]string(nil), cmd.Args...), append([]string(nil), cmd.Env...)
	converted, env := consoleTerminalCommand(cmd)
	if !reflect.DeepEqual(converted[:len(converted)-1], cmd.Args[:len(cmd.Args)-1]) || !reflect.DeepEqual(cmd.Args, originalArgs) || !reflect.DeepEqual(cmd.Env, originalEnv) {
		t.Fatal("console preparation changed SSH configuration or caller-owned data")
	}
	if !strings.Contains(converted[len(converted)-1], "LAKE_FRAME_READY_fixture") || !strings.Contains(env[1], "LAKE_FRAME_READY_fixture") || env[2] != "UNRELATED=kept" {
		t.Fatal("SSH initialization bypassed the ConPTY frame transport")
	}
	remote := exec.Command(platform.Executable("/bin/sh"), "-c", converted[len(converted)-1])
	remote.Env = platform.Environment(t.TempDir())
	remote.Stdin = strings.NewReader("eval \"$__lake_init\"\nexit\n")
	output, err := remote.Output()
	if err != nil {
		t.Fatal("converted remote shell initialization failed", err)
	}
	if !strings.Contains(string(output), consoleFramePrefix+"READY_fixture") {
		t.Fatal("remote initialization did not emit a ConPTY-safe readiness frame")
	}
	var decoder consoleFrameDecoder
	if !strings.Contains(decoder.feed(string(output), true), marker) {
		t.Fatal("remote readiness was not restored for the terminal manager")
	}
}

func TestConsoleFramesRoundTripEveryByteBoundary(t *testing.T) {
	data := "中文\x1b]0;normal title\a" + consoleFramePrefix + "READY_fixture\a" + consoleHookPrefix + "9003;0;/tmp\x1b\\" + consoleFramePrefix + "DONE_fixture:0\a尾部"
	want := "中文\x1b]0;normal title\a\x1eLAKE_READY_fixture\x1f\x1b]9003;0;/tmp\a\x1eLAKE_DONE_fixture:0\x1f尾部"
	for split := 0; split <= len(data); split++ {
		var decoder consoleFrameDecoder
		got := decoder.feed(data[:split], false) + decoder.feed(data[split:], false) + decoder.feed("", true)
		if got != want {
			t.Fatalf("frame split %d changed terminal bytes", split)
		}
	}
	var decoder consoleFrameDecoder
	var got strings.Builder
	for i := range []byte(data) {
		got.WriteString(decoder.feed(data[i:i+1], false))
	}
	got.WriteString(decoder.feed("", true))
	if got.String() != want {
		t.Fatal("byte-wise frame decoding corrupted output")
	}
}

func TestConsoleCoalescedStartupTitleRetainsNonceAndCwd(t *testing.T) {
	// The standalone READY title was dropped; only the final cwd title remains.
	data := consoleReadyHookPrefix + "fixture;9003;0;/root/中文 dir\x1b\\prompt"
	want := "\x1eLAKE_READY_fixture\x1f\x1b]9003;0;/root/中文 dir\aprompt"
	for split := 0; split <= len(data); split++ {
		var decoder consoleFrameDecoder
		got := decoder.feed(data[:split], false) + decoder.feed(data[split:], true)
		if got != want {
			t.Fatalf("coalesced startup split %d lost readiness or cwd", split)
		}
		// Later prompts still update cwd without leaking repeated READY markers.
		if got := decoder.feed(data, true); strings.Contains(got, "LAKE_READY") || !strings.Contains(got, "9003;0;/root/") {
			t.Fatal("repeated prompt leaked private startup marker")
		}
	}
	var decoder consoleFrameDecoder
	decoder.feed(consoleFramePrefix+"READY_fixture\a", false)
	if got := decoder.feed(data, true); strings.Contains(got, "LAKE_READY") {
		t.Fatal("fallback duplicated an already observed startup marker")
	}
	encoded := consoleTerminalScript(terminalInit("bash", "\x1eLAKE_READY_fixture\x1f", true))
	if !strings.Contains(encoded, `\033]0;LAKE_READY_HOOK_fixture;9003;`) {
		t.Fatal("startup nonce was not retained in the prompt hook")
	}
}

func TestConsoleFramesPreserveUserInputAndBoundPartialFrames(t *testing.T) {
	for _, input := range []string{"ls", `printf '\037'`, "printf '中文\\n'", "\x1b[A\x03"} {
		if consoleTerminalScript(input) != input {
			t.Fatal("ordinary input was rewritten")
		}
	}
	encoded := consoleTerminalScript(`printf '\036LAKE_DONE_fixture:%s\037\n' "$status"; printf '\033]9003;0;%s\007' "$PWD"`)
	if !strings.Contains(encoded, `\033]0;LAKE_FRAME_DONE_fixture:%s\007`) || !strings.Contains(encoded, `\033]0;LAKE_HOOK_9003;`) {
		t.Fatal("private controls were not wrapped for ConPTY")
	}
	var decoder consoleFrameDecoder
	if got := decoder.feed(consoleFramePrefix+strings.Repeat("x", 17000), false); len(decoder.pending) != 0 || got != "[invalid console frame]" {
		t.Fatal("unbounded console frame")
	}
}

func TestConsoleFramesRestoreReadyAndManagedCompletionBeforePersistence(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Store.CreateTerminal(id, ref)
	l := &liveTerminal{id: stringOf(term["id"]), session: id, readyMarker: "\x1eLAKE_READY_fixture\x1f", connected: make(chan struct{}), screen: vt10x.New(vt10x.WithSize(100, 30)), shell: "bash"}
	l.startup = time.AfterFunc(time.Hour, func() {})
	defer func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.closed = true
		l.startup.Stop()
		if l.flush != nil {
			l.flush.Stop()
		}
	}()
	var decoder consoleFrameDecoder
	b.Terminals.receive(l, decoder.feed(consoleFramePrefix+"READY_fixture\a", false))
	if !l.ready {
		t.Fatal("ConPTY readiness frame was not restored")
	}
	entry := b.Store.BeginCommand(id, l.id, "user", "printf fixture", "")
	l.job = &terminalJob{entry: entry, marker: "fixture", done: make(chan struct{})}
	job := l.job
	b.Terminals.receive(l, decoder.feed("console output"+consoleFramePrefix+"DONE_fixture:0\a", false))
	select {
	case <-job.done:
	default:
		t.Fatal("ConPTY completion frame did not finish command")
	}
	stored := b.Store.Entry(id, l.id, stringOf(entry["id"]))
	if stored["status"] != "completed" || stringOf(stored["output"]) != "console output" || integer(stored["exitCode"]) != 0 {
		t.Fatal("managed result corrupted")
	}
	if strings.Contains(stringOf(b.Store.History(id, l.id)["output"]), "LAKE_") {
		t.Fatal("private console frames reached visible history")
	}
}
