package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScriptJobIdentityPersistsAndRejectsOverwriteOrUntrustedFiles(t *testing.T) {
	root := t.TempDir()
	s, err := Open(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	job := ScriptJob{ID: strings.Repeat("a", 32), LakeID: "lake", ResourceID: "host", ScriptID: "script", ScriptSHA256: strings.Repeat("b", 64), TargetSHA256: strings.Repeat("c", 64), Language: "sh", TimeoutSeconds: 600, CreatedAt: time.Now()}
	if err = s.SaveScriptJob(job); err != nil {
		t.Fatal(err)
	}
	if err = s.SaveScriptJob(job); !errors.Is(err, os.ErrExist) {
		t.Fatal("identity overwritten")
	}
	s.Close()
	s, err = Open(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, err := s.GetScriptJob(job.ID)
	if err != nil || got.ResourceID != "host" || got.ScriptSHA256 != job.ScriptSHA256 {
		t.Fatalf("lost identity: %+v %v", got, err)
	}
	jobs, err := s.ListScriptJobs("lake")
	if err != nil || len(jobs) != 1 {
		t.Fatal(jobs, err)
	}
	if _, err = s.GetScriptJob("../outside"); err == nil {
		t.Fatal("path traversal")
	}
	p := filepath.Join(root, "script-jobs", job.ID+".json")
	if err = os.Chmod(p, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GetScriptJob(job.ID); err == nil {
		t.Fatal("public metadata accepted")
	}
	if err = os.Remove(p); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Join(root, "lake.db"), p); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GetScriptJob(job.ID); err == nil {
		t.Fatal("symlink metadata accepted")
	}
}
