package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

func TestSSHAuthenticationMethodBoundary(t *testing.T) {
	root := filepath.Join(t.TempDir(), "credentials")
	if err := platform.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "synthetic")
	if err := os.WriteFile(path, []byte("synthetic-auth-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := platform.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"key", "password"} {
		t.Run(mode, func(t *testing.T) {
			args, err := sshBase(&SSH{Host: "127.0.0.1", Port: 22, Username: "fixture", AuthMethod: mode, IdentityFile: path, CredentialRef: "synthetic"}, root)
			if err != nil {
				t.Fatal(err)
			}
			options := map[string]string{}
			for i := 0; i+1 < len(args); i++ {
				if args[i] != "-o" {
					continue
				}
				key, value, _ := strings.Cut(args[i+1], "=")
				if _, exists := options[key]; exists {
					t.Fatal("duplicate SSH options can shadow authentication policy")
				}
				options[key] = value
			}
			if options["StrictHostKeyChecking"] != "yes" || options["NumberOfPasswordPrompts"] != "1" {
				t.Fatal("authentication compatibility changed trust or retry limits")
			}
			if mode == "password" {
				if options["PreferredAuthentications"] != "password,keyboard-interactive" || options["KbdInteractiveAuthentication"] != "yes" || options["PubkeyAuthentication"] != "no" {
					t.Fatal("password mode cannot authenticate a PAM-only server")
				}
			} else if options["PreferredAuthentications"] != "publickey" || options["KbdInteractiveAuthentication"] != "no" || options["PasswordAuthentication"] != "no" {
				t.Fatal("key authentication silently fell back to password")
			}
		})
	}
}
