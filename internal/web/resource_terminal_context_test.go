package web

import (
	"context"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestResourceTerminalDoesNotCreateChat(t *testing.T) {
	b, h := fixture(t)
	project := apiTest(t, h, "POST", "/api/projects", Object{"name": "Terminal only"}, 201)
	catalog := b.Store.Catalog()
	resources := objects(catalog["resources"])
	ref := stringOf(resources[0]["id"])
	if len(objects(catalog["sessions"])) != 0 {
		t.Fatal("fixture should start without chats")
	}
	scope := apiTest(t, h, "POST", "/api/resources/"+ref+"/terminal-context", Object{}, 200)
	sid := stringOf(scope["sessionId"])
	if sid == "" {
		t.Fatal("missing terminal runtime context")
	}
	again := apiTest(t, h, "POST", "/api/resources/"+ref+"/terminal-context", Object{}, 200)
	if again["sessionId"] != sid {
		t.Fatal("runtime context was not reused")
	}
	if len(objects(b.Store.Catalog()["sessions"])) != 0 {
		t.Fatal("opening a resource created a chat")
	}
	term := apiTest(t, h, "POST", "/api/sessions/"+sid+"/terminals", Object{"resourceId": ref, "interactive": true, "shell": "bash"}, 201)
	tid := stringOf(term["id"])
	deadline := time.Now().Add(5 * time.Second)
	for b.Store.Terminal(sid, tid)["status"] != "ready" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if b.Store.Terminal(sid, tid)["status"] != "ready" {
		t.Fatal("terminal not ready")
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/terminals/"+tid+"/input", Object{"data": "printf '__RESOURCE_TERM_OK__\\n'\r"}, 202)
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		hist := b.Store.History(sid, tid)
		if strings.Contains(stringOf(hist["output"]), "__RESOURCE_TERM_OK__\r\n") && b.Store.Terminal(sid, tid)["status"] == "ready" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(stringOf(b.Store.History(sid, tid)["output"]), "__RESOURCE_TERM_OK__\r\n") {
		t.Fatal("standalone terminal command did not produce output")
	}
	apiTest(t, h, "GET", "/api/sessions/"+sid+"/snapshot", nil, 200)
	if len(objects(b.Store.Catalog()["sessions"])) != 0 {
		t.Fatal("terminal input or snapshot created a chat")
	}
	apiTest(t, h, "DELETE", "/api/resources/"+ref+"/terminals/"+tid, nil, 200)
	// Explicit chat creation continues to work and is unaffected by the shell.
	chat := apiTest(t, h, "POST", "/api/projects/"+stringOf(project["id"])+"/sessions", Object{}, 201)
	before := objects(b.Store.Catalog()["sessions"])
	b.Store.ResourceTerminalSession(ref)
	after := objects(b.Store.Catalog()["sessions"])
	if !reflect.DeepEqual(before, after) || len(after) != 1 || after[0]["id"] != chat["id"] {
		t.Fatal("terminal access changed the chat list")
	}
}

func TestResourceTerminalScopeConcurrentAndProjectIsolation(t *testing.T) {
	b, h := fixture(t)
	_, ref := newSession(t, h)
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); ids <- stringOf(b.Store.ResourceTerminalSession(ref)["id"]) }()
	}
	wg.Wait()
	close(ids)
	sid := ""
	for id := range ids {
		if sid == "" {
			sid = id
		}
		if sid != id {
			t.Fatal("concurrent opening created multiple runtime contexts")
		}
	}
	_, other := newSession(t, h)
	otherScope := b.Store.ResourceTerminalSession(other)
	if otherScope["id"] == sid {
		t.Fatal("resource runtime scope crossed projects")
	}
	expectPanic(t, 404, func() { b.Terminals.OpenInteractive(context.Background(), sid, other, "bash") })
	if len(objects(b.Store.Catalog()["sessions"])) != 2 {
		t.Fatal("runtime scope leaked into chats")
	}
	apiTest(t, h, "POST", "/api/resources/missing/terminal-context", Object{}, 404)
}

func TestCatalogKeepsRealChatsAndOmitsEmptyTerminalAIScopes(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), owner, ref)
	scope := b.Store.ResolveTerminalAISession(owner, stringOf(term["id"]))
	if len(objects(b.Store.Catalog()["sessions"])) != 1 {
		t.Fatal("empty automatic terminal AI scope appeared in chat list")
	}
	// A user conversation in the old AI scope remains visible and intact.
	b.Store.Begin(stringOf(scope["id"]), "hello", nil, "hello")
	if len(objects(b.Store.Catalog()["sessions"])) != 2 {
		t.Fatal("meaningful terminal AI chat was hidden")
	}
}

func TestResourceTerminalListIncludesMultipleOwnersAndExcludesDisconnected(t *testing.T) {
	b, h := fixture(t)
	chat, ref := newSession(t, h)
	owner := stringOf(b.Store.ResourceTerminalSession(ref)["id"])
	one := b.Terminals.OpenInteractive(context.Background(), chat, ref, "bash")
	two := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	three := b.Terminals.OpenInteractive(context.Background(), owner, ref, "bash")
	managed := b.Terminals.Open(context.Background(), chat, ref)
	list := objects(apiTest(t, h, "GET", "/api/resources/"+ref+"/terminals", nil, 200)["terminals"])
	if len(list) != 3 {
		t.Fatal("same resource's live terminals were not combined")
	}
	found := map[string]bool{}
	for _, term := range list {
		if term["id"] == managed["id"] || term["interactive"] != true || term["generation"] == nil {
			t.Fatal("resource list lacks interactive selection metadata")
		}
		found[stringOf(term["id"])] = true
	}
	for _, term := range []Object{one, two, three} {
		if !found[stringOf(term["id"])] {
			t.Fatal("live connection missing")
		}
	}
	b.Terminals.Close(owner, stringOf(two["id"]))
	list = objects(apiTest(t, h, "GET", "/api/resources/"+ref+"/terminals", nil, 200)["terminals"])
	if len(list) != 2 {
		t.Fatal("disconnected terminal remained in list")
	}
	for _, term := range list {
		if term["id"] == two["id"] || term["status"] == "disconnected" {
			t.Fatal("closed connection remained selectable")
		}
	}
	if len(objects(b.Store.Catalog()["sessions"])) != 1 {
		t.Fatal("multiple shells created extra chats")
	}
	apiTest(t, h, "GET", "/api/resources/missing/terminals", nil, 404)
}
