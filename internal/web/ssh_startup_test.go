package web

import (
	"os"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

func TestWindowsSSHStartupLogKeepsOnlySafeCauseAndDeletesPrivateFile(t *testing.T) {
	for _, tc := range []struct{ output, want string }{
		{"Permission denied (password).", "身份认证失败"},
		{"Authenticated to fixture using password.\nConnection closed by fixture", "身份认证已通过"},
		{"Authenticated to fixture using password.\nexec request failed on channel 0", "拒绝创建终端"},
	} {
		log, err := newSSHStartupLog(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(log.path)
		if err != nil || !platform.Private(log.path, info) {
			t.Fatal("startup log is not private")
		}
		if err := os.WriteFile(log.path, []byte(strings.Repeat("bounded fixture banner\n", 3000)+tc.output+"\nfixture-output-not-for-display"), 0600); err != nil {
			t.Fatal(err)
		}
		message := log.finish()
		if !strings.Contains(message, tc.want) || strings.Contains(message, "fixture") {
			t.Fatal("startup evidence lost its category or exposed raw data")
		}
		if retainedSSHStartupCause("\r\n"+sshStartupHistoryPrefix+message+"\r\n") != message {
			t.Fatal("safe startup cause cannot survive a backend restart")
		}
		if _, err := os.Stat(log.path); !os.IsNotExist(err) {
			t.Fatal("completed startup log was not deleted")
		}
	}
	if got := retainedSSHStartupCause(sshStartupHistoryPrefix + "arbitrary-private-value"); strings.Contains(got, "arbitrary-private") {
		t.Fatal("forged history marker exposed an unclassified value")
	}
}
