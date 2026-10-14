package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func waitManualIdle(t *testing.T, b *Server, owner, tid string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if b.Terminals.ManualIdle(b.Store.Terminal(owner, tid)) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	l := b.Terminals.get(owner, tid)
	l.mu.Lock()
	pending, job, output := l.userInputPending, l.job != nil, l.output
	l.mu.Unlock()
	t.Fatalf("manual idle: status=%v holder=%v pending=%v job=%v output=%q", b.Store.Terminal(owner, tid)["status"], b.Store.Terminal(owner, tid)["holder"], pending, job, output)
}

func TestBorrowManualTerminalHidesAgentCommandsAndPreservesShell(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "sh", "fish"} {
		t.Run(shell, func(t *testing.T) {
			if _, err := exec.LookPath(shell); err != nil {
				t.Skip("shell unavailable")
			}
			b, h := fixture(t)
			chat, ref := newSession(t, h)
			owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
			term := b.Terminals.OpenInteractive(context.Background(), owner, ref, shell)
			tid := stringOf(term["id"])
			dir := t.TempDir()
			b.Terminals.Input(owner, tid, "cd "+quote(dir)+"\r", false)
			waitManualIdle(t, b, owner, tid)
			time.Sleep(150 * time.Millisecond)
			before := stringOf(b.Store.History(owner, tid)["output"])
			b.bindManualTerminalForHuman(chat, []Object{{"asset_ref": ref}}, Object{"terminalId": tid, "generation": term["generation"]})
			if b.Store.Options(chat)["terminal_id"] != tid {
				t.Fatal("chat did not bind the manual terminal")
			}
			reused := b.hostTerminal(context.Background(), chat, ref, false)
			if reused["id"] != tid || len(b.Store.ResourceTerminals(ref)) != 1 {
				t.Fatal("Agent created another terminal")
			}
			entry := b.Terminals.Execute(chat, tid, "agent", "pwd", "")
			result := b.Terminals.Wait(context.Background(), chat, tid, stringOf(entry["id"]))
			if filepath.Clean(strings.TrimSpace(stringOf(result["output"]))) != filepath.Clean(dir) {
				t.Fatalf("hidden synthetic pwd result: %q", stringOf(result["output"]))
			}
			if result["originSessionId"] != chat {
				t.Fatal("command audit did not belong to chat")
			}
			after := stringOf(b.Store.History(owner, tid)["output"])
			if before != after || strings.Contains(after, "agent > pwd") {
				t.Fatalf("synthetic console changed: before=%q after=%q", before, after)
			}
			b.releaseManualTerminals(chat)
			waitManualIdle(t, b, owner, tid)
			b.Terminals.Input(owner, tid, "printf 'USER_VISIBLE_AGAIN\\n'\r", false)
			waitManualIdle(t, b, owner, tid)
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if strings.Contains(stringOf(b.Store.History(owner, tid)["output"]), "USER_VISIBLE_AGAIN\r\n") {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
			t.Fatal("manual commands were hidden after Agent returned input")
		})
	}
}

func TestNewChatReusesSelectedManualTerminalWithoutCreationApproval(t *testing.T) {
	b, h := fixture(t)
	original, ref := newSession(t, h)
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	term := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	tid := stringOf(term["id"])
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		must(json.NewDecoder(r.Body).Decode(&req))
		if fixtureModelInspect(w, req, ref, "local") {
			return
		}
		requests.Add(1)
		emitModel(w, "已从原终端读取主机状态", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "manual reuse fixture", Protocol: "openai"})
	project := stringOf(b.Store.Session(original)["projectId"])
	chat := apiTest(t, h, "POST", "/api/projects/"+project+"/sessions", Object{"terminalReuse": Object{"terminalId": tid, "generation": term["generation"]}}, 201)
	id := stringOf(chat["id"])
	if b.Store.Options(id)["terminal_id"] != tid {
		t.Fatal("new chat did not inherit selected terminal")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "主机内存状态", "resourceIds": []string{ref}, "terminalReuse": Object{"terminalId": tid, "generation": term["generation"]}}, 202)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	if view.Pending != nil || requests.Load() == 0 || len(b.Store.ResourceTerminals(ref)) != 1 {
		t.Fatal("Agent requested creation instead of reusing manual terminal")
	}
	if b.Store.Options(id)["terminal_id"] != tid {
		t.Fatal("Agent switched terminals")
	}
	for _, entry := range objects(b.Store.History(owner, tid)["entries"]) {
		if entry["actor"] == "agent" && entry["originSessionId"] != id {
			t.Fatal("reuse lost audit origin")
		}
	}
	visible := stringOf(b.Store.History(owner, tid)["output"])
	if strings.Contains(visible, "agent >") || strings.Contains(visible, "uname -s") || strings.Contains(visible, "vm_stat") || strings.Contains(visible, "__lake_managed") {
		t.Fatal("host inspection leaked to manual console")
	}
	waitManualIdle(t, b, owner, tid)
}

