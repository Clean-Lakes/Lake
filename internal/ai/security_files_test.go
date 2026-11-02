//go:build unix

package ai

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func boundedFileFixture(t *testing.T, name, contents string) (*Engine, Config, map[string]any, security.PreparedOperation) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "fixture.log")
	if err = os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	e := &Engine{}
	c := Config{Runtime: "local"}
	args := map[string]any{"path": path}
	op := security.PreparedOperation{Tool: name, Proof: security.ProofOpaque, Resources: []security.ResourceRevision{{ID: "local", Local: true}}}
	if supported, err := e.prepareSecurityLocalFile(c, &op, args); err != nil || !supported || op.Proof != security.ProofStructured {
		t.Fatal("bounded preparation failed", supported, err)
	}
	return e, c, args, op
}

func TestSecurityBoundedFileReadsOriginalFDAndRejectsReplacement(t *testing.T) {
	_, c, args, op := boundedFileFixture(t, "read", "original authorized text\n")
	file, err := openSecurityLocalFile(op.Scope, "read")
	if err != nil {
		t.Fatal(err)
	}
	result, err := readSecurityLocalFile(context.Background(), file, op.Scope, "read", args, c)
	file.Close()
	if err != nil || !strings.Contains(js(result), "original authorized text") {
		t.Fatal(result, err)
	}
	path := str(args["path"])
	if err = os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("REPLACED OUTSIDE DATA\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if file, err = openSecurityLocalFile(op.Scope, "read"); err == nil {
		file.Close()
		t.Fatal("replaced path reused prior file authority")
	}
}

