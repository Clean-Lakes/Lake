package ai

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
)

func recallFixture(t *testing.T) (*Engine, *session, Config) {
	t.Helper()
	e := engineFor(t, Model{URL: "http://127.0.0.1:1/v1/chat/completions", Protocol: "openai", Name: "fixture", ContextWindow: 32000, MaxOutput: 1024}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	return e, s, c
}
func TestNaturalRecallActualRequestDoesNotPersistBodyOrGrantAuthority(t *testing.T) {
	const body = "以后这个项目的回复固定先列结论。"
	var e *Engine
	m, done := fakeModel(t, func(_ int, r map[string]any) any {
		sys := str(obj(arr(r["messages"])[0])["content"])
		if !strings.Contains(sys, body) || !strings.Contains(sys, "current explicit user requirements") || !strings.Contains(sys, readPrompt("identity-and-permissions")) {
			t.Error("missing live preference or fixed boundary")
		}
		manifest := readPromptManifest(t, e, "case")
		if !hasPromptSource(manifest, "natural-memory-preferences") {
			t.Error("missing prepared diagnostic")
		}
		return response("done")
	})
	defer done()
	e = engineFor(t, m, nil)
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		return []NaturalRecallItem{{ID: "pref", Revision: 2, Scope: "project", Topic: "report-order", Body: body, Hash: hash(body)}}, nil
	}
	if err := e.Chat(context.Background(), "case", "这次按英文一句话回答。", nil); err != nil {
		t.Fatal(err)
	}
	h, _ := e.History("case")
	if strings.Contains(h[0].Content, body) {
		t.Fatal("body copied into durable system")
	}
	session, _ := e.get("case")
	state := session.state
	if len(state.NaturalRecallUsed) != 1 || state.NaturalRecallUsed[0].Body != "" {
		t.Fatal("reference persistence", state.NaturalRecallUsed)
	}
	view, _ := e.Snapshot("case")
	if len(view.MemoryAccess) != 1 || view.MemoryAccess[0].Kind != "prepared" {
		t.Fatal(view.MemoryAccess)
	}
}
func TestNaturalRecallRevocationBeforeToolPreventsSideEffects(t *testing.T) {
	var revoked atomic.Bool
	var requests atomic.Int32
	m, done := fakeModel(t, func(_ int, _ map[string]any) any {
		requests.Add(1)
		revoked.Store(true)
		return response("", Call{ID: "stale", Name: "todo_write", Arguments: `{"todos":[{"content":"must not execute","status":"pending"}]}`})
	})
	defer done()
	e := engineFor(t, m, nil)
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		if revoked.Load() {
			return nil, errors.New("withdrawn")
		}
		return []NaturalRecallItem{{ID: "pref", Revision: 1, Body: "以后这个项目固定用中文。", Hash: "h"}}, nil
	}
	if err := e.Chat(context.Background(), "case", "Inspect.", nil); err == nil {
		t.Fatal("revoked preference continued")
	}
	view, _ := e.Snapshot("case")
	if len(view.Todos) != 0 || requests.Load() != 1 {
		t.Fatal("tool executed or request retried")
	}
}
func TestNaturalRecallOptionalFailureBudgetAndIsolatedEntrypoints(t *testing.T) {
	e, s, c := recallFixture(t)
	var count atomic.Int32
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		count.Add(1)
		return nil, errors.New("offline")
	}
	original := []Message{{Role: "system", Content: Prompt(c)}}
	if h, text, err := e.naturalRecallRequest(context.Background(), s, c, original, nil); err != nil || text != "" || h[0].Content != original[0].Content {
		t.Fatal("optional unavailable service changed task")
	}
	for _, mode := range []string{"ignore", "workflow", "role"} {
		cc := c
		switch mode {
		case "ignore":
			cc.IgnoreNaturalMemory = true
		case "workflow":
			cc.workflowMode = true
		case "role":
			cc.agentRole = "investigator"
		}
		before := count.Load()
		if _, text, err := e.naturalRecallRequest(context.Background(), s, cc, original, nil); err != nil || text != "" || count.Load() != before {
			t.Fatal(mode, err)
		}
		for _, tool := range e.sessionCatalog(context.Background(), "case", cc) {
			if naturalRecallTool(tool.Name) {
				t.Fatal("isolated catalog inherited recall", mode)
			}
		}
	}
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		return []NaturalRecallItem{{ID: "p", Revision: 1, Body: strings.Repeat("偏好", 500), Hash: "h"}}, nil
	}
	c.Model.ContextWindow = 1
	if _, text, err := e.naturalRecallRequest(context.Background(), s, c, original, nil); err != nil || text != "" {
		t.Fatal("input budget", err)
	}
	c.Model.ContextWindow = 32000
	c.sreCoordinator = true
	if _, text, err := e.naturalRecallRequest(context.Background(), s, c, original, nil); err != nil || text == "" || len(text) > 4096 {
		t.Fatal("coordinator recall", err)
	}
}
func TestNaturalRecallReadReceiptIsBodyFreeAndRevalidated(t *testing.T) {
	e, s, c := recallFixture(t)
	body := strings.Repeat("长偏好", 200)
	e.NaturalMemory = func(_ context.Context, _ string, q NaturalRecallQuery) ([]NaturalRecallItem, error) {
		if q.ID != "p" && q.ID != "" || q.ID != "" && q.Revision != 3 {
			return nil, errors.New("revision conflict")
		}
		return []NaturalRecallItem{{ID: "p", Revision: 3, Body: body, Hash: "h"}}, nil
	}
	s.state.View.RootTurnID = "turn"
	result, err := e.invokeNaturalRecall(context.Background(), s, c, Call{Name: "read_memory_preference", Arguments: `{"id":"p","expectedRevision":3}`})
	if err != nil || strings.Contains(js(result), body) {
		t.Fatal("durable result leaked body", err)
	}
	h := []Message{{Role: "system", Content: Prompt(c)}, {Role: "tool", HostTurnID: "turn", Name: "read_memory_preference", Content: js(result)}}
	current, _, err := e.naturalRecallRequest(context.Background(), s, c, h, nil)
	if err != nil || !strings.Contains(current[1].Content, body) {
		t.Fatal("requested body not delivered", err)
	}
	if strings.Contains(h[1].Content, body) {
		t.Fatal("ephemeral delivery mutated history")
	}
	s.state.NaturalRecallUsed = nil
	s.state.View.RootTurnID = "new"
	current, _, err = e.naturalRecallRequest(context.Background(), s, c, h, nil)
	if err != nil || strings.Contains(current[1].Content, body) {
		t.Fatal("old result survived into new turn", err)
	}
	_, err = e.invokeNaturalRecall(context.Background(), s, c, Call{Name: "read_memory_preference", Arguments: `{"id":"p","expectedRevision":2}`})
	if err == nil {
		t.Fatal("stale read accepted")
	}
}
func TestNaturalRecallProjectionAndDuplicateLegacyPreserveOneCopy(t *testing.T) {
	e, s, c := recallFixture(t)
	body := "以后这个项目的报告固定先列结论。"
	v := NaturalRecallItem{ID: "p", Revision: 1, Body: body, Hash: hash(body)}
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		return []NaturalRecallItem{v}, nil
	}
	h := []Message{{Role: "system", Content: Prompt(c) + body}}
	if _, text, err := e.naturalRecallRequest(context.Background(), s, c, h, nil); err != nil || text != "" {
		t.Fatal("duplicate legacy injection", err)
	}
	e.rememberNaturalUse(s, []NaturalRecallItem{v})
	s.state.Config.IgnoreNaturalMemory = true
	p := memoryProjection(s.state)
	var restored State
	if err := restoreMemoryProjection(&restored, p); err != nil {
		t.Fatal(err)
	}
	if len(restored.NaturalRecallUsed) != 1 || restored.NaturalRecallUsed[0].Body != "" || !restored.Config.IgnoreNaturalMemory {
		t.Fatal("lost recall guard")
	}
	p.RecallUsed[0].Body = "must not persist"
	if restoreMemoryProjection(&restored, p) == nil {
		t.Fatal("body-bearing guard accepted")
	}
}

