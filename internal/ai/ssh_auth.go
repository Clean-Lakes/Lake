package ai

import (
	"errors"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func sshSecret(ref, root string) (string, error) {
	path, err := privateCredential(ref, root)
	if err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("SSH credential unavailable")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) == 0 || len(data) > 4096 || strings.ContainsAny(string(data), "\r\n\x00") {
		return "", errors.New("invalid SSH credential file")
	}
	return string(data), nil
}

// SSHAskpass's output is consumed only by OpenSSH, through its helper pipe.
func SSHAskpass(prompt string, out io.Writer) error {
	mode := os.Getenv("LAKE_SSH_ASKPASS_MODE")
	lower := strings.ToLower(prompt)
	if os.Getenv("SSH_ASKPASS_PROMPT") == "confirm" || (mode == "password" && !sshPasswordPrompt(prompt)) || (mode == "key" && !strings.Contains(lower, "passphrase")) || (mode != "key" && mode != "password") {
		return errors.New("unsupported authentication prompt")
	}
	secret, err := sshSecret(os.Getenv("LAKE_SSH_SECRET_REF"), os.Getenv("LAKE_SSH_SECRET_ROOT"))
	if err != nil {
		return err
	}
	_, err = io.WriteString(out, secret+"\n")
	return err
}

// Keyboard-interactive can also request OTPs, password changes or confirmation.
// Only recognize ordinary password prompts; never reuse a saved password for
// another challenge, including an otherwise matching "one-time password".
func sshPasswordPrompt(prompt string) bool {
	value := strings.ToLower(strings.TrimSpace(prompt))
	if strings.HasPrefix(value, "(") {
		if end := strings.IndexByte(value, ')'); end > 0 {
			peer := value[1:end]
			if !strings.Contains(peer, "@") || strings.ContainsAny(peer, " \t\r\n()") {
				return false
			}
			value = strings.TrimSpace(value[end+1:])
		}
	}
	if value == "password:" || value == "密码:" || value == "密码：" {
		return true
	}
	if peer, ok := strings.CutSuffix(value, "'s password:"); ok {
		return strings.Contains(peer, "@") && !strings.ContainsAny(peer, " \t\r\n()")
	}
	return false
}

func sshEnvironment(c *SSH, root string) ([]string, error) {
	home, _ := os.UserHomeDir()
	env := platform.Environment(home)
	if c == nil || c.CredentialRef == "" {
		return env, nil
	}
	path, err := privateCredential(c.CredentialRef, root)
	if err != nil {
		return nil, err
	}
	helper, err := os.Executable()
	if err == nil {
		helper, err = platform.SSHAskpassProgram(helper)
	}
	if err != nil {
		return nil, errors.New("SSH credential helper unavailable")
	}
	mode := c.AuthMethod
	if mode == "" {
		mode = "key"
	}
	return append(env, "SSH_ASKPASS="+helper, "SSH_ASKPASS_REQUIRE=force", "DISPLAY=lake:0", "LAKE_SSH_ASKPASS=1", "LAKE_SSH_ASKPASS_MODE="+mode, "LAKE_SSH_SECRET_ROOT="+filepath.Dir(path), "LAKE_SSH_SECRET_REF="+filepath.Base(path)), nil
}
