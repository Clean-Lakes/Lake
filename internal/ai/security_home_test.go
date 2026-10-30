package ai

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
)

func securityFixture(t *testing.T) *SecurityHome {
	t.Helper()
	h, err := OpenSecurityHome(context.Background(), t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	return h
}
func TestSecurityHomeIdentityIsolationAndRootLock(t *testing.T) {
	h := securityFixture(t)
	if h.RuntimeRoot != filepath.Join(h.Home, "web-agent", "adk") {
		t.Fatal(h.RuntimeRoot)
	}
	if _, err := OpenSecurityHome(context.Background(), h.Home, ""); err == nil {
		t.Fatal("second owner allowed")
	}
	if _, err := OpenSecurityHome(context.Background(), t.TempDir(), filepath.Dir(h.RuntimeRoot)); err == nil {
		t.Fatal("shared data root allowed")
	}
	other := securityFixture(t)
	if other.control.StoreID == h.control.StoreID || other.control.RecoveryEpoch == h.control.RecoveryEpoch {
		t.Fatal("cross-Home identity reused")
	}
	epoch := h.control.RecoveryEpoch
	home := h.Home
	h.Close()
	again, err := OpenSecurityHome(context.Background(), home, "")
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if again.control.RecoveryEpoch != epoch {
		t.Fatal("ordinary restart rotated epoch")
	}
}
func TestSecurityOwnerProcess(t *testing.T) {
	if home := os.Getenv("LAKE_TEST_OWNER_HOME"); home != "" {
		lock, err := AcquireSecurityOwner(home)
		if err != nil {
			os.Exit(17)
		}
		lock.Close()
		os.Exit(0)
	}
	h := securityFixture(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestSecurityOwnerProcess$")
	cmd.Env = append(os.Environ(), "LAKE_TEST_OWNER_HOME="+h.Home)
	err := cmd.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 17 {
		t.Fatalf("second process not rejected: %v", err)
	}
	h.Close()
	cmd = exec.Command(os.Args[0], "-test.run=^TestSecurityOwnerProcess$")
	cmd.Env = append(os.Environ(), "LAKE_TEST_OWNER_HOME="+h.Home)
	if err = cmd.Run(); err != nil {
		t.Fatal("closed owner lock not released", err)
	}
}
func TestSecurityControlDamageFailsClosed(t *testing.T) {
	for _, kind := range []string{"missing", "corrupt", "future", "root", "pending", "storeID", "epoch", "database"} {
		t.Run(kind, func(t *testing.T) {
			h := securityFixture(t)
			h.Close()
			path := filepath.Join(h.Home, "security", "control.json")
			switch kind {
			case "database":
				if err := os.Remove(filepath.Join(h.RuntimeRoot, "sessions.sqlite")); err != nil {
					t.Fatal(err)
				}
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "corrupt":
				os.WriteFile(path, []byte("{"), 0600)
			case "future":
				c := h.control
				c.FormatVersion++
				writeSecurityJSON(path, c)
			case "root":
				c := h.control
				c.RuntimeRoot = filepath.Join(t.TempDir(), "adk")
				writeSecurityJSON(path, c)
			case "pending":
				writeSecurityJSON(filepath.Join(h.Home, "security", "bootstrap.pending"), map[string]bool{"pending": true})
			case "storeID":
				c := h.control
				c.StoreID = string(make([]byte, 64))
				writeSecurityJSON(path, c)
			case "epoch":
				c := h.control
				c.RecoveryEpoch = string(make([]byte, 64))
				writeSecurityJSON(path, c)
			}
			if _, err := OpenSecurityHome(context.Background(), h.Home, ""); err == nil {
				t.Fatal("damaged control accepted")
			}
			if kind == "missing" {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("missing control regenerated")
				}
			}
		})
	}
}
func TestSecurityEpochRotationStopsLiveAndChildDispatch(t *testing.T) {
	h := securityFixture(t)
	parent, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Shutdown()
	parent.SecurityRuntime = h
	child, err := newEngine(t.TempDir(), nil, nil, parent)
	if err != nil {
		t.Fatal(err)
	}
	defer child.Shutdown()
	if child.runtimeDirectory() != h.RuntimeRoot {
		t.Fatal("child runtime forked")
	}
	old := h.control.RecoveryEpoch
	if err = h.RotateRecoveryEpoch(); err != nil {
		t.Fatal(err)
	}
	c, err := ReadSecurityControl(h.Home)
	if err != nil {
		t.Fatal(err)
	}
	if c.Gate != "closed" || c.RecoveryEpoch == old || c.RecoveryID == "" {
		t.Fatal("restore did not fence old authority")
	}
	if err = child.CheckSecurityRuntime(); err == nil {
		t.Fatal("child retained old authority")
	}
	if _, err = child.invoke(context.Background(), nil, Config{}, Call{Name: "shell"}); err == nil {
		t.Fatal("tool passed closed gate")
	}
	if _, err = child.adkStore(); err == nil {
		t.Fatal("database opened under stale epoch")
	}
}
func TestSecurityFutureDatabaseGuardPrecedesMigration(t *testing.T) {
	h := securityFixture(t)
	h.Close()
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("UPDATE security_schema_meta SET minimum_reader_version=999"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err = storage.Open(filepath.Join(h.RuntimeRoot, "sessions.sqlite")); err == nil {
		t.Fatal("unbound old reader accepted future schema")
	}
	if _, err = OpenSecurityHome(context.Background(), h.Home, ""); err == nil {
		t.Fatal("host accepted future schema")
	}
}
func TestSecurityRootAliasCannotChange(t *testing.T) {
	h := securityFixture(t)
	h.Close()
	if err := os.Rename(h.RuntimeRoot, h.RuntimeRoot+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(h.RuntimeRoot+"-original", h.RuntimeRoot); err != nil {
		t.Skip(err)
	}
	if _, err := OpenSecurityHome(context.Background(), h.Home, ""); err == nil {
		t.Fatal("runtime alias accepted")
	}
}
func TestSecurityControlIsPrivateAndStrict(t *testing.T) {
	h := securityFixture(t)
	data, err := os.ReadFile(filepath.Join(h.Home, "security", "control.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	doc["approved"] = true
	if err = writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), doc); err != nil {
		t.Fatal(err)
	}
	if err = h.Check(); err == nil {
		t.Fatal("unknown control field accepted")
	}
}

func TestSecurityLegacyLivePIDCannotBeBypassed(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "web-agent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeSecurityJSON(filepath.Join(dir, "runtime.json"), map[string]any{"pid": os.Getpid(), "token": "synthetic-private-token"}); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenSecurityHome(context.Background(), home, ""); err == nil {
		t.Fatal("legacy live PID allowed competing backend")
	}
	if _, err := os.Stat(filepath.Join(dir, "runtime.json")); err != nil {
		t.Fatal("runtime record removed", err)
	}
}

func TestSecurityImplicitHomeFollowsCustomRuntimeManifest(t *testing.T) {
	home := t.TempDir()
	data := t.TempDir()
	first, err := OpenSecurityHome(context.Background(), home, data)
	if err != nil {
		t.Fatal(err)
	}
	root, epoch := first.RuntimeRoot, first.control.RecoveryEpoch
	first.Close()
	next, err := OpenSecurityHome(context.Background(), home, "")
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if next.RuntimeRoot != root || next.control.RecoveryEpoch != epoch {
		t.Fatal("implicit CLI changed persisted runtime identity")
	}
}

func TestSecurityStdioStateFollowsCustomRuntime(t *testing.T) {
	home, data := t.TempDir(), t.TempDir()
	h, err := OpenSecurityHome(context.Background(), home, data)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
	var output bytes.Buffer
	input := strings.NewReader(`{"id":"configure","method":"configure","session":"fixture","data":{"model":{"url":"http://127.0.0.1:12345/v1/chat/completions","name":"fixture","protocol":"openai"}}}` + "\n")
	if err = ServeHome(context.Background(), home, input, &output); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(data, "ai", "fixture.json")); err != nil {
		t.Fatal("stdio did not use manifest state root", err, output.String())
	}
	if _, err = os.Stat(filepath.Join(home, "web-agent", "ai", "fixture.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stdio forked session state")
	}
}
