package web

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

// OpenSSH's own error output can be lost when ConPTY exits before its renderer
// drains. Keep a private, temporary log independent of that renderer. Only a
// fixed classification survives; the log is deleted when the process exits.
type sshStartupLog struct{ path string }

const sshAuthenticatedStartupFailure = "SSH 身份认证已通过，但远端终端初始化没有完成。请检查远端 Shell 与初始化配置。"
const sshStartupHistoryPrefix = "[Lake SSH startup] "

// Persist only one of the classifier's fixed messages, not OpenSSH's log. This
// also preserves the existing retry pause after a backend restart.
var retainedSSHCauses = func() map[string]bool {
	causes := map[string]bool{sshAuthenticatedStartupFailure: true}
	for _, probe := range []string{"no matching cipher found", "bad owner or permissions", SSHAskpassFailureMessage, "ssh_askpass: exec", "bad configuration option", "remote host identification has changed", "host key verification failed", "permission denied", "connection refused", "could not resolve hostname", "no route to host", "connection timed out", "exec request failed", "connection reset by"} {
		causes[terminalConnectionError(probe, "")] = true
	}
	return causes
}()

func retainedSSHStartupCause(output string) string {
	if at := strings.LastIndex(output, sshStartupHistoryPrefix); at >= 0 {
		candidate, _, _ := strings.Cut(output[at+len(sshStartupHistoryPrefix):], "\n")
		candidate = strings.TrimSuffix(candidate, "\r")
		if retainedSSHCauses[candidate] {
			return candidate
		}
	}
	return terminalConnectionError(output, "")
}

func newSSHStartupLog(home string) (*sshStartupLog, error) {
	root := filepath.Join(home, "secrets")
	if err := platform.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(root, "ssh-startup-")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		os.Remove(path)
		return nil, err
	}
	if err := platform.Chmod(path, 0600); err != nil {
		os.Remove(path)
		return nil, err
	}
	return &sshStartupLog{path: path}, nil
}

func (log *sshStartupLog) discard() {
	if log != nil {
		os.Remove(log.path)
	}
}

func (log *sshStartupLog) finish() string {
	if log == nil {
		return ""
	}
	defer log.discard()
	file, err := os.Open(log.path)
	if err != nil {
		return ""
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ""
	}
	start := info.Size() - outputLimit
	if start < 0 {
		start = 0
	}
	data, err := io.ReadAll(io.NewSectionReader(file, start, outputLimit))
	if err != nil {
		return ""
	}
	message := terminalConnectionError(string(data), "")
	if message == terminalConnectionError("", "") {
		message = ""
	}
	text := compactSSHDiagnostic(string(data))
	if strings.Contains(text, "authenticatedto") && (message == "" || strings.Contains(message, "关闭了连接")) {
		return sshAuthenticatedStartupFailure
	}
	return message
}
