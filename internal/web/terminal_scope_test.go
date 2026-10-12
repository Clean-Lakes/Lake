package web

import (
	"context"
	"sync"
	"testing"
)

func TestTerminalScopeConcurrentRecoveryAndExplicitBinding(t *testing.T) {
	b, h := fixture(t)
	owner, ref := newSession(t, h)
	term := b.Terminals.Open(context.Background(), owner, ref)
	tid := stringOf(term["id"])
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); ids <- stringOf(b.Store.ResolveTerminalAISession(owner, tid)["id"]) }()
	}
	wg.Wait()
	close(ids)
	sid := ""
	for id := range ids {
		if sid == "" {
			sid = id
		}
		if id != sid {
			t.Fatal("scope duplicated")
		}
	}
	value := apiTest(t, h, "POST", "/api/sessions/"+owner+"/terminals/"+tid+"/ai-scope", Object{"generation": term["generation"]}, 200)
	if value["sessionId"] != sid || value["needsAdoption"] != true {
		t.Fatal(value)
	}
	apiTest(t, h, "GET", "/api/sessions/"+sid+"/terminals/"+tid+"/history", nil, 403)
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/terminals/"+tid+"/adopt", Object{"generation": term["generation"], "accept": true, "bind": true}, 200)
	apiTest(t, h, "GET", "/api/sessions/"+sid+"/terminals/"+tid+"/history", nil, 200)
	remembered, _ := b.Engine.ReferencedAssets(sid)
	if len(remembered) != 1 || remembered[0] != ref {
		t.Fatal("explicit adoption did not remember the approved resource", remembered)
	}
	if b.Store.Options(sid)["terminal_id"] != tid || b.Store.Options(sid)["profile"] != "terminal2" {
		t.Fatal("scope not bound")
	}
	next := b.Terminals.Open(context.Background(), owner, ref)
	if b.Store.ResolveTerminalAISession(owner, stringOf(next["id"]))["id"] != sid {
		t.Fatal("same resource lost history")
	}
	b.Store.DeleteSession(sid)
	if b.Store.ResolveTerminalAISession(owner, tid)["id"] == sid {
		t.Fatal("deleted scope restored")
	}
}
