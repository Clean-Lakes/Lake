package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

func TestWorkflowCLIFromDefinitionThroughRunRecord(t *testing.T) {
	root := t.TempDir()
	call := func(args ...string) string {
		t.Helper()
		var out, errOut bytes.Buffer
		if err := run(context.Background(), args, root, &out, &errOut); err != nil {
			t.Fatalf("lake %s: %v; stderr=%s", strings.Join(args, " "), err, errOut.String())
		}
		return out.String()
	}
	call("add", "测试湖")
	call("res", "add", "测试湖/web", "--ssh", "root@example.invalid:22")
	path := filepath.Join(t.TempDir(), "inspect.json")
	definition := `{"name":"主机巡检","steps":[{"id":"cpu","name":"检查 CPU","kind":"ssh_check","resource":"web","check":"cpu"}]}`
	if err := os.WriteFile(path, []byte(definition), 0600); err != nil {
		t.Fatal(err)
	}
	var saved store.WorkflowDefinition
	if err := json.Unmarshal([]byte(call("workflow", "add", "测试湖", "--file", path, "--json")), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Lake != "测试湖" || saved.Name != "主机巡检" {
		t.Fatalf("saved=%+v", saved)
	}
	if !strings.Contains(call("workflow", "list", "--json"), saved.ID) {
		t.Fatal("workflow missing from list")
	}
	var execution store.WorkflowRun
	if err := json.Unmarshal([]byte(call("workflow", "run", saved.ID, "--json")), &execution); err != nil {
		t.Fatal(err)
	}
	if execution.Status != "failed" || len(execution.Steps) != 1 || execution.Steps[0].Status != "failed" {
		t.Fatalf("authorization failure was not persisted: %+v", execution)
	}
	if !strings.Contains(execution.Steps[0].Error, "执行授权") {
		t.Fatalf("error=%s", execution.Steps[0].Error)
	}
	if !strings.Contains(call("workflow", "events", execution.ID, "--json"), "failed") {
		t.Fatal("run events missing")
	}
	if !strings.Contains(call("workflow", "status", execution.ID, "--json"), saved.ID) {
		t.Fatal("run status missing workflow ID")
	}
}

func TestWorkflowAgentToolsInitialize(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "测试湖", ""); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewServiceForLake(ctx, s, "测试湖")
	if err != nil {
		t.Fatal(err)
	}
	tools, err := newWorkflowTools(s, service, nil, nil)
	if err != nil || len(tools) != 13 {
		t.Fatalf("tools=%d err=%v", len(tools), err)
	}
	names := map[string]bool{}
	for _, item := range tools {
		info, err := item.Info(ctx)
		if err != nil {
			t.Fatal(err)
		}
		names[info.Name] = true
	}
	if !names["lake_workflow_update"] || !names["lake_workflow_run"] || !names["lake_workflow_v2_dry_run"] || !names["lake_workflow_v2_resume"] {
		t.Fatalf("missing workflow tools: %v", names)
	}
}

