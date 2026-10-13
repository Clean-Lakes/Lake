//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"golang.org/x/sys/windows"
)

func TestWindowsUpdateJobValidation(t *testing.T) {
	for _, mode := range []string{"valid", "same version", "traversal", "wrong parent", "corrupt file", "trailing JSON", "other home"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			work := filepath.Join(home, "updates", "windows", "job-test")
			if err := platform.MkdirAll(work, 0700); err != nil {
				t.Fatal(err)
			}
			payload := []byte("MZ verified fixture")
			sum := sha256.Sum256(payload)
			created, err := processStarted(windows.CurrentProcess())
			if err != nil {
				t.Fatal(err)
			}
			job := updateJob{ParentPID: uint32(os.Getpid()), ParentStarted: created, Version: "1.0.0", InstallerName: "Lake-1.0.0-windows-x86_64-setup.exe", Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}
			installer := filepath.Join(work, job.InstallerName)
			if mode == "corrupt file" {
				payload = append(payload, 'x')
			}
			if err := writePrivate(installer, payload); err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "same version":
				job.Version = version
			case "traversal":
				job.InstallerName = "../Lake.exe"
			case "wrong parent":
				job.ParentStarted = 0
			}
			data, _ := json.Marshal(job)
			if mode == "trailing JSON" {
				data = append(data, []byte(" {}")...)
			}
			path := filepath.Join(work, "update.json")
			if err := writePrivate(path, data); err != nil {
				t.Fatal(err)
			}
			validateHome := home
			if mode == "other home" {
				validateHome = t.TempDir()
			}
			_, _, err = readUpdateJob(path, validateHome)
			if mode == "valid" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("unsafe update job accepted")
			}
		})
	}
}
