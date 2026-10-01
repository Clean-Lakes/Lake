package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
)

func TestAgentScriptToolBindsFrozenResourceAndRetainsBothApprovalChecks(t *testing.T) {
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
	keys, remote := &scriptTestKeys{}, &scriptTestRunner{}
	service.Keys, service.Runner = keys, remote
	approved, sshApproved := false, false
	approvals := 0
	service.Confirm = func(context.Context, string, string) (bool, error) { return sshApproved, nil }
	candidates, err := newScriptAndLinkTools(s, service, func(kind, path, detail string) (bool, error) {
		approvals++
		if kind != "script" || path != "ops/web" || detail != script.ID+"/"+script.SHA256 {
			t.Fatalf("wrong approval target: %s %s %s", kind, path, detail)
		}
		return approved, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var run tool.InvokableTool
	for _, candidate := range candidates {
		info, err := candidate.Info(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if info.Name == "lake_script_run" {
			run = candidate.(tool.InvokableTool)
		}
	}
	if run == nil {
		t.Fatal("script tool missing")
	}
	invoke := func(resource string) scriptRunOutput {
		args, _ := json.Marshal(scriptRunInput{ID: script.ID, Resource: resource, SHA256: script.SHA256})
		raw, err := run.InvokableRun(ctx, string(args))
		if err != nil {
			t.Fatal(err)
		}
		var output scriptRunOutput
		if err := json.Unmarshal([]byte(raw), &output); err != nil {
			t.Fatal(err)
		}
		return output
	}
	if output := invoke("web"); output.Error == "" || approvals != 1 || remote.calls != 0 || keys.calls != 0 {
		t.Fatalf("script approval denial bypassed: %+v approvals=%d", output, approvals)
	}
	approved = true
	if output := invoke("web"); output.Error == "" || approvals != 2 || remote.calls != 0 || keys.calls != 0 {
		t.Fatalf("SSH approval denial bypassed: %+v approvals=%d", output, approvals)
	}
	sshApproved = true
	if output := invoke("web"); output.Error != "" || output.Result == nil || output.Result.Stdout != "ok\n" || approvals != 3 || remote.calls != 1 {
		t.Fatalf("approved frozen script failed: %+v approvals=%d remote=%d", output, approvals, remote.calls)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, false); err != nil {
		t.Fatal(err)
	}
	if output := invoke("web"); output.Error == "" || approvals != 3 || remote.calls != 1 {
		t.Fatal("revoked resource requested approval or executed")
	}
	newHost, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "added-later", SSH: store.SSHSpec{Host: "later.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, newHost.ID, true); err != nil {
		t.Fatal(err)
	}
	if output := invoke("added-later"); output.Error == "" || approvals != 3 || remote.calls != 1 {
		t.Fatal("resource added after snapshot was admitted")
	}
	if output := invoke("ops/web"); !strings.Contains(output.Error, "只接受当前湖资源名") {
		t.Fatalf("qualified resource admitted: %+v", output)
	}
}
