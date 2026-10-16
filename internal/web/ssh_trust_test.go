package web

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"golang.org/x/crypto/ssh"
)

// Public handshake only. Authentication callbacks must never be reached by
// the fingerprint probe, including before a human decision.
func rotatingHostKeyServer(t *testing.T) (int, func() string, *atomic.Int32) {
	t.Helper()
	var signer atomic.Value
	rotate := func() string {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		s, err := ssh.NewSignerFromKey(key)
		if err != nil {
			t.Fatal(err)
		}
		signer.Store(s)
		return ssh.FingerprintSHA256(s.PublicKey())
	}
	rotate()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	var auth atomic.Int32
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(3 * time.Second))
				cfg := &ssh.ServerConfig{PasswordCallback: func(ssh.ConnMetadata, []byte) (*ssh.Permissions, error) { auth.Add(1); return nil, os.ErrPermission }}
				cfg.AddHostKey(signer.Load().(ssh.Signer))
				c, _, _, _ := ssh.NewServerConn(conn, cfg)
				if c != nil {
					c.Close()
				}
			}()
		}
	}()
	t.Cleanup(func() { l.Close(); wg.Wait() })
	return port, rotate, &auth
}

func waitHostTrust(t *testing.T, b *Server, id string) Object {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for time.Now().Before(end) {
		if p := b.hostKeyPrompt(id); p != nil {
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("host key dialog did not appear")
	return nil
}

func startHostProbe(b *Server, id, ref string) <-chan error {
	done := make(chan error, 1)
	go func() {
		var result error
		func() {
			defer func() {
				if p := recover(); p != nil {
					if err, ok := p.(error); ok {
						result = err
					} else {
						result = os.ErrInvalid
					}
				}
			}()
			b.ensureHostKey(b.Context, id, ref)
		}()
		done <- result
	}()
	return done
}

func TestLakeGlobalHostTrustAndRotation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b, h := fixture(t)
	id, _ := newSession(t, h)
	port, rotate, auth := rotatingHostKeyServer(t)
	config := Object{"host": "127.0.0.1", "port": port, "username": "fixture"}
	resource := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "First resource", "ssh", config)
	ref := stringOf(resource["id"])
	done := startHostProbe(b, id, ref)
	p := waitHostTrust(t, b, id)
	path := lakeHostKeyPath(b.Models.Home, "127.0.0.1", port)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("fingerprint saved before human approval")
	}
	if auth.Load() != 0 || p["scope"] != "lake" || p["changed"] != false {
		t.Fatal("probe authenticated or trust is not global")
	}
	secondProject := b.Store.CreateProject("Another project")
	secondResource := b.Store.CreateResource(stringOf(secondProject["id"]), "Same host elsewhere", "ssh", config)
	other := b.Store.CreateSession(stringOf(secondProject["id"]), "Another session", nil)
	otherID := stringOf(other["id"])
	apiTest(t, h, "POST", "/api/sessions/"+otherID+"/host-key", Object{"id": p["id"], "accept": true, "fingerprint": p["fingerprint"]}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/host-key", Object{"id": p["id"], "accept": true, "fingerprint": "wrong"}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/host-key", Object{"id": p["id"], "accept": true, "fingerprint": p["fingerprint"]}, 200)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("global trust record is missing or insecure")
	}
	if returned := b.ensureHostKey(b.Context, otherID, stringOf(secondResource["id"])); returned != path || b.hostKeyPrompt(otherID) != nil {
		t.Fatal("trust was not reused across project/session/resource IDs")
	}
	if auth.Load() != 0 {
		t.Fatal("fingerprint check sent authentication")
	}
	previous := stringOf(p["fingerprint"])
	changed := rotate()
	done = startHostProbe(b, otherID, stringOf(secondResource["id"]))
	p = waitHostTrust(t, b, otherID)
	if p["changed"] != true || p["fingerprint"] != changed || stringsOf(p["previousFingerprints"])[0] != previous {
		t.Fatal("rotation did not require review of old and new fingerprints")
	}
	if p["changed"] != true || len(stringsOf(p["previousFingerprints"])) == 0 {
		t.Fatal("rotated fingerprint prompt did not show both old and new fingerprints")
	}
	apiTest(t, h, "POST", "/api/sessions/"+otherID+"/host-key", Object{"id": p["id"], "accept": false}, 200)
	if err := <-done; err == nil {
		t.Fatal("rejected key still connected")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey(data[len(knownPeerPrefix(port)):])
	if err != nil || ssh.FingerprintSHA256(key) != previous {
		t.Fatal("rejection replaced the global record")
	}
	done = startHostProbe(b, otherID, stringOf(secondResource["id"]))
	p = waitHostTrust(t, b, otherID)
	if p["changed"] != true || len(stringsOf(p["previousFingerprints"])) == 0 {
		t.Fatal("retry did not show the rotated fingerprint for explicit approval")
	}
	data, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err = ssh.ParseAuthorizedKey(data[len(knownPeerPrefix(port)):])
	if err != nil || ssh.FingerprintSHA256(key) != previous {
		t.Fatal("new fingerprint was trusted before explicit approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+otherID+"/host-key", Object{"id": p["id"], "accept": true, "fingerprint": p["fingerprint"]}, 200)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	// Public hostname/port are the trust identity; the stored record remains
	// available after opening a new server with the same Lake home.
	home := b.Models.Home
	b.Close()
	second, err := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token"})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if second.Terminals.hostKeyPath(config) != path {
		t.Fatal("trust storage changed across server restart")
	}
	if _, err = privateFile(filepath.Join(home, "secrets"), path); err != nil {
		t.Fatal("restarted Lake cannot use saved trust record")
	}
	if returned := second.ensureHostKey(second.Context, otherID, stringOf(secondResource["id"])); returned != path || second.hostKeyPrompt(otherID) != nil {
		t.Fatal("restarted Lake did not reuse the confirmed global fingerprint")
	}
}

func TestFirstSSHConnectionCombinesTrustAndTerminalCreation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	b, h := fixture(t)
	id, _ := newSession(t, h)
	password := "isolated-fixture-password"
	port, known := credentialSSHServer(t, password, nil)
	config, cleanup := prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "port": port, "username": "fixture", "authMethod": "password", "password": password})
	defer cleanup()
	resource := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "Unknown SSH fixture", "ssh", config)
	ref := stringOf(resource["id"])
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		must(json.NewDecoder(r.Body).Decode(&req))
		if fixtureModelInspect(w, req, ref, "ssh") {
			return
		}
		emitModel(w, "指纹确认后已连接", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "host trust fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查内存", "resourceIds": []string{ref}}, 202)
	p := waitHostTrust(t, b, id)
	view, err := b.Engine.Snapshot(id)
	if err != nil || view.Pending != nil {
		t.Fatal("unknown host required an extra terminal-creation approval before the trust dialog")
	}
	if len(objects(b.Store.Snapshot(id)["terminals"])) != 0 {
		t.Fatal("terminal opened before trust was confirmed")
	}
	pub, err := os.ReadFile(known)
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey(pub[len(knownPeerPrefix(port)):])
	if err != nil || ssh.FingerprintSHA256(key) != p["fingerprint"] {
		t.Fatal("dialog fingerprint differs from the actual server key")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/host-key", Object{"id": p["id"], "accept": true, "fingerprint": p["fingerprint"]}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	terms := objects(b.Store.Snapshot(id)["terminals"])
	if len(terms) != 1 || terms[0]["status"] != "ready" {
		t.Fatal("confirmed key did not establish a strict verified SSH terminal")
	}
	if b.hostKeyPrompt(id) != nil {
		t.Fatal("completed trust dialog remained pending")
	}
}

