package ai

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestADKOfficialProjectionRestoresMissingHistoryCache(t *testing.T) {
	testNativeProjectionCache(t, false)
}
func TestADKOfficialProjectionRestoresMissingCacheFile(t *testing.T) {
	testNativeProjectionCache(t, true)
}
func testNativeProjectionCache(t *testing.T, missing bool) {
	m, close := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("remember PROJECTION_FACT")
		}
		if !strings.Contains(js(input["messages"]), "PROJECTION_FACT") {
			t.Error("canonical ADK history not restored")
		}
		return response("restored")
	})
	defer close()
	home := t.TempDir()
	e, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := Config{Model: m, Profile: "core"}
	if err = e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "remember this", nil); err != nil {
		t.Fatal(err)
	}
	e.Shutdown()
	raw, _ := os.ReadFile(filepath.Join(home, "case.json"))
	var state State
	_ = json.Unmarshal(raw, &state)
	state.History = nil
	state.View.Cards = nil
	raw, _ = json.Marshal(state)
	_ = os.WriteFile(filepath.Join(home, "case.json"), raw, 0600)
	if missing {
		if err = os.Remove(filepath.Join(home, "case.json")); err != nil {
			t.Fatal(err)
		}
	}
	restored, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Shutdown()
	if err = restored.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err = restored.Chat(context.Background(), "case", "what did you record?", nil); err != nil {
		t.Fatal(err)
	}
}

func TestADKSecretToolArgumentsNeverReachDispatchOrPersistentEvents(t *testing.T) {
	marker := "synthetic-model-key-not-a-real-secret"
	m, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "secret", Name: "write", Arguments: js(map[string]any{"path": "leak.txt", "content": marker})})
		}
		return response("blocked")
	})
	defer close()
	m.Key = marker
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.Permissions = &Permissions{SilentWriteFiles: true}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "case", "do not leak credentials", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(c.Workspace, "leak.txt")); !os.IsNotExist(err) {
		t.Fatal("credential-bearing operation executed")
	}
	store, _ := e.adkStore()
	var rows []struct{ Content string }
	if err := store.DB.Raw("SELECT content FROM events").Scan(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if strings.Contains(row.Content, marker) {
			t.Fatal("secret reached ADK event storage")
		}
	}
	var artifacts []nativeArtifact
	_ = store.DB.Find(&artifacts).Error
	for _, a := range artifacts {
		if strings.Contains(string(a.Part), marker) {
			t.Fatal("secret reached ADK artifact")
		}
	}
}

func TestADKClearSurvivesLossOfLocalContextCache(t *testing.T) {
	m, close := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("FORGOTTEN_FACT")
		}
		if strings.Contains(js(input["messages"]), "FORGOTTEN_FACT") {
			t.Error("cleared history resurrected from old SDK events")
		}
		return response("fresh")
	})
	defer close()
	home := t.TempDir()
	e, _ := New(home, nil, nil)
	c := Config{Model: m, Profile: "core"}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "case", "first", nil); err != nil {
		t.Fatal(err)
	}
	if err := e.Clear("case"); err != nil {
		t.Fatal(err)
	}
	e.Shutdown()
	if err := os.Remove(filepath.Join(home, "case.json")); err != nil {
		t.Fatal(err)
	}
	recovered, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Shutdown()
	if err = recovered.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	if err = recovered.Chat(context.Background(), "case", "fresh question", nil); err != nil {
		t.Fatal(err)
	}
}
