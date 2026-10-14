package web

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestFailedSSHConnectionDoesNotRepeatApproval(t *testing.T) {
	b, h := fixture(t)
	id, local := newSession(t, h)
	b.configure(id, Object{"silentCommands": false, "silentTerminalCreation": false})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close() // A real refused connection, confined to this machine.
	config, cleanup := prepareSSH(b.Models.Home, Object{"host": "127.0.0.1", "port": port, "username": "synthetic", "authMethod": "password", "password": "fixture-password-only"})
	defer cleanup()
	resource := b.Store.CreateResource(stringOf(b.Store.Session(id)["projectId"]), "Unavailable fixture", "ssh", config)
	ref := stringOf(resource["id"])
	b.Terminals.KnownHosts = filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(b.Terminals.KnownHosts, nil, 0600); err != nil {
		t.Fatal(err)
	}
	alias := fmt.Sprintf("a_%x", sha256.Sum256([]byte(ref)))[:18]
	var requests atomic.Int32
	var blockedCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		json.NewDecoder(r.Body).Decode(&req)
		if fixtureModelInspect(w, req, ref, "ssh") {
			return
		}
		if requests.Add(1) == 1 {
			emitModel(w, "", []ai.Call{
				{ID: "retry-shell", Name: "shell", Arguments: jsonText(Object{"command": "free -m", "runtime": "ssh", "asset_ref": alias})},
				{ID: "retry-inspect", Name: "inspect_host", Arguments: jsonText(Object{"runtime": "ssh", "asset_ref": alias})},
				{ID: "retry-open", Name: "open_ssh_terminal", Arguments: jsonText(Object{"asset_ref": alias})},
				{ID: "retry-read", Name: "read", Arguments: jsonText(Object{"path": "/proc/meminfo", "runtime": "ssh", "asset_ref": alias})},
			})
			return
		}
		for _, message := range objects(req["messages"]) {
			if message["role"] == "tool" && strings.HasPrefix(stringOf(message["tool_call_id"]), "retry-") && strings.Contains(stringOf(message["content"]), "已暂停") {
				blockedCalls.Add(1)
			}
		}
		emitModel(w, "连接失败后停止重复创建", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "failure pause fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查内存", "resourceIds": []string{ref}}, 202)
	approval := waitAI(t, b, id, "waiting_approval")
	if approval.Pending == nil || approval.Pending.Kind != "terminal_open" {
		t.Fatal("initial connection must still require permission")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": approval.Pending.ID, "accept": true}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if blockedCalls.Load() != 4 || len(objects(b.Store.Snapshot(id)["terminals"])) != 1 {
		t.Fatal("alternate tools retried the same failed host")
	}
	// Asking for diagnosis is not permission to try connecting again.
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "为什么连接不上，还一直让我确认重试"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if len(objects(b.Store.Snapshot(id)["terminals"])) != 1 {
		t.Fatal("diagnostic follow-up opened another connection")
	}
	// Failure of this SSH resource does not pause a different local target.
	if _, err := b.bridge(context.Background(), id, "policy", Object{"name": "shell", "arguments": Object{"command": "uptime", "runtime": "local", "asset_ref": local}}, false); err != nil {
		t.Fatal("failure leaked to another resource")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "请重新连接"}, 202)
	retry := waitAI(t, b, id, "waiting_approval")
	if retry.Pending == nil || retry.Pending.ID == approval.Pending.ID {
		t.Fatal("explicit retry did not require fresh authorization")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": retry.Pending.ID, "accept": true}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if len(objects(b.Store.Snapshot(id)["terminals"])) != 2 {
		t.Fatal("retry was not limited to one new attempt")
	}
	// Restore from retained startup output as on a service restart.
	b.resetConnectionFailures(id)
	_, err = b.bridge(context.Background(), id, "policy", Object{"name": "shell", "arguments": Object{"command": "free -m", "runtime": "ssh", "asset_ref": ref}}, false)
	if err == nil || !strings.Contains(err.Error(), "SSH 端口拒绝连接") || !strings.Contains(err.Error(), "已暂停") {
		t.Fatal("retained failure did not preserve the specific reason")
	}
	// A known_hosts change releases the pause, but not the creation approval.
	future := time.Now().Add(time.Second)
	if err := os.Chtimes(b.Terminals.KnownHosts, future, future); err != nil {
		t.Fatal(err)
	}
	policy, err := b.bridge(context.Background(), id, "policy", Object{"name": "inspect_host", "arguments": Object{"runtime": "ssh", "asset_ref": ref}}, false)
	if err != nil || object(policy)["needsTerminal"] != true {
		t.Fatal("configuration repair did not release the pause")
	}
}

func TestSSHStartupReasonAndRetryIntent(t *testing.T) {
	for _, tc := range []struct{ output, want string }{
		{"Host key verification failed.", "尚未受信任"},
		{"REMOTE HOST IDENTIFICATION HAS CHANGED", "已变化"},
		{"synthetic@host: Permission denied (publickey).", "身份认证失败"},
		{"ssh: connect to host synthetic port 22: Connection refused", "端口拒绝连接"},
		{"Connection timed out", "连接超时"},
		{"Could not resolve hostname synthetic", "无法解析"},
		{"No route to host", "网络不可达"},
	} {
		result := terminalConnectionError(tc.output+"\nfixture-secret-not-for-display", "")
		if !strings.Contains(result, tc.want) || strings.Contains(result, "fixture-secret") || strings.Contains(result, "synthetic") {
			t.Fatal("startup reason is missing or raw stderr escaped")
		}
	}
	for _, message := range []string{"为什么一直重试", "不要重试", "为啥重新连接失败", "don't retry", "显示 retry.log"} {
		if connectionRetryRequested(message) {
			t.Fatal("diagnosis or negation released a paused connection")
		}
	}
	for _, message := range []string{"重试", "请重新连接看看内存", "继续", "please retry", "reconnect now"} {
		if !connectionRetryRequested(message) {
			t.Fatal("explicit retry was not recognized")
		}
	}
}
