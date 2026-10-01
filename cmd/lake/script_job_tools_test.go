package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type jobToolRunner struct{ calls int }

func (r *jobToolRunner) Run(context.Context, sshtransport.Target, []byte, string) (sshtransport.Result, error) {
	panic("unexpected Run")
}
func (r *jobToolRunner) RunWithInput(context.Context, sshtransport.Target, []byte, string, []byte) (sshtransport.Result, error) {
	r.calls++
	return sshtransport.Result{Stdout: `{"status":"succeeded","exit_code":0,"stdout_tail":"done"}`}, nil
}

func TestScriptJobToolsPreserveApprovalAndNamedResourceScope(t *testing.T) {
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
	var hosts []store.Resource
	for _, name := range []string{"host", "other"} {
		host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: name, SSH: store.SSHSpec{Host: name + ".invalid", Port: 22, Username: "root"}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
			t.Fatal(err)
		}
		if _, err = s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
			t.Fatal(err)
		}
		hosts = append(hosts, host)
	}
	script, err := s.SaveScript(ctx, store.ScriptInput{Name: "job", Language: "sh", ResourceID: hosts[0].ID, Content: []byte("printf done\n")})
	if err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	defer service.CloseSessions()
	remote, keys := &jobToolRunner{}, &scriptTestKeys{}
	service.Runner, service.Keys = remote, keys
	approved, sshApproved := false, false
	approvals := 0
	service.Confirm = func(context.Context, string, string) (bool, error) { return sshApproved, nil }
	candidates, err := newScriptJobTools(service, func(kind, path, detail string) (bool, error) {
		approvals++
		if kind != "script_job" || path != "ops/host" || !strings.Contains(detail, script.ID+"/"+script.SHA256) {
			t.Fatalf("wrong approval: %s %s %s", kind, path, detail)
		}
		return approved, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	toolsByName := map[string]tool.InvokableTool{}
	for _, candidate := range candidates {
		info, err := candidate.Info(ctx)
		if err != nil {
			t.Fatal(err)
		}
		toolsByName[info.Name] = candidate.(tool.InvokableTool)
	}
	invoke := func(name string, args any) scriptJobOutput {
		t.Helper()
		b, _ := json.Marshal(args)
		raw, err := toolsByName[name].InvokableRun(ctx, string(b))
		if err != nil {
			t.Fatal(err)
		}
		var v scriptJobOutput
		if err = json.Unmarshal([]byte(raw), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	input := scriptStartInput{ID: script.ID, Resource: "host", SHA256: script.SHA256, TimeoutSeconds: 30}
	if v := invoke("lake_script_start", input); v.Error == "" || remote.calls != 0 || keys.calls != 0 {
		t.Fatal("generic approval bypassed")
	}
	approved = true
	if v := invoke("lake_script_start", input); v.Task == nil || v.Task.Status != "not_started" || remote.calls != 0 || keys.calls != 0 {
		t.Fatalf("SSH approval bypassed: %+v", v)
	}
	sshApproved = true
	v := invoke("lake_script_start", input)
	if v.Error != "" || v.Task == nil || v.Task.Status != "succeeded" || remote.calls != 1 || approvals != 3 {
		t.Fatalf("approved job failed: %+v", v)
	}
	id := v.Task.Job.ID
	if v := invoke("lake_script_status", scriptJobInput{Resource: "other", JobID: id}); v.Error == "" || remote.calls != 1 {
		t.Fatal("job scope bypassed")
	}
	if v := invoke("lake_script_status", scriptJobInput{Resource: "host", JobID: id}); v.Error != "" || v.Task == nil || remote.calls != 2 || approvals != 3 {
		t.Fatal("read status requested write approval")
	}
	if _, err = s.SetExecuteAuthz(ctx, hosts[0].ID, false); err != nil {
		t.Fatal(err)
	}
	if v := invoke("lake_script_wait", scriptJobInput{Resource: "host", JobID: id, Seconds: 1}); v.Error == "" || remote.calls != 2 {
		t.Fatal("revoked job reached SSH")
	}
	for _, name := range []string{"lake_script_status", "lake_script_wait", "lake_script_jobs"} {
		if chatToolCapability(name) != "read" {
			t.Fatal("query not classified read")
		}
	}
	if chatToolCapability("lake_script_start") != "execute" || chatToolCapability("lake_script_cancel") != "execute" {
		t.Fatal("mutations not classified execute")
	}
}
