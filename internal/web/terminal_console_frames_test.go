package web

import (
	"strings"
	"testing"
	"time"

	"github.com/hinshun/vt10x"
)

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
