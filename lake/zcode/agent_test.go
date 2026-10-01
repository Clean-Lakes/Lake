package zcode

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"github.com/cloudwego/eino/schema"
)

type fixtureSSH struct{ calls atomic.Int32 }

func (f *fixtureSSH) Run(_ context.Context, _ sshtransport.Target, _ []byte, command string) (sshtransport.Result, error) {
	if command != "hostname" {
		return sshtransport.Result{}, fmt.Errorf("unexpected command")
	}
	f.calls.Add(1)
	return sshtransport.Result{Stdout: "fixture-host\n", ExitCode: 0}, nil
}

type fixtureKeys struct{ calls atomic.Int32 }

func (f *fixtureKeys) Load(string) ([]byte, error) { f.calls.Add(1); return []byte("fixture-key"), nil }

type fixtureRead struct {
	service  *operate.Service
	resource store.Resource
}

func (f fixtureRead) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "lake_fixture_read", Desc: "One fixed hostname check via Lake approval", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{})}, nil
}
func (f fixtureRead) InvokableRun(ctx context.Context, _ string, _ ...tool.Option) (string, error) {
	r, err := f.service.RunReadForResource(ctx, f.resource, "hostname")
	value := map[string]any{"run_id": f.service.RunID, "stdout": r.Stdout, "status": "completed"}
	if err != nil {
		value["status"] = "failed"
		value["error"] = err.Error()
	}
	b, _ := json.Marshal(value)
	return string(b), nil
}