func knownPeerPrefix(port int) string { return "[127.0.0.1]:" + strconv.Itoa(port) + " " }

func TestParallelSpecialistsShareOneHostTrustDecision(t *testing.T) {
	for _, accept := range []bool{true, false} {
		t.Run(strconv.FormatBool(accept), func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			b, h := fixture(t)
			sid, _ := newSession(t, h)
			port, _, auth := rotatingHostKeyServer(t)
			resource := b.Store.CreateResource(stringOf(b.Store.Session(sid)["projectId"]), "Parallel trust fixture", "ssh", Object{"host": "127.0.0.1", "port": port, "username": "fixture"})
			first := startHostProbe(b, sid, stringOf(resource["id"]))
			prompt := waitHostTrust(t, b, sid)
			second := startHostProbe(b, sid, stringOf(resource["id"]))
			// The peer must wait for this same human decision, not return an immediate
			// 'handle current fingerprint prompt' failure and abandon its deliverable.
			select {
			case err := <-second:
				t.Fatal("parallel peer did not share the pending prompt", err)
			case <-time.After(100 * time.Millisecond):
			}
			if auth.Load() != 0 {
				t.Fatal("fingerprint wait authenticated before approval")
			}
			apiTest(t, h, "POST", "/api/sessions/"+sid+"/host-key", Object{"id": prompt["id"], "accept": accept, "fingerprint": prompt["fingerprint"]}, 200)
			for _, done := range []<-chan error{first, second} {
				select {
				case err := <-done:
					if (err == nil) != accept {
						t.Fatal("peers received inconsistent trust decision", err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("peer stuck after shared trust decision")
				}
			}
			if auth.Load() != 0 {
				t.Fatal("public fingerprint probe attempted authentication")
			}
		})
	}
}
