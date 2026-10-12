package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

const networkStatusQuery = `echo '=== proxy/tunnel processes ==='; ps ax -o pid,comm | grep -iE 'clash|surge|v2ray|xray|singbox|shadowsocks|trojan|mihomo|stash|quantumult|warp|openvpn|wireguard|tailscale' | grep -v grep; echo '--- proxy env ---'; env | grep -iE 'proxy'; echo '--- utun/proxy owner ---'; lsof -nP -i UDP 2>/dev/null | awk '$9 ~ /:53|:443/ {print $1, $2, $9}' | sort -u | head -20; echo; echo '=== interface traffic counters (en0 / utun4) ==='; netstat -ib | awk 'NR==1 || $1=="en0" || $1=="utun4"'; echo; echo '=== active TCP connections count ==='; netstat -an -p tcp | awk '$NF=="ESTABLISHED"' | wc -l`

func TestNetworkQueriesAndPureAwk(t *testing.T) {
	for _, tc := range []struct{ command, risk string }{
		{networkStatusQuery, "readonly"},
		{`awk -v iface=en0 '$1==iface {print}'`, "readonly"},
		{`awk -v ARGV=fixture '{print}'`, "dangerous"},
		{`env | grep -i proxy`, "readonly"},
		{`env sh -c 'rm fixture'`, "dangerous"},
		{`printf 'a b c\n' | awk '{print $1, $3}'`, "readonly"},
		{`printf '2\n3\n' | awk '{sum += $1} END {print sum}'`, "readonly"},
		{`printf '2\n3\n' | awk '{sum += $1; n++} END {print sum/n}'`, "readonly"},
		{`printf 'a\n' | awk '/a/ {print toupper($0)}'`, "readonly"},
		{`awk 'BEGIN {print "system is just text"}'`, "readonly"},
		{`awk 'BEGIN {system("rm fixture")}'`, "dangerous"},
		{`awk 'BEGIN {print 1 / system("rm fixture") / 2}'`, "dangerous"},
		{`awk 'BEGIN {print "x" > "/tmp/fixture"}'`, "dangerous"},
		{`awk 'BEGIN {print "x" | "sh"}'`, "dangerous"},
		{`awk 'BEGIN {getline x < "/etc/passwd"; print x}'`, "dangerous"},
		{`awk 'BEGIN {print ENVIRON["PASSWORD"]}'`, "dangerous"},
		{`awk 'BEGIN {ARGV[1]="/etc/passwd"}'`, "dangerous"},
		{`awk -f /tmp/script`, "dangerous"},
		{`awk '{print}' /etc/passwd`, "dangerous"},
		{`awk "$1"`, "dangerous"},
		{`sort --compress-program=sh`, "write"},
		{`sort -o /tmp/sorted`, "write"},
		{`lsof -nP -iTCP:443 -sTCP:ESTABLISHED`, "readonly"},
		{`netstat -an -p tcp`, "readonly"},
		{`ss -Htn state established`, "readonly"},
		{`ss -K dst 127.0.0.1`, "dangerous"},
		{`ip -s link show`, "readonly"},
		{`ip link set en0 down`, "dangerous"},
		{`ifconfig en0`, "readonly"},
		{`ifconfig en0 down`, "dangerous"},
		{`route -n get default`, "readonly"},
		{`route delete default`, "dangerous"},
		{`networksetup -getdnsservers Wi-Fi`, "readonly"},
		{`networksetup -setnetworkserviceenabled Wi-Fi off`, "dangerous"},
	} {
		if got := CommandPolicy(tc.command).Risk; got != tc.risk {
			t.Errorf("%q got %s want %s", tc.command, got, tc.risk)
		}
	}
	b, h := fixture(t)
	policy := apiTest(t, h, "POST", "/api/commands/policy", Object{"command": networkStatusQuery}, 200)
	if policy["risk"] != "readonly" {
		t.Fatal("manual UI and Agent classifier disagree")
	}
	apiTest(t, h, "POST", "/api/commands/policy", Object{"command": "pwd\nrm fixture"}, 400)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	entry := b.Terminals.Execute(id, tid, "user", `printf '2\n3\n' | awk '{sum += $1} END {print sum}' | sort -u`, "")
	result := b.Terminals.Wait(context.Background(), id, tid, stringOf(entry["id"]))
	if strings.TrimSpace(stringOf(result["output"])) != "5" {
		t.Fatal("safe awk rendering changed actual filter behavior")
	}
}

func TestNetworkQueryRunsWithoutRepeatApproval(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{ID: "network-query", Name: "shell", Arguments: jsonText(Object{"command": networkStatusQuery, "runtime": "local", "timeout_ms": 60000})}})
		} else {
			emitModel(w, "已采集网络状态", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "network query fixture", Protocol: "openai"})
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "terminal_id": tid, "silentCommands": false}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "网络怎么样"}, 202)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	if view.Pending != nil || !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "active TCP connections count") {
		t.Fatal("read-only network diagnostics still required approval or did not execute")
	}
}
