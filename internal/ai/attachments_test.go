package ai

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestStageAttachmentCopiesBinaryAndRequiresExplicitOverwrite(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	dest := filepath.Join(dir, "target with spaces.bin")
	raw := []byte{0, 255, 3, 128}
	os.WriteFile(source, raw, 0600)
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(context.Context, string, string, map[string]any, bool) (any, error) {
		return map[string]any{"path": source, "sha256": fmt.Sprintf("%x", sha256.Sum256(raw)), "sizeBytes": len(raw)}, nil
	})
	c := Config{Assets: []Asset{{ID: "local", Kind: "local"}}}
	args := map[string]any{"source_id": "fixture", "asset_ref": "local", "runtime": "local", "path": dest}
	if _, err := e.stageAttachment(context.Background(), "case", c, args); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); string(got) != string(raw) {
		t.Fatal("binary changed")
	}
	if _, err := e.stageAttachment(context.Background(), "case", c, args); err == nil {
		t.Fatal("implicit overwrite allowed")
	}
	args["overwrite"] = true
	if _, err := e.stageAttachment(context.Background(), "case", c, args); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	args["path"] = filepath.Join(dir, "cancelled")
	if _, err := e.stageAttachment(ctx, "case", c, args); err == nil {
		t.Fatal("cancelled transfer succeeded")
	}
	if _, err := os.Stat(args["path"].(string)); !os.IsNotExist(err) {
		t.Fatal("cancelled transfer published a file")
	}
}
func TestStageAttachmentUsesFilePermissionEvenWhenCommandsAreSilent(t *testing.T) {
	p := DefaultPermissions()
	p.SilentCommands = true
	p.SilentWriteFiles = false
	c := Config{Permissions: &p}
	kind, err := approvalKind(c, "stage_attachment", "write", map[string]any{"runtime": "ssh"})
	if err != nil || kind != "file_write" {
		t.Fatal("file transfer bypassed file-write gate", kind, err)
	}
	p.DenyLocalExecution = true
	if _, err := approvalKind(c, "stage_attachment", "write", map[string]any{"runtime": "local"}); err == nil {
		t.Fatal("local transfer bypassed local execution restriction")
	}
}

func TestAttachmentTransferPermissionFollowsWriteFiles(t *testing.T) {
	for _, runtime := range []string{"local", "ssh", "container"} {
		for _, write := range []bool{false, true} {
			for _, commands := range []bool{false, true} {
				p := DefaultPermissions()
				p.SilentWriteFiles = write
				p.SilentCommands = commands
				c := Config{Permissions: &p}
				kind, err := approvalKind(c, "stage_attachment", "write", map[string]any{"runtime": runtime})
				if err != nil || (kind == "") != write || !write && kind != "file_write" {
					t.Fatalf("runtime=%s write=%v commands=%v: kind=%q err=%v", runtime, write, commands, kind, err)
				}
			}
		}
	}
}
