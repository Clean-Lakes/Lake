//go:build windows

package platform

import (
	"strconv"
	"syscall"
	"testing"
)

func TestSSHFileOptionSurvivesWindowsArgumentQuoting(t *testing.T) {
	// A quoted value without a space is emitted by os/exec as \"value\" outside any
	// quoted argument, and the bundled OpenSSH then aborts with
	// "command-line line 0: invalid quotes" before it writes any diagnostics.
	unspaced := "UserKnownHostsFile=" + strconv.Quote(`C:\Users\yeling\.lake\secrets\kh`)
	if escaped := syscall.EscapeArg(unspaced); escaped[0] == '"' {
		t.Fatalf("expected the unspaced form to escape without an enclosing quote: %q", escaped)
	}
	for _, value := range []string{
		`C:\Users\yeling\.lake\secrets\ssh-host-1.known_hosts`,
		`C:\Users\a b\.lake\secrets\kh`,
		`C:\Users\O'Brien\.lake\secrets\kh`,
	} {
		option := SSHFileOption("UserKnownHostsFile", value)
		escaped := syscall.EscapeArg(option)
		if len(escaped) < 2 || escaped[0] != '"' || escaped[len(escaped)-1] != '"' {
			t.Errorf("option for %q does not arrive as one quoted argument: %q", value, escaped)
		}
	}
}
