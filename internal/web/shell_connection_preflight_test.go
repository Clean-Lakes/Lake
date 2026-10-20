package web

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
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
