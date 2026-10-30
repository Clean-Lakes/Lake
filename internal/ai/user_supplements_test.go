package ai

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUserSupplementDuringCompactionKeepsTurnAndCanonicalReceipt(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	var replies atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		if body["tools"] == nil {
			once.Do(func() { entered <- struct{}{}; <-release })
			return response("已整理历史证据，继续原任务。")
		}
		replies.Add(1)
		if !strings.Contains(js(body["messages"]), "压缩时补充：不要发布，只核对原任务") {
			t.Error("actual user input lost across compaction")
		}
		return response("收到补充，继续只读核对。")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	var pending []UserSupplement
	var mu sync.Mutex
	e.SetSupplementHooks(func(_, root string) ([]UserSupplement, error) {
		mu.Lock()
		defer mu.Unlock()
		return append([]UserSupplement{}, pending...), nil
	}, func(_, root string, ids []string) error { return nil })
	s.mu.Lock()
	s.state.History = []Message{{Role: "system", Content: Prompt(s.state.Config)}, {Role: "user", Content: strings.Repeat("earlier user constraints ", 800)}, {Role: "assistant", Content: strings.Repeat("historical result ", 1400)}, {Role: "user", Content: "核对之前结果"}, {Role: "assistant", Content: strings.Repeat("already known ", 2000)}}
	s.state.LastRequest = &Usage{InputKnown: true, Input: s.state.Config.Model.ContextWindow - s.state.Config.Model.MaxOutput}
	s.state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(s.state.Config.Model), HistoryCost: historyCost(s.state.History), ToolsCost: len(js(e.sessionCatalog(context.Background(), "case", s.state.Config)))}
	s.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "继续现有任务", nil) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("summary did not start")
	}
	original, _ := e.Snapshot("case")
	if err := e.AdmitSupplement("case", func(root string) error {
		if root != original.RootTurnID {
			t.Fatal("turn changed")
		}
		mu.Lock()
		pending = []UserSupplement{{ID: "actual-human-extra", Input: TurnInput{UserText: "压缩时补充：不要发布，只核对原任务"}}}
		mu.Unlock()
		return nil
	}); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("supplement blocked turn")
	}
	final, _ := e.Snapshot("case")
	if final.RootTurnID != original.RootTurnID || replies.Load() != 1 {
		t.Fatal("supplement restarted or repeated model", replies.Load())
	}
	dir := e.Dir
	e.Shutdown()
	if err := os.Remove(filepath.Join(dir, "case.json")); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Shutdown()
	delivered := 0
	reopened.SetSupplementHooks(nil, func(id, root string, ids []string) error {
		if id != "case" || root != original.RootTurnID || len(ids) != 1 || ids[0] != "actual-human-extra" {
			t.Error("canonical receipt changed")
		}
		delivered++
		return nil
	})
	if err = reopened.ReconcileUserSupplements(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	if delivered != 1 {
		t.Fatal("lost receipt when JSON cache was absent", delivered)
	}
	if err = reopened.AdmitSupplement("case", func(string) error { t.Fatal("idle input admitted"); return nil }); err == nil {
		t.Fatal("idle admission allowed")
	}
}

func TestUserSupplementDuringToolStopsLaterObsoleteCalls(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	var pending []UserSupplement
	target := filepath.Join(t.TempDir(), "obsolete-write")
	var requests atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		if requests.Add(1) == 1 {
			return response("", Call{ID: "in-flight", Name: "shell", Arguments: `{"command":"fixture-read","runtime":"local"}`}, Call{ID: "later-write", Name: "write", Arguments: js(map[string]any{"path": target, "content": "obsolete", "runtime": "local"})})
		}
		if !strings.Contains(js(body["messages"]), "取消后面的写入，继续只读") {
			t.Error("supplement missing before next model")
		}
		return response("保留已完成读取，不执行后续写入。")
	})
	defer closeModel()
	e := engineFor(t, m, func(ctx context.Context, _ string, name string, _ map[string]any, _ bool) (any, error) {
		if name == "policy" {
			return map[string]any{}, nil
		}
		if name == "runtimeCommandExec" {
			entered <- struct{}{}
			select {
			case <-release:
				return map[string]any{"exitCode": 0, "stdout": "completed original read"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		t.Errorf("unexpected bridge operation %s", name)
		return nil, nil
	})
	e.SetSupplementHooks(func(_, _ string) ([]UserSupplement, error) {
		mu.Lock()
		defer mu.Unlock()
		return append([]UserSupplement{}, pending...), nil
	}, func(_, _ string, _ []string) error { mu.Lock(); pending = nil; mu.Unlock(); return nil })
	s, _ := e.get("case")
	s.mu.Lock()
	p := DefaultPermissions()
	p.SilentCommands = true
	p.SilentWriteFiles = true
	s.state.Config.Permissions = &p
	s.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- e.Chat(context.Background(), "case", "先读取然后写入", nil) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("first tool did not begin")
	}
	before, _ := e.Snapshot("case")
	if err := e.AdmitSupplement("case", func(string) error {
		mu.Lock()
		pending = []UserSupplement{{ID: "real-mid-tool", Input: TurnInput{UserText: "取消后面的写入，继续只读"}}}
		mu.Unlock()
		return nil
	}); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("supplement did not continue")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("obsolete later write ran")
	}
	after, _ := e.Snapshot("case")
	if before.RootTurnID != after.RootTurnID || requests.Load() != 2 {
		t.Fatal("root changed or model duplicated", requests.Load())
	}
	h, _ := e.History("case")
	if err := validHistory(h); err != nil {
		t.Fatal(err)
	}
}

func TestSupersededProposalCannotProveWorkCompletedOrFailed(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.History = []Message{{Role: "tool", CallID: "superseded", Name: "write", Content: `{"outcome":"not_executed","notice":"superseded by real user input before dispatch"}`}}
	s.mu.Unlock()
	for _, state := range []string{"completed", "failed"} {
		if e.workEvidence(s, "superseded", state) {
			t.Fatal("a proposal without execution became evidence of an outcome", state)
		}
	}
}
