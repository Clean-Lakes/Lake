package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func TestSaveDownloadPersistsUTF8AndBinaryFromNativeSelection(t *testing.T) {
	for _, test := range []struct {
		name, mime string
		content    []byte
	}{
		{"trace.json", "application/json", []byte("{\"task\":\"SSH 专员工具摘要\",\"stage\":\"completed\"}\n")},
		{"preview.png", "image/png", []byte{0x89, 'P', 'N', 'G', 0, 0xff}},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			selected := filepath.Join(dir, test.name)
			if err := os.WriteFile(selected, []byte("old download"), 0600); err != nil {
				t.Fatal(err)
			}
			a := &App{saveDownloadDialog: func(options wailsruntime.SaveDialogOptions) (string, error) {
				if options.DefaultFilename != test.name || len(options.Filters) != 1 {
					t.Fatal(options)
				}
				return selected, nil
			}}
			path, err := a.SaveDownload(test.name, test.mime, base64.StdEncoding.EncodeToString(test.content))
			if err != nil || path != selected {
				t.Fatalf("path=%q err=%v", path, err)
			}
			content, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(content, test.content) {
				t.Fatalf("content mismatch: %v", err)
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("download permissions: %v", err)
			}
			files, err := os.ReadDir(dir)
			if err != nil || len(files) != 1 {
				t.Fatalf("temporary file remained: %v", err)
			}
		})
	}
}

func TestSaveDownloadCancelAndFailureAreNotSuccess(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte(`{"stage":"completed"}`))
	dir := t.TempDir()
	a := &App{saveDownloadDialog: func(wailsruntime.SaveDialogOptions) (string, error) { return "", nil }}
	if path, err := a.SaveDownload("trace.json", "application/json", encoded); err != nil || path != "" {
		t.Fatalf("cancel returned path=%q err=%v", path, err)
	}
	a.saveDownloadDialog = func(wailsruntime.SaveDialogOptions) (string, error) { return "", errors.New("save panel unavailable") }
	if path, err := a.SaveDownload("trace.json", "application/json", encoded); err == nil || path != "" {
		t.Fatal("dialog failure reported success")
	}
	// A directory cannot be replaced by a downloaded file, and the temporary
	// download must be cleaned up when the final rename fails.
	selected := filepath.Join(dir, "existing.json")
	if err := os.Mkdir(selected, 0700); err != nil {
		t.Fatal(err)
	}
	a.saveDownloadDialog = func(wailsruntime.SaveDialogOptions) (string, error) { return selected, nil }
	if path, err := a.SaveDownload("trace.json", "application/json", encoded); err == nil || path != "" {
		t.Fatal("write failure reported success")
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 || !files[0].IsDir() {
		t.Fatalf("write failure changed destination or leaked a file: %v", err)
	}
}

func TestSaveDownloadRejectsInvalidPayloadBeforeDialog(t *testing.T) {
	a := &App{saveDownloadDialog: func(wailsruntime.SaveDialogOptions) (string, error) {
		t.Fatal("invalid payload opened save panel")
		return "", nil
	}}
	valid := base64.StdEncoding.EncodeToString([]byte(`{}`))
	for _, test := range []struct{ filename, mime, encoded string }{
		{"../trace.json", "application/json", valid},
		{"trace.exe", "application/json", valid},
		{"trace.json", "text/html", valid},
		{"trace.json", "application/json", "invalid-base64"},
		{"trace.json", "application/json", base64.StdEncoding.EncodeToString([]byte(`{broken`))},
		{"trace.json", "application/json", strings.Repeat("A", base64.StdEncoding.EncodedLen(maxDownloadBytes)+4)},
	} {
		if path, err := a.SaveDownload(test.filename, test.mime, test.encoded); err == nil || path != "" {
			t.Fatalf("invalid download accepted: %s %s", test.filename, test.mime)
		}
	}
}
