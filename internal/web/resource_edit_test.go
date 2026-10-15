package web

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSSHResourceEditPreservesAndRotatesPrivateCredentials(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "ssh", "name": "fixture SSH", "ssh": Object{"host": "127.0.0.1", "username": "fixture", "authMethod": "password", "password": "Synthetic-edit-password-old"}}, 201)
	id := stringOf(resource["id"])
	path := "/api/resources/" + id
	oldRef := stringOf(object(resource["ssh"])["credentialRef"])
	updated := apiTest(t, h, "PATCH", path, Object{"name": "renamed", "ssh": Object{"host": "localhost", "port": 2222, "username": "fixture2", "shell": "bash", "password": ""}}, 200)
	cfg := object(updated["ssh"])
	if cfg["credentialRef"] != oldRef || cfg["host"] != "localhost" || cfg["username"] != "fixture2" || object(b.Store.Resource(id)["ssh"])["username"] != "fixture2" || integer(cfg["port"]) != 2222 || updated["id"] != id || updated["projectId"] != project {
		t.Fatal("edit lost connection identity or existing credential")
	}
	if readSSHSecret(filepath.Join(b.Models.Home, "secrets"), oldRef) != "Synthetic-edit-password-old" {
		t.Fatal("saved password was overwritten")
	}
	updated = apiTest(t, h, "PATCH", path, Object{"name": "rotated", "ssh": Object{"password": "Synthetic-edit-password-new"}}, 200)
	newRef := stringOf(object(updated["ssh"])["credentialRef"])
	if newRef == oldRef || strings.Contains(jsonText(b.Store.Catalog()), "Synthetic-edit-password") {
		t.Fatal("credential rotation did not remain private")
	}
	if readSSHSecret(filepath.Join(b.Models.Home, "secrets"), newRef) != "Synthetic-edit-password-new" {
		t.Fatal("new credential not saved")
	}
	for _, input := range []Object{{"credentialRef": "another-resource"}, {"credentialRef": []string{"bad"}}, {"identityFile": "/tmp/other-key"}, {"host": "-oInjected"}, {"port": 0}, {"authMethod": "key"}, {"command": "touch /tmp/forbidden"}} {
		apiTest(t, h, "PATCH", path, Object{"name": "invalid", "ssh": input}, 400)
	}
	apiTest(t, h, "PATCH", path, Object{"name": "invalid", "projectId": "other"}, 400)
	if b.Store.Resource(id)["name"] != "rotated" {
		t.Fatal("invalid edit changed resource")
	}
	// Changing auth mode requires fresh material, while old private files stay
	// available for redacting historical terminal output and any shared refs.
	key := filepath.Join(t.TempDir(), "synthetic-key")
	if err := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key).Run(); err != nil {
		t.Fatal("fixture key generation failed")
	}
	private, err := os.ReadFile(key)
	if err != nil {
		t.Fatal("fixture key unavailable")
	}
	updated = apiTest(t, h, "PATCH", path, Object{"name": "key auth", "ssh": Object{"authMethod": "key", "privateKey": string(private)}}, 200)
	keyPath := stringOf(object(updated["ssh"])["identityFile"])
	if object(updated["ssh"])["credentialRef"] != nil || strings.Contains(jsonText(updated), "PRIVATE KEY") {
		t.Fatal("password was reused as key passphrase or private material exposed")
	}
	info, err := os.Stat(keyPath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("replacement key is not private")
	}
	updated = apiTest(t, h, "PATCH", path, Object{"name": "keep key", "ssh": Object{"username": "fixture3", "privateKey": nil, "passphrase": ""}}, 200)
	if object(updated["ssh"])["identityFile"] != keyPath {
		t.Fatal("address edit required replacing retained key")
	}
}

