package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

const bootTimeQuery = `uptime; sysctl -n kern.boottime; BOOT=$(sysctl -n kern.boottime | sed -E 's/.*sec = ([0-9]+).*/\1/'); date -r "$BOOT" '+%Y-%m-%d %H:%M:%S %Z'; echo "now: $(date '+%Y-%m-%d %H:%M:%S %Z')"`

const mountedImageQuery = `hdiutil info 2>/dev/null | grep -E "image-path|/dev/disk|/Volumes" | head -40; echo; echo "=== 各挂载点内容 ==="; ls /Volumes/AnyGo 2>/dev/null; echo "---"; ls /Volumes/Claude 2>/dev/null`

func TestReadOnlyQueryPolicy(t *testing.T) {
	for _, test := range []struct{ command, risk string }{
		{mountedImageQuery, "readonly"},
		{`systemctl --failed --no-legend --plain; podman ps -a --format '{{.Names}}|{{.State}}' 2>&1 | head -30`, "readonly"},
		{`systemctl restart nginx 2>&1`, "dangerous"},
		{`podman ps; podman restart app`, "write"},
		{`docker ps --host tcp://example:2375`, "write"},
		{`ls /tmp 2>&3`, "write"},
		{`ls /tmp 3>&1`, "write"},
		{`ls /tmp >/tmp/report 2>&1`, "write"},
		{`systemctl --root=/tmp start app`, "write"},
		{bootTimeQuery, "readonly"},
		{`echo "now: $(date '+%Y-%m-%d %H:%M:%S %Z')"`, "readonly"},
		{`BOOT=$(echo 0); date -r "$BOOT" '+%Y'`, "readonly"},
		{`uptime; sysctl -n kern.boottime`, "readonly"},
		{`echo "$(rm /tmp/fixture)"`, "dangerous"},
		{`BOOT=$(sysctl -w kern.hostid=1); echo "$BOOT"`, "dangerous"},
		{`BOOT=$(echo 0); date -r $BOOT '+%Y'`, "dangerous"},
		{`PATH=$(echo /tmp); echo "$PATH"`, "dangerous"},
		{`echo "$(sed -E 's/x/x/e')"`, "dangerous"},
		{`echo "$(sed -E 's/x/x/w /tmp/fixture')"`, "dangerous"},
		{`echo "$(echo hello > /tmp/fixture)"`, "dangerous"},
		{`RUN=$(echo rm); "$RUN" /tmp/fixture`, "dangerous"},
		{`FMT=$(echo -v); printf "$FMT" PATH /tmp`, "dangerous"},
		{`echo "$(cat ~/.ssh/id_ed25519)"`, "dangerous"},
		{`hdiutil info`, "readonly"},
		{`hdiutil info -plist 2>/dev/null`, "readonly"},
		{`hdiutil detach /Volumes/fixture`, "dangerous"},
		{`hdiutil convert fixture -o other`, "write"},
		{`printf '/dev/disk' | grep -E '/dev/disk'`, "readonly"},
		{`grep -e /dev/disk /tmp/status`, "readonly"},
		{`grep -E -- /dev/disk /tmp/status`, "readonly"},
		{`grep --regexp=/dev/disk /tmp/status`, "readonly"},
		{`grep -E pattern /dev/disk0`, "dangerous"},
		{`grep -f /dev/disk0 /tmp/status`, "dangerous"},
		{`grep -Ef /dev/disk0 /tmp/status`, "dangerous"},
		{`grep -vf/dev/disk0 /tmp/status`, "dangerous"},
		{`grep -ve/dev/disk /tmp/status`, "readonly"},
		{`grep -A2 /dev/disk /tmp/status`, "readonly"},
		{`grep --file=/dev/disk0 /tmp/status`, "dangerous"},
		{`cat /dev/rdisk0`, "dangerous"},
		{`cat ~/.ssh/id_ed25519 2>/dev/null`, "dangerous"},
		{`ls /tmp 2> /dev/null`, "readonly"},
		{`ls /tmp >/dev/null`, "readonly"},
		{`ls /tmp 1>/dev/null 2>/dev/null`, "readonly"},
		{`printf 2 >/dev/null`, "readonly"},
		{`printf "2">/dev/null`, "readonly"},
		{`ls /tmp 2>/tmp/errors`, "write"},
		{`ls /tmp 2>>/dev/null`, "write"},
		{`ls /tmp 2>&1`, "readonly"},
		{`ls /tmp 3>/dev/null`, "write"},
		{`ls /tmp 2>`, "write"},
		{`cat </dev/disk0`, "dangerous"},
		{`echo $(rm /tmp/fixture) 2>/dev/null`, "dangerous"},
		{`dd if=/tmp/fixture of=/dev/disk0 2>/dev/null`, "dangerous"},
		{`rm /tmp/fixture 2>/dev/null`, "dangerous"},
	} {
		if got := CommandPolicy(test.command); got.Risk != test.risk {
			t.Errorf("%q: %s, want %s", test.command, got.Risk, test.risk)
		}
	}
	// Safe reconstruction must preserve descriptor syntax and quoted numeric args.
	for _, test := range []struct{ command, output string }{
		{`printf '%s' "2">/dev/null; printf 'DONE'`, "DONE"},
		{`BOOT=$(printf 0); date -u -r "$BOOT" '+%Y-%m-%d'; echo "now: $(printf SAFE_SUBSTITUTION)"`, "1970-01-01\nnow: SAFE_SUBSTITUTION"},
		{`printf '%s' 2 2>/dev/null; printf 'DONE'`, "2DONE"},
		{`ls /lake-query-fixture-does-not-exist 2>/dev/null; printf 'DONE'`, "DONE"},
		{`printf '%s' /dev/disk | grep -E /dev/disk`, "/dev/disk"},
	} {
		if runtime.GOOS == "linux" {
			test.command = strings.Replace(test.command, `date -u -r "$BOOT"`, `date -u -d "@$BOOT"`, 1)
		}
		b, h := fixture(t)
		id, ref := newSession(t, h)
		ctx := context.Background()
		term := b.Terminals.Open(ctx, id, ref)
		tid := stringOf(term["id"])
		entry := b.Terminals.Execute(id, tid, "user", test.command, "")
		result := b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
		if got := strings.TrimSpace(strings.ReplaceAll(stringOf(result["output"]), "\r\n", "\n")); got != test.output {
			t.Errorf("%q rendered incorrectly: %q", test.command, got)
		}
	}
}

