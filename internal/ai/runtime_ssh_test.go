package ai

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeSSHDiagnosticDoesNotInventCredentialFailure(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"Host key verification failed.", "host key is not trusted"},
		{"REMOTE HOST IDENTIFICATION HAS CHANGED!", "host key changed"},
		{"fixture@host: Permission denied (publickey,password).", "authentication failed"},
		{"connect to host fixture port 22: Connection refused", "connection refused"},
		{"Connection timed out", "connection timed out"},
		{"Connection reset by peer", "server closed"},
		{"remote command exited 255", "cause is unknown"},
		{"cat: /fixture: Permission denied", "cause is unknown"},
	} {
		message := runtimeSSHFailure(tc.input + "\nSynthetic-private-diagnostic").Error()
		if !strings.Contains(message, tc.want) || strings.Contains(message, "Synthetic-private-diagnostic") {
			t.Fatalf("wrong or unsafe diagnostic for %q", tc.want)
		}
	}
}

func TestRuntimeSSHTrustBridgePreservesScopeAndDoesNotMutateSharedConfig(t *testing.T) {
	asset := Asset{ID: "fixture-host", Kind: "ssh", SSH: &SSH{Host: "127.0.0.1", Port: 22, Username: "fixture", KnownHosts: "previous-pin"}}
	verified := filepath.Join(t.TempDir(), "known_hosts")
	var denied bool
	e, err := New(t.TempDir(), func(_ context.Context, id, name string, args map[string]any, approved bool) (any, error) {
		if id != "fixture-session" || name != "verify_runtime_ssh" || str(args["asset_ref"]) != asset.ID || approved {
			t.Fatal("trust bridge lost the session/target or claimed operation approval")
		}
		if denied {
			return nil, errors.New("user rejected host fingerprint")
		}
		return map[string]any{"knownHosts": verified}, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	s, err := e.get("fixture-session")
	if err != nil {
		t.Fatal(err)
	}
	s.state.Config = Config{Assets: []Asset{asset}}
	ctx := context.WithValue(context.Background(), runtimeSSHSessionKey{}, "fixture-session")
	copy, err := e.prepareRuntimeSSH(ctx, asset.SSH, asset.ID)
	if err != nil || copy == asset.SSH || copy.KnownHosts != verified || asset.SSH.KnownHosts != "previous-pin" {
		t.Fatal("host verification changed the shared configuration", err)
	}
	denied = true
	if _, err = e.prepareRuntimeSSH(ctx, asset.SSH, asset.ID); err == nil {
		t.Fatal("rejected fingerprint allowed execution")
	}
}
