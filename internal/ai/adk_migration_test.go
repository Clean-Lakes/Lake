package ai

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"google.golang.org/adk/v2/model"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/genai"
)

func TestADKImportsSpikeHistoryWithoutReplayingPendingEffects(t *testing.T) {
	target := filepath.Join(t.TempDir(), "must-not-exist")
	m, close := fakeModel(t, func(_ int, body map[string]any) any {
		userCount := 0
		for _, value := range arr(body["messages"]) {
			message := obj(value)
			if message["role"] == "user" && message["content"] == "earlier verified constraint" {
				userCount++
			}
		}
		if userCount != 1 || !strings.Contains(js(body["messages"]), "never replayed") {
			t.Error("legacy context missing, duplicated or treated as an execution request")
		}
		return response("continued from preserved records")
	})
	defer close()
	e := engineFor(t, m, nil)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := store.Sessions.Create(context.Background(), &adksession.CreateRequest{AppName: "lake-adk-spike", UserID: "lake", SessionID: "case"})
	if err != nil {
		t.Fatal(err)
	}
	messages := []*genai.Content{{Role: "user", Parts: []*genai.Part{{Text: "earlier verified constraint"}}}, {Role: "model", Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "legacy-pending", Name: "append", Args: map[string]any{"path": target, "content": "never execute"}}}}}}
	for _, content := range messages {
		author := "user"
		if content.Role == "model" {
			author = "lake_sre_agent"
		}
		if err = store.Sessions.AppendEvent(context.Background(), legacy.Session, &adksession.Event{ID: uid(), Timestamp: time.Now(), InvocationID: "legacy", Author: author, LLMResponse: model.LLMResponse{Content: content}}); err != nil {
			t.Fatal(err)
		}
	}
	if err = e.Chat(context.Background(), "case", "continue reviewing the recorded facts", nil); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "continue again", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("import replayed a pending side effect")
	}
	backup := filepath.Join(e.runtimeDirectory(), "migrations", "before-native-v1.sqlite")
	info, err := os.Stat(backup)
	if err != nil {
		t.Fatal("missing consistent migration backup", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		t.Fatal("migration snapshot is not private")
	}
	restored := filepath.Join(t.TempDir(), "restored.sqlite")
	data, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(restored, data, 0600); err != nil {
		t.Fatal(err)
	}
	restoredStore, err := storage.Open(restored)
	if err != nil {
		t.Fatal(err)
	}
	defer restoredStore.Close()
	original, err := restoredStore.Sessions.Get(context.Background(), &adksession.GetRequest{AppName: "lake-adk-spike", UserID: "lake", SessionID: "case"})
	if err != nil || original.Session.Events().Len() != 2 {
		t.Fatal("backup lost the original SDK history", err)
	}
	exports, err := filepath.Glob(filepath.Join(e.runtimeDirectory(), "migrations", "case-*.json"))
	if err != nil || len(exports) != 1 {
		t.Fatal("source history backup missing", exports, err)
	}
}

type failImportSession struct {
	adksession.Service
	remaining int
}

func (s *failImportSession) AppendEvent(ctx context.Context, session adksession.Session, event *adksession.Event) error {
	s.remaining--
	if s.remaining == 0 {
		return errors.New("injected import failure")
	}
	return s.Service.AppendEvent(ctx, session, event)
}

func TestADKInterruptedHistoryImportIsRetryableAndNeverActivatesPartialHistory(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.View.RootTurnID = "fixed-import-turn"
	s.state.History = []Message{{Role: "system", Content: "keep all constraints"}, {Role: "user", Content: "prior constraint"}, {Role: "assistant", Content: "prior answer"}, {Role: "user", Content: "current user request"}}
	s.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	before := js(s.state.History)
	_, _, err = e.prepareADKHistory(context.Background(), s, &failImportSession{Service: store.Sessions, remaining: 2}, "lake_chat")
	if err == nil || s.state.Runtime != nil || js(s.state.History) != before {
		t.Fatal("partial import became active or damaged source", err)
	}
	id, _, err := e.prepareADKHistory(context.Background(), s, store.Sessions, "lake_chat")
	if err != nil || id == "" || s.state.Runtime == nil {
		t.Fatal("interrupted import could not resume", err)
	}
	again, _, err := e.prepareADKHistory(context.Background(), s, store.Sessions, "lake_chat")
	if err != nil || again != id {
		t.Fatal("completed import was not idempotent", again, id, err)
	}
}