func sourceOptions(t *testing.T, root string) Options {
	t.Helper()
	if os.Getenv("LAKE_ZCODE_INTEGRATION") != "1" {
		t.Skip("Set LAKE_ZCODE_INTEGRATION=1 after building bin/zcode")
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(cwd, "..", "..", "bin", "zcode")
	if cli := os.Getenv("LAKE_ZCODE_CLI"); cli != "" {
		dir = filepath.Dir(cli)
	}
	node := filepath.Join(dir, "node")
	if override := os.Getenv("LAKE_ZCODE_NODE"); override != "" {
		node = override
	}
	return Options{Root: root, Model: "fixture-model", APIType: "openai_chat", APIKey: []byte("fixture-provider-key"), CLIPath: filepath.Join(dir, "zcode.cjs"), NodePath: node, BuiltinPath: filepath.Join(dir, "builtin.json")}
}

func fixtureChunk(w http.ResponseWriter, delta any, finish any) {
	value := map[string]any{"id": "fixture", "object": "chat.completion.chunk", "model": "fixture-model", "created": 1, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
	data, _ := json.Marshal(value)
	fmt.Fprintf(w, "data: %s\n\n", data)
}

func TestSourceAgentWithLakeApproval(t *testing.T) {
	for _, scenario := range []string{"approve", "decline", "revoke"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			root := t.TempDir()
			opts := sourceOptions(t, root)
			db, err := store.Open(ctx, root)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			lake, err := db.CreateLake(ctx, "fixture-lake", "")
			if err != nil {
				t.Fatal(err)
			}
			resource, err := db.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "fixture", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "fixture"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = db.SetCredentialRef(ctx, resource.ID, "file:ssh/00000000000000000000000000000001"); err != nil {
				t.Fatal(err)
			}
			if _, err = db.SetExecuteAuthz(ctx, resource.ID, true); err != nil {
				t.Fatal(err)
			}
			resource, err = db.GetResource(ctx, resource.ID)
			if err != nil {
				t.Fatal(err)
			}
			service, err := operate.NewServiceForLake(ctx, db, lake.Name)
			if err != nil {
				t.Fatal(err)
			}
			runner, keys := &fixtureSSH{}, &fixtureKeys{}
			service.Runner, service.Keys = runner, keys
			service.RequireReadApproval = true
			var approvals atomic.Int32
			service.Confirm = func(ctx context.Context, target, command string) (bool, error) {
				approvals.Add(1)
				if target != "fixture-lake/fixture" || command != "hostname" {
					t.Error("approval target or command changed")
				}
				if scenario == "revoke" {
					_, err := db.SetExecuteAuthz(ctx, resource.ID, false)
					return true, err
				}
				return scenario == "approve", nil
			}
			opts.Tools = []tool.BaseTool{fixtureRead{service: service, resource: resource}}
			var requests atomic.Int32
			model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-provider-key" {
					t.Error("provider proxy route/auth failed")
				}
				var request struct {
					Tools []struct {
						Function struct {
							Name string `json:"name"`
						} `json:"function"`
					} `json:"tools"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
				}
				if len(request.Tools) != 1 || request.Tools[0].Function.Name != "mcp__lake__lake_fixture_read" {
					t.Errorf("unexpected visible tools: %d", len(request.Tools))
				}
				for _, path := range []string{"builtin.json", "personal.json"} {
					files, _ := filepath.Glob(filepath.Join(root, ".zcode-turn-*", path))
					for _, file := range files {
						body, _ := os.ReadFile(file)
						if strings.Contains(string(body), "fixture-provider-key") {
							t.Error("provider key reached Node config")
						}
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				if requests.Add(1) == 1 {
					fixtureChunk(w, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call_fixture", "type": "function", "function": map[string]string{"name": "mcp__lake__lake_fixture_read", "arguments": "{}"}}}}, nil)
					fixtureChunk(w, map[string]any{}, "tool_calls")
				} else {
					fixtureChunk(w, map[string]any{"role": "assistant", "content": "fixture done"}, nil)
					fixtureChunk(w, map[string]any{}, "stop")
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer model.Close()
			opts.BaseURL = model.URL + "/v1"
			agent, err := New(opts)
			if err != nil {
				t.Fatal(err)
			}
			iter := agent.Run(ctx, &adk.AgentInput{Messages: []*schema.Message{schema.UserMessage("Run one hostname check")}})
			var proposalID, resultID, toolOutput, answer string
			for {
				event, ok := iter.Next()
				if !ok {
					break
				}
				if event.Err != nil {
					t.Fatal(event.Err)
				}
				m := event.Output.MessageOutput.Message
				if len(m.ToolCalls) > 0 {
					proposalID = m.ToolCalls[0].ID
				}
				if m.Role == schema.Tool {
					resultID = m.ToolCallID
					toolOutput = m.Content
				} else if m.Role == schema.Assistant && m.Content != "" {
					answer = m.Content
				}
			}
			want := int32(0)
			if scenario == "approve" {
				want = 1
			}
			if approvals.Load() != 1 || runner.calls.Load() != want || keys.calls.Load() != want || requests.Load() != 2 {
				t.Fatalf("approvals=%d SSH=%d keys=%d model=%d", approvals.Load(), runner.calls.Load(), keys.calls.Load(), requests.Load())
			}
			if proposalID == "" || proposalID != resultID || answer != "fixture done" {
				t.Fatal("tool correlation/final response missing")
			}
			if (scenario != "approve") != resultFailed(toolOutput) {
				t.Fatal("denial was presented as success")
			}
			entries, err := db.ListJournal(ctx, store.JournalFilter{RunID: service.RunID, Limit: 20})
			if err != nil {
				t.Fatal(err)
			}
			terminal := "denied"
			if want == 1 {
				terminal = "completed"
			}
			found := false
			for _, entry := range entries {
				if entry.Event == terminal {
					found = true
				}
			}
			if !found {
				t.Fatal("missing terminal Lake journal event")
			}
			files, _ := filepath.Glob(filepath.Join(root, ".zcode-turn-*"))
			if len(files) != 0 {
				t.Fatal("temporary Agent session was not removed")
			}
		})
	}
}

func TestSourceAgentCancellationRemovesSession(t *testing.T) {
	root := t.TempDir()
	opts := sourceOptions(t, root)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	released := make(chan struct{})
	stop := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
			close(released)
		case <-stop:
		}
	}))
	defer server.Close()
	defer close(stop)
	opts.BaseURL = server.URL + "/v1"
	agent, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	iter := agent.Run(ctx, &adk.AgentInput{Messages: []*schema.Message{schema.UserMessage("cancellation fixture")}})
	finished := make(chan error, 1)
	go func() {
		for {
			event, ok := iter.Next()
			if !ok {
				finished <- nil
				return
			}
			if event.Err != nil {
				finished <- event.Err
				return
			}
		}
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("model did not start")
	}
	cancel()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("cancelled turn claimed success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Agent did not stop")
	}
	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("provider request was not cancelled")
	}
	files, _ := filepath.Glob(filepath.Join(root, ".zcode-turn-*"))
	if len(files) != 0 {
		t.Fatal("cancelled session remained")
	}
}
