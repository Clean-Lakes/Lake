package web

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type securityTerminalDevice struct {
	data   strings.Builder
	closed bool
}

func (d *securityTerminalDevice) Read([]byte) (int, error)          { return 0, io.EOF }
func (d *securityTerminalDevice) Write(p []byte) (int, error)       { return d.WriteString(string(p)) }
func (d *securityTerminalDevice) WriteString(s string) (int, error) { return d.data.WriteString(s) }
func (d *securityTerminalDevice) Close() error                      { d.closed = true; return nil }

func terminalCleanupFixture(t *testing.T) (*Server, string, string, *liveTerminal, *securityTerminalDevice, ai.ExecutionCleanup) {
	t.Helper()
	b, h := fixture(t)
	id, rid := newSession(t, h)
	term := b.Store.CreateTerminal(id, rid)
	tid := stringOf(term["id"])
	b.Store.TerminalStatus(id, tid, "ready")
	b.Store.Control(id, tid, "agent")
	term = b.Store.Terminal(id, tid)
	entry := b.Store.BeginCommand(id, tid, "agent", "echo fixture", "")
	job := &terminalJob{entry: entry, marker: "fixture", done: make(chan struct{}), securityOperationID: "original", securityDescriptorDigest: "original-digest", securityOwnerID: "owner", securityOwnerGeneration: 1}
	device := &securityTerminalDevice{}
	l := &liveTerminal{session: id, id: tid, pty: device, ready: true, job: job}
	b.Terminals.mu.Lock()
	b.Terminals.live[tid] = l
	b.Terminals.securityJobs = map[string]*terminalJob{"original": job}
	b.Terminals.mu.Unlock()
	t.Cleanup(func() { b.Terminals.mu.Lock(); delete(b.Terminals.live, tid); b.Terminals.mu.Unlock() })
	return b, id, tid, l, device, ai.ExecutionCleanup{OperationID: "original", Handle: tid + ":" + stringOf(entry["id"]), DescriptorDigest: "original-digest", OwnerID: "owner", OwnerGeneration: 1}
}
func TestSecurityTerminalCleanupSignalsOnlyOriginalJobAndNeverClosesPTY(t *testing.T) {
	b, _, _, l, d, cleanup := terminalCleanupFixture(t)
	adapter := &securityTerminalCleanup{server: b}
	status, err := adapter.Cancel(t.Context(), cleanup)
	if err != nil || status != ai.CancellationRequested || d.data.String() != "\x03" || d.closed {
		t.Fatal(status, err, d.data.String(), d.closed)
	}
	observation, err := adapter.Observe(t.Context(), cleanup)
	if err != nil || observation.Stopped || observation.EffectsKnown {
		t.Fatal(observation, err)
	}
	l.mu.Lock()
	l.job.changed = true
	l.mu.Unlock()
	if status, err = adapter.Cancel(t.Context(), cleanup); err == nil || status != ai.CancellationUnsupported || d.data.Len() != 1 {
		t.Fatal("human takeover received Agent input", status, err)
	}
	l.mu.Lock()
	l.job.changed = false
	l.job.securityOperationID = "next-job"
	l.mu.Unlock()
	if _, err = adapter.Cancel(t.Context(), cleanup); err == nil || d.data.Len() != 1 {
		t.Fatal("replacement job received signal", err)
	}
	if _, err = adapter.Observe(t.Context(), cleanup); err == nil {
		t.Fatal("replacement job observed as original")
	}
}
func TestSecurityTerminalAgentInputNeedsPermitWhileHumanInputRemainsAvailable(t *testing.T) {
	b, id, tid, _, d, _ := terminalCleanupFixture(t)
	if err := b.inputSecurityTerminal(context.Background(), id, tid, "unapproved\n"); err == nil || d.data.Len() != 0 {
		t.Fatal("raw input reached PTY", err)
	}
	if _, err := b.executeSecurityTerminal(context.Background(), id, tid, "echo unapproved"); err == nil || d.data.Len() != 0 {
		t.Fatal("raw command reached PTY", err)
	}
	b.Store.Control(id, tid, "user")
	b.Terminals.Input(id, tid, "human\n", false)
	if d.data.String() != "human\n" {
		t.Fatal("human terminal path changed", d.data.String())
	}
}
func TestSecurityTerminalCleanupCannotGuessHistoricalEntry(t *testing.T) {
	b, _, _, l, d, cleanup := terminalCleanupFixture(t)
	adapter := &securityTerminalCleanup{server: b}
	l.mu.Lock()
	l.job = nil
	l.mu.Unlock()
	b.Terminals.mu.Lock()
	delete(b.Terminals.securityJobs, "original")
	b.Terminals.mu.Unlock()
	if _, err := adapter.Observe(t.Context(), cleanup); err == nil {
		t.Fatal("unbound historical entry accepted")
	}
	if _, err := adapter.Cancel(t.Context(), cleanup); err == nil || d.closed || d.data.Len() != 0 {
		t.Fatal("unbound cleanup wrote or closed terminal", err)
	}
}
