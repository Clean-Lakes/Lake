package ai

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"google.golang.org/adk/v2/artifact"
	"google.golang.org/adk/v2/memory"
	"google.golang.org/genai"
)

func TestADKArtifactsPersistVersionsRedactAndEnforceSessionScope(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	a := &nativeArtifacts{engine: e, sessionID: "runtime-case", config: Config{Model: Model{Key: "synthetic-sensitive-value"}}}
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := a.Save(context.Background(), &artifact.SaveRequest{AppName: "lake", UserID: "lake", SessionID: "runtime-case", FileName: "report.txt", Part: &genai.Part{Text: "evidence synthetic-sensitive-value"}, CustomMetadata: map[string]any{"count": 7, "secret": "synthetic-sensitive-value"}})
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	versions, err := a.Versions(context.Background(), &artifact.VersionsRequest{AppName: "lake", UserID: "lake", SessionID: "runtime-case", FileName: "report.txt"})
	if err != nil || len(versions.Versions) != 6 {
		t.Fatal("lost concurrent artifact version", versions, err)
	}
	first, err := a.Load(context.Background(), &artifact.LoadRequest{AppName: "lake", UserID: "lake", SessionID: "runtime-case", FileName: "report.txt", Version: 1})
	if err != nil || strings.Contains(first.Part.Text, "synthetic-sensitive-value") {
		t.Fatal("artifact did not redact credentials", err)
	}
	metadata, err := a.GetArtifactVersion(context.Background(), &artifact.GetArtifactVersionRequest{AppName: "lake", UserID: "lake", SessionID: "runtime-case", FileName: "report.txt", Version: 1})
	if err != nil || metadata.ArtifactVersion.CustomMetadata["count"] != "7" {
		t.Fatal("artifact metadata missing", err)
	}
	if _, err = a.Load(context.Background(), &artifact.LoadRequest{AppName: "lake", UserID: "lake", SessionID: "other", FileName: "report.txt"}); err == nil {
		t.Fatal("foreign artifact exposed")
	}
	if _, err = a.Save(context.Background(), &artifact.SaveRequest{AppName: "lake", UserID: "lake", SessionID: "runtime-case", FileName: "../outside", Part: &genai.Part{Text: "blocked"}}); err == nil {
		t.Fatal("artifact path traversal accepted")
	}
	e.Shutdown()
	restarted, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Shutdown()
	a.engine = restarted
	result, err := a.Load(context.Background(), &artifact.LoadRequest{AppName: "lake", UserID: "lake", SessionID: "runtime-case", FileName: "report.txt", Version: 1})
	if err != nil || result.Part.Text != first.Part.Text {
		t.Fatal("artifact lost after restart", err)
	}
}

func TestADKMemoryUsesCurrentProjectAndRejectsRevokedAccess(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(_ context.Context, id, name string, args map[string]any, _ bool) (any, error) {
		if id != "case" || name != "list_project_memories" || str(args["query"]) != "deployment" {
			t.Error("memory escaped its bound project/session")
		}
		return map[string]any{"items": []any{map[string]any{"key": "deployment", "description": "historical deployment"}}}, nil
	})
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config.MemoryEnabled = true
	s.state.Config.MemoryProjectID = "project"
	c := s.state.Config
	s.mu.Unlock()
	service := &nativeMemory{engine: e, session: s, config: c, runtimeID: "native"}
	result, err := service.SearchMemory(context.Background(), &memory.SearchRequest{AppName: "lake", UserID: "lake", Query: "deployment"})
	if err != nil || len(result.Memories) != 1 || !strings.Contains(result.Memories[0].Content.Parts[0].Text, "historical deployment") {
		t.Fatal("project memory not connected", err)
	}
	if _, err = service.SearchMemory(context.Background(), &memory.SearchRequest{AppName: "lake", UserID: "other", Query: "deployment"}); err == nil {
		t.Fatal("foreign user memory exposed")
	}
	s.mu.Lock()
	s.state.Config.MemoryEnabled = false
	s.mu.Unlock()
	if _, err = service.SearchMemory(context.Background(), &memory.SearchRequest{AppName: "lake", UserID: "lake", Query: "deployment"}); err == nil {
		t.Fatal("revoked memory remained accessible")
	}
}

func TestADKFailedAuditWritePreventsActualFileMutation(t *testing.T) {
	target := filepath.Join(t.TempDir(), "effect")
	m, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "audit-denial", Name: "write", Arguments: js(map[string]any{"path": target, "content": "must not execute"})})
		}
		return response("audit failure; no operation executed")
	})
	defer close()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.Permissions = &Permissions{SilentWriteFiles: true, SilentReadFiles: true}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(e.runtimeDirectory(), "case"), []byte("blocks evidence directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = e.Chat(context.Background(), "case", "write the fixture", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("audit failure did not prevent mutation")
	}
	var count int64
	if err = store.DB.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("failed audit transaction was not rolled back", count, err)
	}
}