func TestSecurityBoundedFileRejectsSymlinkParentsAndHardLinks(t *testing.T) {
	e, c, args, _ := boundedFileFixture(t, "read", "inside\n")
	outside := filepath.Join(t.TempDir(), "secret.log")
	if err := os.WriteFile(outside, []byte("OUTSIDE_DATA"), 0600); err != nil {
		t.Fatal(err)
	}
	path := str(args["path"])
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	op := security.PreparedOperation{Tool: "read", Resources: []security.ResourceRevision{{ID: "local", Local: true}}}
	if supported, err := e.prepareSecurityLocalFile(c, &op, args); err == nil && supported {
		t.Fatal("final symlink gained structured file proof")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, path); err != nil {
		t.Fatal(err)
	}
	if supported, err := e.prepareSecurityLocalFile(c, &op, args); err == nil && supported {
		t.Fatal("hardlink concealed an outside file")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(filepath.Dir(path), "linked-dir")
	if err := os.Symlink(filepath.Dir(outside), linked); err != nil {
		t.Fatal(err)
	}
	args["path"] = filepath.Join(linked, "secret.log")
	if supported, err := e.prepareSecurityLocalFile(c, &op, args); err == nil && supported {
		t.Fatal("symlink parent escaped scope path")
	}
}

func TestSecurityBoundedFileOpenFDNeverReturnsSwappedOutsideTarget(t *testing.T) {
	_, c, args, op := boundedFileFixture(t, "read", "old authorized contents\n")
	file, err := openSecurityLocalFile(op.Scope, "read")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	outside := filepath.Join(t.TempDir(), "secret.log")
	if err = os.WriteFile(outside, []byte("OUTSIDE_SECRET"), 0600); err != nil {
		t.Fatal(err)
	}
	path := str(args["path"])
	if err = os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	result, err := readSecurityLocalFile(context.Background(), file, op.Scope, "read", args, c)
	if strings.Contains(js(result), "OUTSIDE_SECRET") {
		t.Fatal("open file was redirected by a path swap")
	}
	if err == nil && !strings.Contains(js(result), "old authorized contents") {
		t.Fatal("read unexpected replacement contents", result)
	}
}

func TestSecurityBoundedLogTailAndListingLimits(t *testing.T) {
	text := strings.Repeat("line with actual source data\n", 4000)
	_, c, args, op := boundedFileFixture(t, "observe_logs", text)
	file, err := openSecurityLocalFile(op.Scope, "observe_logs")
	if err != nil {
		t.Fatal(err)
	}
	result, err := readSecurityLocalFile(context.Background(), file, op.Scope, "observe_logs", args, c)
	file.Close()
	if err != nil || len(str(obj(result)["output"])) > securityLogTailLimit || strings.Count(str(obj(result)["output"]), "\n") > 200 || obj(result)["truncated"] != true {
		t.Fatal(result, err)
	}
	parent := filepath.Dir(str(args["path"]))
	for i := 0; i < 1005; i++ {
		if err = os.WriteFile(filepath.Join(parent, fmt.Sprintf("name-%04d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	args["path"] = parent
	op.Tool = "ls"
	if ok, err := (&Engine{}).prepareSecurityLocalFile(c, &op, args); err != nil || !ok {
		t.Fatal(ok, err)
	}
	file, err = openSecurityLocalFile(op.Scope, "ls")
	if err != nil {
		t.Fatal(err)
	}
	result, err = readSecurityLocalFile(context.Background(), file, op.Scope, "ls", args, c)
	file.Close()
	if err != nil || num(obj(result)["count"], 0) != 1000 || obj(result)["truncated"] != true {
		t.Fatal(result, err)
	}
}

func TestSecurityBoundedFileRejectsRootSwapAndSameLengthMutation(t *testing.T) {
	_, _, args, op := boundedFileFixture(t, "read", "same sized original\n")
	path := str(args["path"])
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("same sized MUTATED!\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if file, err := openSecurityLocalFile(op.Scope, "read"); err == nil {
		file.Close()
		t.Fatal("ctime mutation hidden by restored mtime")
	}
	_, _, args, op = boundedFileFixture(t, "read", "original\n")
	parent := filepath.Dir(str(args["path"]))
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(outside, "fixture.log"), []byte("OUTSIDE"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(parent, parent+"-old"); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(parent + "-old")
	if err = os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	if file, err := openSecurityLocalFile(op.Scope, "read"); err == nil {
		file.Close()
		t.Fatal("replaced directory reused original root authority")
	}
}

func TestSecurityBoundedFileOutsideGrantRootsDoesNotDispatch(t *testing.T) {
	db, now, op, owner, grant := permitFixture(t)
	_, c, args, fileProof := boundedFileFixture(t, "read", "outside grant limits\n")
	op.Scope = fileProof.Scope
	op.ArgumentsDigest = security.ContentDigest([]byte(js(args)))
	op.PreviewDigest = op.ArgumentsDigest
	op.Proof = security.ProofStructured
	// The actual caller still has the original /var/log-only grant and policy.
	if err := db.Transaction(func(tx *gorm.DB) error { _, err := AcquireSecurityPermitTx(tx, op, owner, now); return err }); err == nil {
		t.Fatal("structured file proof bypassed authorized FileRoots")
	}
	if remaining := grantRemaining(t, db, grant.ID); remaining != grant.RemainingUses {
		t.Fatal("denied outside read spent authorization", remaining)
	}
	if _, err := (&Engine{}).executeSecurityLocalFile(context.Background(), c, "read", args); err == nil {
		t.Fatal("direct bounded adapter executed without a registered permit")
	}
}

func TestSecurityBoundedLogAllowsGrowthButRejectsRotationAndShrink(t *testing.T) {
	_, c, args, op := boundedFileFixture(t, "observe_logs", "initial line\n")
	path := str(args["path"])
	writer, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.WriteString("appended before open\n"); err != nil {
		t.Fatal(err)
	}
	file, err := openSecurityLocalFile(op.Scope, "observe_logs")
	if err != nil {
		t.Fatal("ordinary active log append invalidated path authorization", err)
	}
	if _, err = writer.WriteString("appended before snapshot\n"); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	result, err := readSecurityLocalFile(context.Background(), file, op.Scope, "observe_logs", args, c)
	file.Close()
	if err != nil || !strings.Contains(str(obj(result)["output"]), "appended before snapshot") || str(obj(result)["sample_hash"]) != hash(str(obj(result)["output"])) || str(obj(result)["observed_at"]) == "" {
		t.Fatal("log snapshot lost actual content witness", result, err)
	}
	if err = os.Truncate(path, 0); err != nil {
		t.Fatal(err)
	}
	if file, err = openSecurityLocalFile(op.Scope, "observe_logs"); err == nil {
		file.Close()
		t.Fatal("truncated log reused original prepared sample")
	}
	_, _, args, op = boundedFileFixture(t, "observe_logs", "original\n")
	path = str(args["path"])
	if err = os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("rotated replacement\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if file, err = openSecurityLocalFile(op.Scope, "observe_logs"); err == nil {
		file.Close()
		t.Fatal("rotated log reused original inode authorization")
	}
}
