package web

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/hinshun/vt10x"
)

func TestShellConnectionFailureIsNotAnUnknownCommand(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	config, cleanup := prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "port": port, "username": "synthetic", "authMethod": "password", "password": "fixture-only"})
	defer cleanup()
	r := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "Unavailable fixture", "ssh", config)
	ref := stringOf(r["id"])
	b.Terminals.KnownHosts = filepath.Join(t.TempDir(), "known_hosts")
	if err = os.WriteFile(b.Terminals.KnownHosts, nil, 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 { // Initial connection and the retained connection-failure guard.
		_, err = b.bridge(context.Background(), id, "runtimeCommandExec", Object{"asset_ref": ref, "runtime": "ssh", "command": "printf MUST_NOT_RUN"}, true)
		var rejected *ai.ToolNotExecutedError
		if !errors.As(err, &rejected) || !strings.Contains(err.Error(), "SSH 端口拒绝连接") {
			t.Fatal("connection failure became an unknown command", err)
		}
	}
	terminals := objects(b.Store.Snapshot(id)["terminals"])
	if len(terminals) != 1 {
		t.Fatal("connection failure guard did not prevent repeated connection", len(terminals))
	}
	for _, terminal := range terminals {
		if len(objects(b.Store.History(id, stringOf(terminal["id"]))["entries"])) != 0 {
			t.Fatal("failed connection submitted a command")
		}
	}
}

func TestShellDispatchBoundaryDoesNotProveLaterErrorsUnexecuted(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	_, err := b.bridge(context.Background(), id, "terminal_execute_command", Object{"terminal_id": "missing", "command": "printf NEVER"}, true)
	var rejected *ai.ToolNotExecutedError
	if err == nil || errors.As(err, &rejected) {
		t.Fatal("execution-stage failure incorrectly claimed no dispatch", err)
	}
}

// A failed init write must not publish an empty generic error while the reader
// still owns the final SSH diagnostic. No command has been dispatched here.
func TestShellStartupInitFailureDrainsFinalDiagnostic(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	terminal := b.Store.CreateTerminal(id, ref)
	l := &liveTerminal{id: stringOf(terminal["id"]), session: id, remote: true,
		readyMarker: "\x1eLAKE_READY_delayed_fixture\x1f", connected: make(chan struct{}),
		cmd: &exec.Cmd{}, pty: startupDrainFixtureDevice{}, screen: vt10x.New(vt10x.WithSize(100, 30))}
	readDone, done, started := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		close(started)
		b.Terminals.closeAfterOutput(l, readDone, "Connection initialization failed")
		close(done)
	}()
	defer func() {
		select {
		case <-readDone:
		default:
			close(readDone)
		}
		<-done
	}()
	<-started
	select {
	case <-l.connected:
		t.Fatal("startup failure published before the stderr reader finished")
	case <-time.After(30 * time.Millisecond):
	}
	b.Terminals.receive(l, "ssh: connect to host 127.0.0.1 port 1: Connection refused\r\n")
	close(readDone)
	<-done
	l.mu.Lock()
	err := l.connectErr
	l.mu.Unlock()
	if err == nil || !strings.Contains(err.Error(), "SSH 端口拒绝连接") {
		t.Fatal("final SSH diagnostic was lost")
	}
	if len(objects(b.Store.History(id, l.id)["entries"])) != 0 {
		t.Fatal("failed startup dispatched a command")
	}
}

type startupDrainFixtureDevice struct{}

func (startupDrainFixtureDevice) Read([]byte) (int, error)          { return 0, io.EOF }
func (startupDrainFixtureDevice) Write(b []byte) (int, error)       { return len(b), nil }
func (startupDrainFixtureDevice) WriteString(s string) (int, error) { return len(s), nil }
func (startupDrainFixtureDevice) Close() error                      { return nil }
