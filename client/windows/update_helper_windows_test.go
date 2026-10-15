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
	for _, mode := range []string{"valid", "same version", "traversal", "wrong parent", "corrupt file", "trailing JSON", "other home", "public root"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			root := filepath.Join(home, "updates", "windows")
			if err := platform.MkdirAll(root, 0700); err != nil {
				t.Fatal(err)
			}
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
			if mode == "public root" {
				sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
				if err != nil {
					t.Fatal(err)
				}
				acl, _, err := sd.DACL()
				if err != nil {
					t.Fatal(err)
				}
				if err = windows.SetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
					t.Fatal(err)
				}
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
