//go:build windows

package main

import (
	"path/filepath"
	"testing"
)

func TestDevelopmentProfileKeepsItsOwnPersistentHome(t *testing.T) {
	before := development
	development = "1"
	t.Cleanup(func() { development = before })
	user := t.TempDir()
	t.Setenv("LAKE_HOME", filepath.Join(user, ".lake"))
	t.Setenv("LAKE_DEV_HOME", "")
	home, err := profileHome(user)
	if err != nil || home != filepath.Join(user, ".lake-dev") {
		t.Fatalf("Dev home = %q, %v", home, err)
	}
	if windowTitle() != "Lake Dev "+version {
		t.Fatal("Dev title has no build label")
	}
	custom := filepath.Join(user, "custom-dev")
	t.Setenv("LAKE_DEV_HOME", custom)
	if home, err := profileHome(user); err != nil || home != custom {
		t.Fatalf("custom home = %q, %v", home, err)
	}
}

func TestDevelopmentProfileRejectsReleaseData(t *testing.T) {
	before := development
	development = "1"
	t.Cleanup(func() { development = before })
	user := t.TempDir()
	for _, home := range []string{filepath.Join(user, ".lake"), filepath.Join(user, ".lake", "web-agent")} {
		t.Setenv("LAKE_DEV_HOME", home)
		if _, err := profileHome(user); err == nil {
			t.Fatalf("accepted release directory %q", home)
		}
	}
}

func TestReleaseProfileKeepsExistingHomeOverride(t *testing.T) {
	before := development
	development = ""
	t.Cleanup(func() { development = before })
	user := t.TempDir()
	custom := filepath.Join(user, "release-test")
	t.Setenv("LAKE_HOME", custom)
	t.Setenv("LAKE_DEV_HOME", filepath.Join(user, "ignored-dev"))
	if home, err := profileHome(user); err != nil || home != custom {
		t.Fatalf("release home = %q, %v", home, err)
	}
}
