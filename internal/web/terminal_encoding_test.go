package web

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/hinshun/vt10x"
)

func TestTerminalUTF8ChunksStayValidAcrossFlushes(t *testing.T) {
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
	data := "中文终端🚀\r\n\x1b[35m彩色提示符\x1b[0m\x1b]9003;0;/tmp/中文\a"
	want := "中文终端🚀\r\n\x1b[35m彩色提示符\x1b[0m"
	for i := range []byte(data) {
		b.Terminals.receive(l, data[i:i+1])
		l.mu.Lock()
		b.Terminals.flush(l)
		l.mu.Unlock()
		output := stringOf(b.Store.History(id, l.id)["output"])
		if !utf8.ValidString(output) || strings.Contains(output, "\ufffd") || !strings.HasPrefix(want, output) {
			t.Fatalf("invalid output at split %d: %q", i, output)
		}
	}
	if got := stringOf(b.Store.History(id, l.id)["output"]); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if got := b.Store.Terminal(id, l.id)["cwd"]; got != "/tmp/中文" {
		t.Fatalf("split cwd hook = %v", got)
	}
}
