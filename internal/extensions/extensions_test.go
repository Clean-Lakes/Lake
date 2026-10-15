package extensions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoInput struct {
	Text string `json:"text"`
}

func testServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "Lake fixture", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "echo", Description: "Echo fixture text"}, func(ctx context.Context, r *mcp.CallToolRequest, in echoInput) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: in.Text + " " + os.Getenv("LAKE_FIXTURE_VALUE")}}}, nil, nil
	})
	return server
}
func TestMCPStdioHelper(t *testing.T) {
	if os.Getenv("LAKE_MCP_TEST_HELPER") != "1" {
		return
	}
	_ = testServer().Run(context.Background(), &mcp.StdioTransport{})
	os.Exit(0)
}
func TestMCPConnectionsAndPrivateConfiguration(t *testing.T) {
	for _, transport := range []string{"http", "sse", "stdio"} {
		t.Run(transport, func(t *testing.T) {
			store := NewStore(t.TempDir())
			manager := NewManager(store)
			defer manager.Close()
			server := Server{ID: "fixture", Name: "Fixture", Transport: transport, Enabled: true, Args: []string{}}
			var hits atomic.Int32
			if transport != "stdio" {
				var handler http.Handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return testServer() }, nil)
				if transport == "sse" {
					handler = mcp.NewSSEHandler(func(*http.Request) *mcp.Server { return testServer() }, nil)
				}
				httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hits.Add(1)
					if r.Header.Get("Authorization") != "Bearer synthetic-extension-credential" {
						t.Error("missing configured auth header")
					}
					handler.ServeHTTP(w, r)
				}))
				defer httpServer.Close()
				server.URL = httpServer.URL
				server.Headers = map[string]string{"Authorization": "Bearer synthetic-extension-credential"}
			} else {
				server.Command = os.Args[0]
				server.Args = []string{"-test.run=^TestMCPStdioHelper$"}
				server.Env = map[string]string{"LAKE_MCP_TEST_HELPER": "1", "LAKE_FIXTURE_VALUE": "synthetic-extension-credential"}
			}
			if err := store.SaveServer(server, true, true); err != nil {
				t.Fatal(err)
			}
			st, err := os.Stat(store.Path())
			if err != nil || !platform.Private(store.Path(), st) {
				t.Fatal("configuration must be private")
			}
			public, _ := json.Marshal(PublicServer(server))
			if strings.Contains(string(public), "synthetic-extension-credential") {
				t.Fatal("public metadata leaked a credential")
			}
			if hits.Load() != 0 {
				t.Fatal("saving must not connect")
			}
			ctx, cancel := context.WithCancel(context.Background())
			list, err := manager.Tools(ctx, server.ID, false)
			cancel()
			if err != nil || list.(map[string]any)["count"] != 1 {
				t.Fatalf("tool discovery failed: %v", err)
			}
			value, err := manager.Call(context.Background(), server.ID, "echo", map[string]any{"text": "synthetic-extension-credential"})
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(value)
			if !strings.Contains(string(raw), "[REDACTED]") || strings.Contains(string(raw), "synthetic-extension-credential") {
				t.Fatal("MCP output leaked configured secret")
			}
			server.Enabled = false
			if err := store.SaveServer(server, false, false); err != nil {
				t.Fatal(err)
			}
			if _, err := manager.Call(context.Background(), server.ID, "echo", map[string]any{"text": "should not call"}); err == nil {
				t.Fatal("disabled server remained callable")
			}
			saved, _ := store.FindServer(server.ID)
			if transport != "stdio" && len(saved.Headers) != 1 || transport == "stdio" && len(saved.Env) != 2 {
				t.Fatal("blank credentials did not preserve saved values")
			}
			if err := store.DeleteServer(server.ID); err != nil {
				t.Fatal(err)
			}
			manager.Invalidate(server.ID)
		})
	}
}
func TestSkillsRootsEnablementAndSymlinkIsolation(t *testing.T) {
	home := t.TempDir()
	store := NewStore(home)
	if err := store.SaveSkill("service-check", "---\nname: service-check\ndescription: 检查服务\n---\nRead logs", true); err != nil {
		t.Fatal(err)
	}
	other := t.TempDir()
	if err := os.MkdirAll(filepath.Join(other, "imported"), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(other, "imported", "SKILL.md"), []byte("Imported procedure"), 0600)
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "SKILL.md"), []byte("Escape"), 0600)
	os.Symlink(outside, filepath.Join(other, "escape"))
	if err := store.AddSkillRoot(other); err != nil {
		t.Fatal(err)
	}
	skills, err := store.ScanSkills("")
	if err != nil || len(skills) != 2 {
		t.Fatal("skill scan did not retain managed/imported separation")
	}
	if err := store.SaveSkill("imported", "overwrite external file", false); err == nil {
		t.Fatal("imported files must remain read-only")
	}
	if err := store.SaveSkill("../escape", "unsafe", true); err == nil {
		t.Fatal("traversal accepted")
	}
	if err := store.SetSkillEnabled("service-check", false); err != nil {
		t.Fatal(err)
	}
	meta, _, err := NewStore(home).ReadSkill("service-check", "")
	if err != nil || meta.Enabled {
		t.Fatal("disabled state did not persist")
	}
	if err := store.RemoveSkillRoot(other); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(other, "imported", "SKILL.md")); err != nil {
		t.Fatal("removing a root modified source files")
	}
	if err := store.AddSkillRoot(filepath.Join(home, "secrets")); err == nil {
		t.Fatal("credential directory accepted as skill root")
	}
}

func TestSkillCreationRejectsLinkedRootWithoutWritingOutside(t *testing.T) {
	home, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(home, "skills")); err != nil {
		t.Skip("symlinks unavailable")
	}
	if err := NewStore(home).SaveSkill("outside-write", "must not write", true); err == nil {
		t.Fatal("linked skill root accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "outside-write")); !os.IsNotExist(err) {
		t.Fatal("rejected skill created files outside its home")
	}
}
