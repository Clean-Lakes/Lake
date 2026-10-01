package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"github.com/cloudwego/eino/lake/workflow"
)

type scriptTestKeys struct{ calls int }

func (k *scriptTestKeys) Load(string) ([]byte, error) { k.calls++; return []byte("fake-key"), nil }

type scriptTestRunner struct {
	calls   int
	input   []byte
	command string
}

func TestWorkflowScriptNodePinsSavedHash(t *testing.T) {
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
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "web", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	script, err := s.SaveScript(ctx, store.ScriptInput{Name: "check", Language: "sh", ResourceID: host.ID, Content: []byte("echo ok\n")})
	if err != nil {
		t.Fatal(err)
	}
	node := workflow.NodeV2{ID: "script", Kind: "tool_call", Tool: "lake_script_run", OutputType: "object", Inputs: map[string]workflow.ValueV2{"id": {Type: "string", Literal: script.ID}, "resource": {Type: "string", Literal: "web"}, "sha256": {Type: "string", Literal: script.SHA256}}}
	compiled, err := workflow.CompileV2(workflow.DefinitionV2{Version: 2, Name: "script-flow", Nodes: []workflow.NodeV2{node}})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := previewWorkflowV2(ctx, s, lake.ID, compiled)
	if err != nil || preview.Nodes[0].CommandSHA256 != script.SHA256 {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	node.Inputs["sha256"] = workflow.ValueV2{Type: "string", Literal: strings.Repeat("0", 64)}
	compiled, err = workflow.CompileV2(workflow.DefinitionV2{Version: 2, Name: "script-flow", Nodes: []workflow.NodeV2{node}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := previewWorkflowV2(ctx, s, lake.ID, compiled); err == nil {
		t.Fatal("wrong script hash accepted at save")
	}
	if err := os.WriteFile(filepath.Join(s.Root(), script.Path), []byte("echo changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	node.Inputs["sha256"] = workflow.ValueV2{Type: "string", Literal: script.SHA256}
	compiled, err = workflow.CompileV2(workflow.DefinitionV2{Version: 2, Name: "script-flow", Nodes: []workflow.NodeV2{node}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := previewWorkflowV2(ctx, s, lake.ID, compiled); err == nil {
		t.Fatal("tampered script accepted at save")
	}
}

func (r *scriptTestRunner) Run(context.Context, sshtransport.Target, []byte, string) (sshtransport.Result, error) {
	return sshtransport.Result{}, nil
}
func (r *scriptTestRunner) RunWithInput(_ context.Context, _ sshtransport.Target, _ []byte, command string, input []byte) (sshtransport.Result, error) {
	r.calls++
	r.command = command
	r.input = append([]byte(nil), input...)
	return sshtransport.Result{Stdout: "ok\n"}, nil
}

func TestScriptRunVerifiesHashScopeAndApproval(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "web", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
		t.Fatal(err)
	}
	script, err := s.SaveScript(ctx, store.ScriptInput{Name: "check", Language: "sh", ResourceID: host.ID, Content: []byte("printf ok\n")})
	if err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	defer service.CloseSessions()
	keys := &scriptTestKeys{}
	remote := &scriptTestRunner{}
	service.Keys, service.Runner = keys, remote
	service.Confirm = func(_ context.Context, path, summary string) (bool, error) {
		if strings.Contains(summary, "printf ok") || !strings.Contains(summary, script.SHA256) {
			t.Fatalf("approval summary=%q", summary)
		}
		return false, nil
	}
	if _, err := executeStoredScript(ctx, s, service, script.ID, "web", script.SHA256); err == nil || remote.calls != 0 || keys.calls != 0 {
		t.Fatalf("denied: err=%v remote=%d keys=%d", err, remote.calls, keys.calls)
	}
	service.Confirm = func(_ context.Context, path, summary string) (bool, error) { return true, nil }
	if _, err := executeStoredScript(ctx, s, service, script.ID, "web", strings.Repeat("0", 64)); err == nil || remote.calls != 0 {
		t.Fatal("wrong saved hash executed")
	}
	result, err := executeStoredScript(ctx, s, service, script.ID, "web", script.SHA256)
	if err != nil || result.Stdout != "ok\n" || remote.calls != 1 || remote.command != "sh -s" || string(remote.input) != "printf ok\n" {
		t.Fatalf("run=%+v err=%v remote=%+v", result, err, remote)
	}
	if err := os.WriteFile(filepath.Join(root, script.Path), []byte("printf changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := executeStoredScript(ctx, s, service, script.ID, "web", script.SHA256); err == nil || remote.calls != 1 {
		t.Fatal("tampered script executed")
	}
}

func TestScriptAndLinkCLIListRead(t *testing.T) {
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
	a, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "web", SSH: store.SSHSpec{Host: "web.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "db", SSH: store.SSHSpec{Host: "db.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	script, err := s.SaveScript(ctx, store.ScriptInput{Name: "check", Language: "sh", ResourceID: a.ID, Content: []byte("echo ok\n")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddLink(ctx, a.ID, b.ID, "depends_on"); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if err := scriptCommand(ctx, s, []string{"list", "ops/web"}, strings.NewReader(""), &out, &errOut); err != nil || !strings.Contains(out.String(), script.ID) {
		t.Fatalf("list=%q err=%v", out.String(), err)
	}
	out.Reset()
	if err := scriptCommand(ctx, s, []string{"read", script.ID}, strings.NewReader(""), &out, &errOut); err != nil || out.String() != "echo ok\n" {
		t.Fatalf("read=%q err=%v", out.String(), err)
	}
	out.Reset()
	if err := linkCommand(ctx, s, []string{"list", "ops/web"}, &out, &errOut); err != nil || !strings.Contains(out.String(), "ops/web\tdepends_on\tops/db") {
		t.Fatalf("link=%q err=%v", out.String(), err)
	}
}