func TestManualReuseRequiresExplicitSelectionAndRejectsStaleAndUnfinishedInput(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	term := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	tid := stringOf(term["id"])
	b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	refs := []Object{{"asset_ref": ref}}
	b.bindManualTerminalForHuman(id, refs, nil)
	if stringOf(b.Store.Options(id)["terminal_id"]) != "" {
		t.Fatal("resource reference implicitly selected a manual terminal")
	}
	expectPanic(t, 409, func() { b.bindManualTerminalForHuman(id, refs, Object{"terminalId": tid, "generation": "stale"}) })
	b.Terminals.Input(owner, tid, "unfinished", false)
	expectPanic(t, 409, func() {
		b.bindManualTerminalForHuman(id, refs, Object{"terminalId": tid, "generation": term["generation"]})
	})
	b.Terminals.Input(owner, tid, "\x03", false)
	waitManualIdle(t, b, owner, tid)
	other := b.Store.CreateProject("different project")
	outsider := stringOf(b.Store.CreateSession(stringOf(other["id"]), "outsider", nil)["id"])
	expectPanic(t, 404, func() {
		b.bindManualTerminalForHuman(outsider, refs, Object{"terminalId": tid, "generation": term["generation"]})
	})
	count := len(objects(b.Store.Catalog()["sessions"]))
	apiTest(t, h, "POST", "/api/projects/"+stringOf(b.Store.Session(id)["projectId"])+"/sessions", Object{"terminalReuse": Object{"terminalId": tid, "generation": "stale"}}, 409)
	if len(objects(b.Store.Catalog()["sessions"])) != count {
		t.Fatal("invalid reuse left an orphan chat")
	}
}

func TestCancelledWaitReturnsManualInputAfterHiddenJobCompletes(t *testing.T) {
	b, h := fixture(t)
	chat, ref := newSession(t, h)
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	term := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	tid := stringOf(term["id"])
	b.bindManualTerminalForHuman(chat, []Object{{"asset_ref": ref}}, Object{"terminalId": tid, "generation": term["generation"]})
	b.hostTerminal(context.Background(), chat, ref, false)
	entry := b.Terminals.Execute(chat, tid, "agent", "printf 'HIDDEN_CANCEL_START\\n'; sleep 0.15; printf 'HIDDEN_CANCEL_END\\n'", "")
	b.releaseManualTerminals(chat)
	if b.Store.Terminal(owner, tid)["holder"] != "agent" {
		t.Fatal("input returned while hidden command was running")
	}
	apiTest(t, h, "POST", "/api/sessions/"+owner+"/terminals/"+tid+"/input", Object{"data": "pwd\r"}, 409)
	result := b.Terminals.Wait(context.Background(), chat, tid, stringOf(entry["id"]))
	if !strings.Contains(stringOf(result["output"]), "HIDDEN_CANCEL_END") {
		t.Fatal("hidden job was interrupted or replayed")
	}
	waitManualIdle(t, b, owner, tid)
	if strings.Contains(stringOf(b.Store.History(owner, tid)["output"]), "HIDDEN_CANCEL") {
		t.Fatal("hidden output leaked after cancelled waiter")
	}
}

func TestManualReuseKeepsCommandApproval(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	b.configure(id, Object{"silentCommands": false})
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	term := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	tid := stringOf(term["id"])
	marker := filepath.Join(t.TempDir(), "SHOULD_NOT_BE_CREATED")
	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if step.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{ID: "existing-shell-change", Name: "shell", Arguments: jsonText(Object{"command": "touch " + quote(marker)})}})
		} else {
			emitModel(w, "已拒绝变更", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "manual permission fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查主机然后变更", "resourceIds": []string{ref}, "terminalReuse": Object{"terminalId": tid, "generation": term["generation"]}}, 202)
	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Kind != "command" || view.Pending.NeedsTerminal {
		t.Fatal("reuse removed command approval or requested a second shell")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	waitManualIdle(t, b, owner, tid)
	if len(b.Store.ResourceTerminals(ref)) != 1 {
		t.Fatal("command rejection created a new shell")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("rejected command had an effect")
	}
}