func TestSilentDiagnosticCommandUsesSavedPermission(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := step.Add(1)
		if n == 1 || n == 3 {
			emitModel(w, "", []ai.Call{{ID: "diagnostic-query", Name: "shell", Arguments: jsonText(Object{"command": mountedImageQuery, "runtime": "local", "timeout_ms": 60000})}})
		} else {
			emitModel(w, "查询流程结束", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "silent query fixture", Protocol: "openai"})
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": true, "asset_ref": ref, "runtime": "local", "terminal_id": tid}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查挂载信息", "resourceIds": []string{ref}}, 202)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	if view.Pending != nil {
		t.Fatal("silent diagnostic query still requested approval")
	}
	found := false
	for _, card := range view.Cards {
		if card.Title == "shell" && object(card.Data)["risk"] == "readonly" && card.Status == "completed" {
			found = true
		}
	}
	if !found || !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "=== 各挂载点内容 ===") {
		t.Fatal("readonly query was not actually executed")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": false}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "再次检查挂载信息"}, 202)
	view = waitAI(t, b, id, "completed")
	b.workers.Wait()
	if view.Pending != nil {
		t.Fatal("turning ordinary command silence off must not restore readonly query prompts")
	}
}

func TestNestedReadonlyQueryHonorsSavedCommandSilence(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	var step atomic.Int32
	dir := t.TempDir()
	marker := filepath.Join(dir, "ORDINARY_MUTATION_MARKER")
	command := `STAMP=$(printf READONLY_SUBSTITUTION); printf '%s\n' "$STAMP"; echo "now: $(printf READONLY_SUBSTITUTION)"`
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := step.Add(1)
		if n == 1 || n == 3 || n == 5 || n == 7 {
			query := command
			if n == 5 {
				query = `echo "$(touch ` + quote(marker) + `)"`
			}
			if n == 7 {
				query = `echo "$(rm -rf ` + quote(dir) + `/*)"`
			}
			emitModel(w, "", []ai.Call{{ID: "nested-query", Name: "shell", Arguments: jsonText(Object{"command": query, "runtime": "local"})}})
		} else {
			emitModel(w, "检查结束", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "nested fixture", Protocol: "openai"})
	// Keep this permission fixture's four host-inspection rounds from issuing
	// a separate model request for compaction and consuming its scripted steps.
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"contextWindow": 1000000}, 200)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	b.Terminals.Control(id, tid, "agent")
	for _, silent := range []bool{true, false} {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": silent, "asset_ref": ref, "runtime": "local", "terminal_id": tid}, 200)
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "只读嵌套查询"}, 202)
		view := waitAI(t, b, id, "completed")
		b.workers.Wait()
		if view.Pending != nil || !strings.Contains(stringOf(b.Store.History(id, tid)["output"]), "now: READONLY_SUBSTITUTION") {
			t.Fatal("query was not executed silently")
		}
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "普通嵌套修改验证"}, 202)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	if _, err := os.Stat(marker); err != nil || view.Pending != nil {
		t.Fatal("ordinary mutation inside substitution ignored command silence")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "毁灭性嵌套删除验证"}, 202)
	view = waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Risk != "dangerous" {
		t.Fatal("mutation inside substitution bypassed approval")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("broad deletion occurred before approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
}