func TestTerminalOpeningRejectsConfigurationChangedDuringTrustCheck(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "ssh", "name": "fixture", "ssh": Object{"host": "127.0.0.1", "username": "fixture", "authMethod": "password", "password": "Synthetic-concurrent-config"}}, 201)
	ref := stringOf(resource["id"])
	started, release := make(chan struct{}), make(chan struct{})
	b.Terminals.HostKeyApproval = func(context.Context, string, string) string { close(started); <-release; return "" }
	done := make(chan int, 1)
	go func() {
		code := 0
		defer func() {
			if p := recover(); p != nil {
				if failure, ok := p.(*Failure); ok {
					code = failure.Status
				} else {
					code = 500
				}
			}
			done <- code
		}()
		b.Terminals.OpenInteractive(context.Background(), sid, ref, "")
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("opening did not reach controlled trust check")
	}
	apiTest(t, h, "PATCH", "/api/resources/"+ref, Object{"name": "updated", "ssh": Object{"host": "localhost"}}, 200)
	close(release)
	select {
	case code := <-done:
		if code != 409 {
			t.Fatal("stale target was admitted", code)
		}
	case <-time.After(time.Second):
		t.Fatal("opening did not release admission lock")
	}
	if len(b.Store.ResourceTerminals(ref)) != 0 {
		t.Fatal("stale open created a terminal")
	}
}

func TestTerminalConfigEditBlocksTargetChangesDuringUseAndKeepsHistory(t *testing.T) {
	b, h := fixture(t)
	sid, ref := newSession(t, h)
	path := "/api/resources/" + ref
	term := b.Store.CreateTerminal(sid, ref)
	tid := stringOf(term["id"])
	apiTest(t, h, "PATCH", path, Object{"name": "local renamed"}, 200)
	apiTest(t, h, "PATCH", path, Object{"name": "must not save", "settings": Object{"shell": "sh"}}, 409)
	apiTest(t, h, "PATCH", path, Object{"name": "must not save", "settings": Object{"shell": "zsh"}}, 409)
	if b.Store.Resource(ref)["name"] != "local renamed" {
		t.Fatal("blocked edit changed display name")
	}
	b.Store.TerminalStatus(sid, tid, "disconnected")
	b.Store.Status(sid, "investigating")
	apiTest(t, h, "PATCH", path, Object{"name": "must not save", "settings": Object{"shell": "zsh"}}, 409)
	b.Store.Status(sid, "completed")
	apiTest(t, h, "PATCH", path, Object{"name": "configured local", "settings": Object{"shell": "sh"}}, 200)
	// Explicit sh is respected even for the classic interactive terminal.
	live := b.Terminals.OpenInteractive(context.Background(), sid, ref, "")
	if live["shell"] != "sh" {
		t.Fatal("configured default shell was not used")
	}
	b.Terminals.Close(sid, stringOf(live["id"]))
	if len(objects(b.Store.Snapshot(sid)["terminals"])) < 2 {
		t.Fatal("config edit discarded terminal records")
	}
	for _, input := range []Object{{"shell": "invalid"}, {"shell": true}, {"command": "x"}} {
		apiTest(t, h, "PATCH", path, Object{"name": "bad", "settings": input}, 400)
	}
}

func TestRejectedSSHConfigEditCleansNewSecret(t *testing.T) {
	b, h := fixture(t)
	sid, _ := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	resource := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"kind": "ssh", "name": "fixture", "ssh": Object{"host": "127.0.0.1", "username": "fixture", "authMethod": "password", "password": "Synthetic-cleanup-old"}}, 201)
	ref := stringOf(resource["id"])
	term := b.Store.CreateTerminal(sid, ref)
	root := filepath.Join(b.Models.Home, "secrets")
	before, _ := os.ReadDir(root)
	apiTest(t, h, "PATCH", "/api/resources/"+ref, Object{"name": "blocked", "ssh": Object{"password": "Synthetic-cleanup-new"}}, 409)
	after, _ := os.ReadDir(root)
	if len(before) != len(after) || b.Store.Resource(ref)["name"] != "fixture" {
		t.Fatal("rejected edit left an orphan credential or partial update")
	}
	b.Store.TerminalStatus(sid, stringOf(term["id"]), "disconnected")
}