func TestPermissionRevocationReturnsBorrowedInputWithoutRevivingAccess(t *testing.T) {
	b, h := fixture(t)
	chat, ref := newSession(t, h)
	// Establish the permission state under test explicitly so the later toggle
	// below is a real permission change regardless of the current defaults.
	b.configure(chat, Object{"silentCommands": false, "silentTerminalCreation": false})
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	term := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	tid := stringOf(term["id"])
	b.bindManualTerminalForHuman(chat, []Object{{"asset_ref": ref}}, Object{"terminalId": tid, "generation": term["generation"]})
	b.hostTerminal(context.Background(), chat, ref, false)
	entry := b.Terminals.Execute(chat, tid, "agent", "sleep 0.15", "")
	b.configure(chat, Object{"silentCommands": true})
	expectTerminalFailure(t, func() { b.Terminals.Screen(chat, tid, "tail", 80, 20000) })
	b.Terminals.Wait(context.Background(), owner, tid, stringOf(entry["id"]))
	waitManualIdle(t, b, owner, tid)
	if b.manualTerminalBound(chat, term) {
		t.Fatal("permission revocation revived manual binding")
	}
	expectTerminalFailure(t, func() { b.Terminals.Screen(chat, tid, "tail", 80, 20000) })
}

func TestOrdinaryChatUsesBackgroundTerminalWithMultipleManualShells(t *testing.T) {
	b, h := fixture(t)
	chat, ref := newSession(t, h)
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	one := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	two := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	b.Terminals.Input(owner, stringOf(two["id"]), "unfinished", false)
	// An older implicit/manual binding must not survive an ordinary resource chat.
	b.bindManualTerminalForHuman(chat, []Object{{"asset_ref": ref}}, Object{"terminalId": one["id"], "generation": one["generation"]})
	b.configure(chat, Object{"silentTerminalCreation": true})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		must(json.NewDecoder(r.Body).Decode(&req))
		if fixtureModelInspect(w, req, ref, "local") {
			return
		}
		emitModel(w, "后台检查完成", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "background fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+chat+"/messages", Object{"text": "CPU 呢", "resourceIds": []string{ref}}, 202)
	view := waitAI(t, b, chat, "completed")
	b.workers.Wait()
	tid := stringOf(b.Store.Options(chat)["terminal_id"])
	if view.Pending != nil || tid == "" || tid == one["id"] || tid == two["id"] || b.Terminals.UserInteractive(tid) {
		t.Fatal("ordinary AI turn did not use a separate managed shell")
	}
	if b.Store.Terminal(chat, tid)["holder"] != "agent" || b.manualTerminalBound(chat, one) {
		t.Fatal("ordinary turn retained a manual input lease")
	}
	expectTerminalFailure(t, func() { b.Terminals.Screen(chat, stringOf(one["id"]), "tail", 80, 20000) })
	for _, term := range []Object{one, two} {
		if len(objects(b.Store.History(owner, stringOf(term["id"]))["entries"])) != 0 || b.Store.Terminal(owner, stringOf(term["id"]))["holder"] != "user" {
			t.Fatal("AI touched a manual shell")
		}
	}
	list := objects(apiTest(t, h, "GET", "/api/resources/"+ref+"/terminals", nil, 200)["terminals"])
	if len(list) != 2 {
		t.Fatal("background terminal appeared in resource picker")
	}
	apiTest(t, h, "POST", "/api/sessions/"+chat+"/messages", Object{"text": "再检查", "resourceIds": []string{ref}}, 202)
	waitAI(t, b, chat, "completed")
	b.workers.Wait()
	if b.Store.Options(chat)["terminal_id"] != tid || len(b.Store.ResourceTerminals(ref)) != 3 {
		t.Fatal("next ordinary turn did not reuse its own background connection")
	}
}

func TestOrdinaryChatDropsDisconnectedForeignTerminalBinding(t *testing.T) {
	b, h := fixture(t)
	chat, ref := newSession(t, h)
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	term := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	b.bindManualTerminalForHuman(chat, []Object{{"asset_ref": ref}}, Object{"terminalId": term["id"], "generation": term["generation"]})
	b.Terminals.Close(owner, stringOf(term["id"]))
	b.bindManualTerminalForHuman(chat, nil, nil)
	if stringOf(b.Store.Options(chat)["terminal_id"]) != "" {
		t.Fatal("ordinary chat retained an expired manual binding")
	}
	if b.Store.Options(chat)["asset_ref"] != ref {
		t.Fatal("dropping the stale shell forgot the target resource")
	}
}
