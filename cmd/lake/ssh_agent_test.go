package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/tool"
	lakemodel "github.com/cloudwego/eino/lake/model"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type uncertainSSHRunner struct{ calls int }

func (r *uncertainSSHRunner) Run(context.Context, sshtransport.Target, []byte, string) (sshtransport.Result, error) {
	r.calls++
	return sshtransport.Result{}, errors.New("simulated connection interruption")
}

func TestSSHToolDistinguishesRejectedCommandFromUnknownExecution(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	defer service.CloseSessions()
	keys, runner := &scriptTestKeys{}, &uncertainSSHRunner{}
	service.Keys, service.Runner = keys, runner
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	tools, err := newSSHTools(ctx, service)
	if err != nil {
		t.Fatal(err)
	}
	var run tool.InvokableTool
	for _, candidate := range tools {
		info, _ := candidate.Info(ctx)
		if info.Name == "lake_ssh" {
			run = candidate.(tool.InvokableTool)
		}
	}
	if run == nil {
		t.Fatal("SSH tool missing")
	}
	invoke := func(input sshToolInput) sshToolOutput {
		args, _ := json.Marshal(input)
		raw, err := run.InvokableRun(ctx, string(args))
		if err != nil {
			t.Fatal(err)
		}
		var output sshToolOutput
		if err := json.Unmarshal([]byte(raw), &output); err != nil {
			t.Fatal(err)
		}
		return output
	}
	for _, input := range []sshToolInput{{Resource: "host", Command: "echo ok\necho bad"}, {Resource: "host", Command: strings.Repeat("x", 2049)}, {Resource: "missing", Command: "echo ok"}} {
		if output := invoke(input); output.Error == "" || output.Unknown || runner.calls != 0 || keys.calls != 0 {
			t.Fatalf("pre-execution rejection marked unknown: %+v calls=%d keys=%d", output, runner.calls, keys.calls)
		}
	}
	if output := invoke(sshToolInput{Resource: "host", Command: "echo ok"}); output.Error == "" || !output.Unknown || runner.calls != 1 {
		t.Fatalf("transport failure not guarded: %+v calls=%d", output, runner.calls)
	}
}

func TestSSHAgentListsOnlyLiveSessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var req struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			names := make(map[string]bool)
			for _, item := range req.Tools {
				names[item.Name] = true
			}
			for _, name := range []string{"lake_ssh_session_open", "lake_ssh_session_list", "lake_ssh_session_close", "lake_ssh"} {
				if !names[name] {
					t.Errorf("child missing tool %s: %v", name, names)
				}
			}
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"toolu_1","name":"lake_ssh_session_list","input":{}}]}`))
			return
		}
		messages, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(messages), `\"sessions\":[]`) {
			t.Errorf("session list result missing: %s", messages)
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"当前没有保持的 SSH 会话。"}]}`))
	}))
	defer server.Close()
	agentTool, err := newSSHAgentTool(ctx, &lakemodel.Anthropic{BaseURL: server.URL + "/anthropic", Model: "test-model", APIKey: []byte("test-key")}, service, specialistExecution{ModelID: "test-model", Store: s})
	if err != nil {
		t.Fatal(err)
	}
	info, err := agentTool.Info(ctx)
	if err != nil || info.Name != "lake_ssh_agent" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	answer, err := agentTool.(tool.InvokableTool).InvokableRun(ctx, `{"request":"现在有哪些 SSH 会话在后台保持？"}`)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || !strings.Contains(answer, "没有保持的 SSH 会话") {
		t.Fatalf("calls=%d answer=%q", calls, answer)
	}
}

func TestSSHAgentUnknownResourceReportsActualNamesWithoutConnecting(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "36.151.150.63",
		SSH: store.SSHSpec{Host: "36.151.150.63", Port: 22, Username: "root"},
	}); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RunRead(ctx, "web-01", "cpu")
	if err == nil {
		t.Fatal("invented resource unexpectedly accepted")
	}
	message, names := explainSSHResourceError(ctx, service, "web-01", err)
	if !strings.Contains(message, `资源 "web-01" 未登记`) || !strings.Contains(message, "36.151.150.63") || len(names) != 1 || names[0] != "36.151.150.63" {
		t.Fatalf("message=%q names=%v", message, names)
	}
	journal, err := s.ListJournal(ctx, store.JournalFilter{})
	if err != nil || len(journal) != 0 {
		t.Fatalf("unknown resource wrote journal or connected: entries=%v err=%v", journal, err)
	}
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var req struct {
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			_, _ = w.Write([]byte(`{"content":[{"type":"tool_use","id":"toolu_unknown","name":"lake_ssh","input":{"resource":"web-01","check":"cpu"}}]}`))
			return
		}
		body, _ := json.Marshal(req.Messages)
		if !strings.Contains(string(body), "available_resources") || !strings.Contains(string(body), "36.151.150.63") || !strings.Contains(string(body), "未登记") {
			t.Errorf("specialist did not receive grounded error: %s", body)
		}
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"web-01 未登记；当前湖只有 36.151.150.63。没有执行 SSH 检查。"}]}`))
	}))
	defer server.Close()
	agentTool, err := newSSHAgentTool(ctx, &lakemodel.Anthropic{BaseURL: server.URL + "/anthropic", Model: "test-model", APIKey: []byte("test-key")}, service, specialistExecution{ModelID: "test-model", Store: s})
	if err != nil {
		t.Fatal(err)
	}
	answer, err := agentTool.(tool.InvokableTool).InvokableRun(ctx, `{"request":"检查 web-01 的 CPU"}`)
	if err != nil || calls != 2 || !strings.Contains(answer, "当前湖只有 36.151.150.63") {
		t.Fatalf("answer=%q calls=%d err=%v", answer, calls, err)
	}
}
