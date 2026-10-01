package opsmcp

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type countedSSH struct{ calls atomic.Int32 }

func (s *countedSSH) Run(_ context.Context, _ sshtransport.Target, _ []byte, command string) (sshtransport.Result, error) {
	s.calls.Add(1)
	if command != "hostname" {
		panic("test accepted a non-hostname command")
	}
	return sshtransport.Result{Stdout: "fixture-host\n", ExitCode: 0}, nil
}

type countedKeys struct{ loads atomic.Int32 }

func (k *countedKeys) Load(string) ([]byte, error) {
	k.loads.Add(1)
	return []byte("fixture-key-never-returned"), nil
}

func TestMCPReadApprovalAndJournal(t *testing.T) {
	for _, scenario := range []string{"approve", "decline", "unauthorized", "revoke_during_approval", "unsupported_client"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			db, err := store.Open(ctx, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			lake, err := db.CreateLake(ctx, "fixture-lake", "")
			if err != nil {
				t.Fatal(err)
			}
			host, err := db.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "fixture", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "fixture"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = db.SetCredentialRef(ctx, host.ID, "keychain:ssh/00000000000000000000000000000001"); err != nil {
				t.Fatal(err)
			}
			if _, err = db.SetExecuteAuthz(ctx, host.ID, scenario != "unauthorized"); err != nil {
				t.Fatal(err)
			}
			// Even an existing silent-read policy must not bypass this external
			// caller's stronger requirement. No persistent permission is changed.
			if _, err = db.SetPermissionPolicy(ctx, "ssh-read", true); err != nil {
				t.Fatal(err)
			}
			transport, keys := &countedSSH{}, &countedKeys{}
			server, err := New(ctx, Config{Store: db, Lake: lake.Name, RequireApproval: true, Factory: func(ctx context.Context) (*operate.Service, error) {
				service, err := operate.NewServiceForLake(ctx, db, lake.Name)
				if err == nil {
					service.Runner, service.Keys = transport, keys
				}
				return service, err
			}})
			if err != nil {
				t.Fatal(err)
			}
			approvals := 0
			opts := &mcp.ClientOptions{}
			if scenario != "unsupported_client" {
				opts.ElicitationHandler = func(ctx context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
					approvals++
					if !strings.Contains(req.Params.Message, "fixture-lake/fixture") || !strings.Contains(req.Params.Message, "hostname") {
						t.Error("approval does not identify target and command")
					}
					if scenario == "revoke_during_approval" {
						if _, err := db.SetExecuteAuthz(ctx, host.ID, false); err != nil {
							t.Error(err)
						}
					}
					if scenario == "decline" {
						return &mcp.ElicitResult{Action: "decline"}, nil
					}
					return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"approved": true}}, nil
				}
			}
			client := connectTestClient(t, ctx, server.MCP, opts)
			tools, err := client.ListTools(ctx, &mcp.ListToolsParams{})
			if err != nil || len(tools.Tools) != 4 {
				t.Fatalf("tools=%v err=%v", tools, err)
			}
			call := func(name string, args any) *mcp.CallToolResult {
				result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			resources := call("lake_resources", map[string]any{})
			if raw, _ := json.Marshal(resources); strings.Contains(string(raw), "credential") || strings.Contains(string(raw), "fixture-key-never-returned") {
				t.Fatal("credential leaked")
			}
			result := call("lake_ssh_read", map[string]any{"resource_id": host.ID, "check": "hostname"})
			var out readOutput
			raw, err := json.Marshal(result.StructuredContent)
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(raw, &out); err != nil || out.RunID == "" {
				t.Fatalf("missing run correlation: %s %v", raw, err)
			}
			wantCalls := int32(0)
			if scenario == "approve" {
				wantCalls = 1
				if result.IsError || out.Status != "completed" || out.Stdout != "fixture-host\n" || out.ExitCode == nil || *out.ExitCode != 0 {
					t.Fatalf("unexpected approved result: %s", raw)
				}
			} else if !result.IsError || out.Status != "failed" || out.ExitCode != nil {
				t.Fatalf("denial claimed successful execution: %s", raw)
			}
			if transport.calls.Load() != wantCalls || keys.loads.Load() != wantCalls {
				t.Fatalf("dispatch=%d credential_reads=%d want=%d", transport.calls.Load(), keys.loads.Load(), wantCalls)
			}
			wantApproval := 1
			if scenario == "unauthorized" || scenario == "unsupported_client" {
				wantApproval = 0
			}
			if approvals != wantApproval {
				t.Fatalf("approvals=%d want=%d", approvals, wantApproval)
			}
			journal := call("lake_journal", map[string]any{"run_id": out.RunID})
			jraw, _ := json.Marshal(journal.StructuredContent)
			var events struct {
				Events []journalItem `json:"events"`
			}
			if err = json.Unmarshal(jraw, &events); err != nil {
				t.Fatal(err)
			}
			wantEvent := "denied"
			if wantCalls == 1 {
				wantEvent = "completed"
			}
			found := false
			actionID := ""
			for _, e := range events.Events {
				if e.Event == wantEvent {
					found = true
				}
				if actionID == "" {
					actionID = e.ActionID
				}
				if e.ActionID != actionID || e.Target != "fixture-lake/fixture" {
					t.Fatal("audit correlation or target mismatch")
				}
			}
			if !found {
				t.Fatalf("missing %s audit event: %s", wantEvent, jraw)
			}
			if !call("lake_journal", map[string]any{"run_id": "foreign-run"}).IsError {
				t.Fatal("foreign journal readable")
			}
			if !call("lake_ssh_read", map[string]any{"resource_id": "foreign-host", "check": "hostname"}).IsError {
				t.Fatal("foreign resource accepted")
			}
			if !call("lake_ssh_read", map[string]any{"resource_id": host.ID, "check": "hostname; echo injected"}).IsError {
				t.Fatal("arbitrary command accepted")
			}
			if transport.calls.Load() != wantCalls {
				t.Fatal("invalid requests reached SSH")
			}
			policy, err := db.GetPermissionPolicy(ctx)
			if err != nil || !policy.SilentSSHRead {
				t.Fatal("MCP changed persistent policy")
			}
		})
	}
}

func connectTestClient(t *testing.T, ctx context.Context, server *mcp.Server, options *mcp.ClientOptions) *mcp.ClientSession {
	t.Helper()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, ApprovalTransport{Transport: serverTransport}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	clientSession, err := mcp.NewClient(&mcp.Implementation{Name: "lake-ops-probe", Version: "1"}, options).Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	return clientSession
}
