package web

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRealSSHPersistentPTY(t *testing.T) {
	if _, e := os.Stat("/usr/sbin/sshd"); e != nil {
		t.Skip("sshd unavailable")
	}
	b, h := fixture(t)
	id, _ := newSession(t, h)
	dir := t.TempDir()
	secrets := filepath.Join(b.Models.Home, "secrets")
	must(os.MkdirAll(secrets, 0700))
	key := filepath.Join(secrets, "fixture")
	hostKey := filepath.Join(dir, "host-key")
	for _, p := range []string{key, hostKey} {
		if exec.Command("/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", p).Run() != nil {
			t.Fatal("synthetic SSH key generation failed")
		}
	}
	probe, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	config := filepath.Join(dir, "sshd.conf")
	must(os.WriteFile(config, []byte(fmt.Sprintf("Port %d\nListenAddress 127.0.0.1\nHostKey %s\nPidFile %s/pid\nAuthorizedKeysFile %s.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\nSubsystem sftp internal-sftp\n", port, hostKey, dir, key)), 0600))
	daemon := exec.Command("/usr/sbin/sshd", "-D", "-e", "-f", config)
	if e = daemon.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { daemon.Process.Kill(); daemon.Wait() }()
	pub, e := os.ReadFile(hostKey + ".pub")
	if e != nil {
		t.Fatal(e)
	}
	parts := strings.Fields(string(pub))
	known := filepath.Join(dir, "known_hosts")
	must(os.WriteFile(known, []byte(fmt.Sprintf("[127.0.0.1]:%d %s %s\n", port, parts[0], parts[1])), 0600))
	b.Terminals.KnownHosts = known
	current, _ := user.Current()
	ssh := validateSSH(b.Models.Home, Object{"host": "127.0.0.1", "port": port, "username": current.Username, "identityFile": key})
	r := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "isolated SSH", "ssh", ssh)
	session := b.Store.CreateSession(stringOf(r["projectId"]), "SSH fixture", []string{stringOf(r["id"])})
	sid := stringOf(session["id"])
	allowFixtureHost(b, sid)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for n := 0; n < 100; n++ {
		conn, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Millisecond*50)
		if e == nil {
			conn.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	term := b.Terminals.Open(ctx, sid, stringOf(r["id"]))
	tid := stringOf(term["id"])
	entry := b.Terminals.Execute(sid, tid, "user", "cd /tmp; export LAKE_SSH_FIXTURE=native", "")
	b.Terminals.Wait(ctx, sid, tid, stringOf(entry["id"]))
	entry = b.Terminals.Execute(sid, tid, "user", "printf '%s:%s' \"$PWD\" \"$LAKE_SSH_FIXTURE\"", "")
	result := b.Terminals.Wait(ctx, sid, tid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "/tmp:native") {
		t.Fatal(result)
	}
	b.Terminals.Resize(sid, tid, 90, 25)
	b.Terminals.Close(sid, tid)
	// The model chooses SSH inspection; a later unmentioned turn can choose
	// to refresh through the same remote PTY.
	var remoteTerminal atomic.Value
	var rounds atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var req Object
		json.NewDecoder(request.Body).Decode(&req)
		if fixtureModelInspect(w, req, stringOf(r["id"]), "ssh") {
			return
		}
		latest := Object{}
		for _, m := range objects(req["messages"]) {
			if m["role"] == "tool" && m["name"] == "inspect_host" {
				json.Unmarshal([]byte(stringOf(m["content"])), &latest)
			}
		}
		if latest["runtime"] != "ssh" || latest["status"] != "ready" || len(objects(latest["checks"])) < 4 {
			t.Error("model-selected SSH inspection lacked real session evidence")
		}
		if rounds.Add(1) == 1 {
			remoteTerminal.Store(stringOf(latest["terminal_id"]))
		} else if remoteTerminal.Load() != stringOf(latest["terminal_id"]) {
			t.Error("later conversation lost its SSH session")
		}
		emitModel(w, "已经读取远程会话数据", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "SSH session fixture", Protocol: "openai"})
	for _, refs := range [][]string{{stringOf(r["id"])}, nil} {
		apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "内存状态", "resourceIds": refs}, 202)
		b.workers.Wait()
		view, err := b.Engine.Snapshot(sid)
		if err != nil || view.Status != "completed" {
			t.Fatal("remote conversation preparation failed")
		}
	}
	bound := stringOf(b.Store.Options(sid)["terminal_id"])
	if bound == "" || b.Store.Terminal(sid, bound)["resourceId"] != r["id"] || rounds.Load() != 2 {
		t.Fatal("SSH binding or reuse failed")
	}
	b.Terminals.Close(sid, bound)
	// An empty trust store must refuse; no permissive fallback to a local terminal.
	empty := filepath.Join(dir, "empty-known-hosts")
	must(os.WriteFile(empty, nil, 0600))
	b.Terminals.KnownHosts = empty
	expectPanic(t, 503, func() { b.Terminals.Open(ctx, sid, stringOf(r["id"])) })
	expectPanic(t, 400, func() {
		validateSSH(b.Models.Home, Object{"host": "127.0.0.1", "username": current.Username, "identityFile": "/etc/passwd"})
	})
}
