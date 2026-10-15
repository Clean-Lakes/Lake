package platform

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// The Windows desktop embeds its server in a GUI-subsystem executable. Use the
// packaged console CLI for OpenSSH's private stdout protocol instead of relying
// on a GUI process inheriting console/pipe handles through MSYS.
func SSHAskpassProgram(executable string) (string, error) {
	if runtime.GOOS != "windows" {
		return executable, nil
	}
	return packagedSSHAskpassProgram(executable)
}

func packagedSSHAskpassProgram(executable string) (string, error) {
	resources := filepath.Join(filepath.Dir(executable), "resources")
	helper := filepath.Join(resources, "lake.exe")
	if info, err := os.Lstat(helper); err == nil {
		if !info.Mode().IsRegular() {
			return "", errors.New("SSH credential helper unavailable")
		}
		return helper, nil
	}
	if info, err := os.Stat(filepath.Join(resources, "git")); err == nil && info.IsDir() {
		return "", errors.New("SSH credential helper unavailable")
	}
	// A standalone CLI or test executable already implements the pipe protocol.
	return executable, nil
}
