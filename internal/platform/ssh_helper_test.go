package platform

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPackagedSSHAskpassUsesConsoleHelper(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Lake 安装 with spaces")
	resources := filepath.Join(root, "resources")
	if err := os.MkdirAll(filepath.Join(resources, "git"), 0700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "Lake.exe")
	if _, err := packagedSSHAskpassProgram(executable); err == nil {
		t.Fatal("missing packaged helper silently fell back to the GUI")
	}
	helper := filepath.Join(resources, "lake.exe")
	if err := os.WriteFile(helper, []byte("synthetic console fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := packagedSSHAskpassProgram(executable)
	if err != nil || got != helper {
		t.Fatal("GUI selected for a private credential pipe", err)
	}
	got, err = packagedSSHAskpassProgram(helper)
	if err != nil || got != helper {
		t.Fatal("standalone console helper stopped resolving to itself", err)
	}
}