func TestNaturalRecallOfficialReadDeliversEphemeralFullBody(t *testing.T) {
	body := strings.Repeat("以后这个项目报告固定先列结论。", 35)
	m, done := fakeModel(t, func(n int, r map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "read-pref", Name: "read_memory_preference", Arguments: `{"id":"pref","expectedRevision":1}`})
		}
		found := false
		for _, raw := range arr(r["messages"]) {
			m := obj(raw)
			if str(m["role"]) == "tool" && strings.Contains(str(m["content"]), body) {
				found = true
			}
		}
		if !found {
			t.Error("full body missing from real second provider request")
		}
		return response("done")
	})
	defer done()
	e := engineFor(t, m, nil)
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		return []NaturalRecallItem{{ID: "pref", Revision: 1, Scope: "project", Topic: "report-order", Body: body, Hash: hash(body)}}, nil
	}
	if err := e.Chat(context.Background(), "case", "Explain.", nil); err != nil {
		t.Fatal(err)
	}
	h, _ := e.History("case")
	for _, v := range h {
		if v.Role == "tool" && strings.Contains(v.Content, body) {
			t.Fatal("raw body persisted in receipt")
		}
	}
	s, _ := e.get("case")
	projection := memoryProjection(s.state)
	if strings.Contains(js(projection), body) {
		t.Fatal("body copied into canonical guard")
	}
}
