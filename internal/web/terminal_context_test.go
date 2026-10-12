package web

import (
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestTerminalContextIncludesRunningUnknownAndCurrentCwd(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), id, ref)
	tid := stringOf(term["id"])
	first := b.Terminals.Execute(id, tid, "user", "cd /tmp", "")
	b.Terminals.Wait(context.Background(), id, tid, stringOf(first["id"]))
	if b.Store.Terminal(id, tid)["cwd"] != "/tmp" {
		t.Fatal("completion published before cwd update")
	}
	b.Store.update(func() any {
		for i := 0; i < 26; i++ {
			b.Store.exec("INSERT INTO terminalEntries(id,terminalId,actor,command,output,createdAt,status,generation,cwd) VALUES(?,?,?,?,?,?,?,?,?)", ident(), tid, "user", "printf fixture", strings.Repeat("中", 13000), now(), "unknown", term["generation"], "/tmp")
		}
		return nil
	})
	data := b.Store.TerminalContext(id, tid)
	entries := objects(data["commandBlocks"])
	if len(entries) != 24 {
		t.Fatal(len(entries))
	}
	if len([]rune(stringOf(entries[0]["output"]))) != 12000 {
		t.Fatal("unicode output bound")
	}
	other := b.Terminals.Open(context.Background(), id, ref)
	otherID := stringOf(other["id"])
	otherDir := t.TempDir()
	otherEntry := b.Terminals.Execute(id, otherID, "user", "cd "+quote(otherDir), "")
	b.Terminals.Wait(context.Background(), id, otherID, stringOf(otherEntry["id"]))
	contextText := b.terminalContext(id, tid)
	if !strings.Contains(contextText, "current_cwd: /tmp") || strings.Contains(contextText, otherDir) || len(contextText) > 2<<20 {
		t.Fatal("context isolation or budget")
	}
	entry := b.Terminals.Execute(id, tid, "user", "sleep 0.2", "")
	data = b.Store.TerminalContext(id, tid)
	if objects(data["commandBlocks"])[23]["status"] != "running" {
		t.Fatal("running block omitted")
	}
	b.Terminals.Wait(context.Background(), id, tid, stringOf(entry["id"]))
}

func TestMaximumUnicodeUserMessageReachesModelWithoutDroppingContext(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	var seen atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data Object
		if json.NewDecoder(r.Body).Decode(&data) != nil {
			t.Error("invalid request")
			return
		}
		messages := objects(data["messages"])
		last := stringOf(messages[len(messages)-1]["content"])
		seen.Store(strings.Contains(last, "LAKE_SESSION_CONTEXT") && strings.Contains(last, strings.Repeat("中", 100000)))
		emitModel(w, "done", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "unicode fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"profile": "terminal2", "contextWindow": 2000000}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": strings.Repeat("中", 100000)}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if !seen.Load() {
		t.Fatal("maximum Unicode message or separate context lost")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": strings.Repeat("中", 100001)}, 400)
}