func TestWorkflowAgentMutationNeedsApproval(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "测试湖", ""); err != nil {
		t.Fatal(err)
	}
	service, err := operate.NewServiceForLake(ctx, s, "测试湖")
	if err != nil {
		t.Fatal(err)
	}
	approved := false
	requests := 0
	tools, err := newWorkflowTools(s, service, nil, func(kind, path, detail string) (bool, error) {
		requests++
		if kind != "workflow" || path != "测试湖/巡检" || !strings.Contains(detail, "巡检") {
			t.Fatalf("approval scope %q %q %q", kind, path, detail)
		}
		return approved, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var create tool.InvokableTool
	for _, item := range tools {
		info, _ := item.Info(ctx)
		if info.Name == "lake_workflow_create" {
			create = item.(tool.InvokableTool)
		}
	}
	if create == nil {
		t.Fatal("missing create tool")
	}
	args := `{"name":"巡检","target_mode":"single","steps":[{"id":"cpu","name":"CPU","kind":"ssh_check","resource":"$host","check":"cpu"}]}`
	if _, err := create.InvokableRun(ctx, args); err != nil {
		t.Fatal(err)
	}
	items, err := s.ListWorkflows(ctx, "测试湖")
	if err != nil || len(items) != 0 || requests != 1 {
		t.Fatalf("denied mutation: items=%d requests=%d err=%v", len(items), requests, err)
	}
	approved = true
	if _, err := create.InvokableRun(ctx, args); err != nil {
		t.Fatal(err)
	}
	items, err = s.ListWorkflows(ctx, "测试湖")
	if err != nil || len(items) != 1 || requests != 2 {
		t.Fatalf("approved mutation: items=%d requests=%d err=%v", len(items), requests, err)
	}
}

func TestWorkflowCLIRuntimeTargetAndUpdatePreserveRunSnapshot(t *testing.T) {
	root := t.TempDir()
	call := func(args ...string) (string, error) {
		var out, errOut bytes.Buffer
		err := run(context.Background(), args, root, &out, &errOut)
		return out.String(), err
	}
	must := func(args ...string) string {
		t.Helper()
		out, err := call(args...)
		if err != nil {
			t.Fatalf("lake %s: %v", strings.Join(args, " "), err)
		}
		return out
	}
	must("add", "测试湖")
	must("res", "add", "测试湖/web", "--ssh", "root@web.invalid:22")
	must("res", "add", "测试湖/other", "--ssh", "root@other.invalid:22")
	path := filepath.Join(t.TempDir(), "workflow.json")
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"name":"检查主机","steps":[{"id":"cpu","name":"CPU","kind":"ssh_check","resource":"web","check":"cpu"}]}`)
	var saved store.WorkflowDefinition
	if err := json.Unmarshal([]byte(must("workflow", "add", "测试湖", "--file", path, "--json")), &saved); err != nil {
		t.Fatal(err)
	}
	var first store.WorkflowRun
	if err := json.Unmarshal([]byte(must("workflow", "run", saved.ID, "--resource", "other", "--json")), &first); err != nil {
		t.Fatal(err)
	}
	var resolved workflow.Definition
	if err := json.Unmarshal(first.Spec, &resolved); err != nil {
		t.Fatal(err)
	}
	if resolved.Steps[0].Resource != "other" {
		t.Fatalf("run target = %s", resolved.Steps[0].Resource)
	}
	write(`{"name":"检查主机","steps":[{"id":"cpu","name":"CPU","kind":"ssh_check","resource":"$host","check":"cpu"}]}`)
	must("workflow", "update", saved.ID, "--file", path)
	if _, err := call("workflow", "run", saved.ID, "--json"); err == nil || !strings.Contains(err.Error(), "host") {
		t.Fatalf("unbound run error = %v", err)
	}
	var second store.WorkflowRun
	if err := json.Unmarshal([]byte(must("workflow", "run", saved.ID, "--bind", "host=web", "--json")), &second); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second.Spec, &resolved); err != nil {
		t.Fatal(err)
	}
	if resolved.Steps[0].Resource != "web" {
		t.Fatalf("second run target = %s", resolved.Steps[0].Resource)
	}
	var prior store.WorkflowRun
	if err := json.Unmarshal([]byte(must("workflow", "status", first.ID, "--json")), &prior); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(prior.Spec, &resolved); err != nil {
		t.Fatal(err)
	}
	if resolved.Steps[0].Resource != "other" {
		t.Fatalf("prior run target changed to %s", resolved.Steps[0].Resource)
	}
	write(`{"name":"检查主机","target_mode":"multiple","steps":[{"id":"cpu","name":"CPU","kind":"ssh_check","resource":"$host","check":"cpu"}]}`)
	must("workflow", "update", saved.ID, "--file", path)
	var multi store.WorkflowRun
	if err := json.Unmarshal([]byte(must("workflow", "run", saved.ID, "--target", "web", "--target", "other", "--json")), &multi); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(multi.Spec, &resolved); err != nil {
		t.Fatal(err)
	}
	if len(resolved.Steps) != 2 || resolved.Steps[0].Resource != "web" || resolved.Steps[1].Resource != "other" {
		t.Fatalf("multi target snapshot=%+v", resolved)
	}
}
