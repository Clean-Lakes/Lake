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
)

func TestWorkflowV2CLIValidateDryRunSaveAmendAndRun(t *testing.T) {
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
	must("res", "add", "测试湖/web", "--ssh", "root@example.invalid:22")
	path := filepath.Join(t.TempDir(), "flow.yaml")
	definition := "version: 2\nname: 巡检\nnodes:\n  - id: inspect\n    kind: ssh_check\n    target: {type: string, literal: web}\n    check: hostname\n  - id: follow\n    kind: ssh_command\n    depends_on: [inspect]\n    target: {type: string, literal: web}\n    command: {type: string, literal: 'echo ok'}\n"
	if err := os.WriteFile(path, []byte(definition), 0600); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(must("workflow", "validate", "--file", path, "--json"), `"max_expanded":2`) {
		t.Fatal("validate omitted graph bound")
	}
	before, err := os.ReadFile(filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	dry := must("workflow", "dry-run", "测试湖", "--file", path, "--json")
	var preview struct {
		Nodes []struct {
			ID, Target, Permission string
			ModelCalls             int `json:"model_calls"`
		} `json:"nodes"`
		EstimatedModelCalls int `json:"estimated_model_calls"`
	}
	if err := json.Unmarshal([]byte(dry), &preview); err != nil {
		t.Fatal(err)
	}
	if len(preview.Nodes) != 2 || preview.Nodes[0].ID != "inspect" || preview.Nodes[0].Target != "web" || preview.Nodes[1].Permission != "write_approval" || preview.EstimatedModelCalls != 0 {
		t.Fatalf("dry-run=%s", dry)
	}
	after, err := os.ReadFile(filepath.Join(root, "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("dry-run mutated database")
	}
	var saved store.WorkflowV2Definition
	if err := json.Unmarshal([]byte(must("workflow", "save", "测试湖", "--file", path, "--json")), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 1 || saved.Name != "巡检" {
		t.Fatalf("saved=%+v", saved)
	}
	if !strings.Contains(must("workflow", "list", "--lake", "测试湖", "--json"), saved.ID) {
		t.Fatal("v2 workflow omitted from list")
	}
	definition = strings.Replace(definition, "name: 巡检", "name: 巡检更新", 1)
	if err := os.WriteFile(path, []byte(definition), 0600); err != nil {
		t.Fatal(err)
	}
	var updated store.WorkflowV2Definition
	if err := json.Unmarshal([]byte(must("workflow", "amend", saved.ID, "--file", path, "--json")), &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 || updated.Name != "巡检更新" {
		t.Fatalf("updated=%+v", updated)
	}
	var execution store.WorkflowV2Run
	if err := json.Unmarshal([]byte(must("workflow", "run", saved.ID, "--json")), &execution); err != nil {
		t.Fatal(err)
	}
	if execution.Status != "waiting_approval" && execution.Status != "failed" {
		t.Fatalf("execution=%+v", execution)
	}
	if !strings.Contains(must("workflow", "events", execution.ID, "--json"), "node_status") {
		t.Fatal("v2 events missing")
	}
	if !strings.Contains(must("workflow", "status", execution.ID, "--json"), execution.ID) {
		t.Fatal("v2 status missing")
	}
}

func TestWorkflowV2AgentToolsSaveDryRunAndRun(t *testing.T) {
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
	defer service.CloseSessions()
	approved := false
	requests := 0
	tools, err := newWorkflowTools(s, service, nil, func(kind, path, detail string) (bool, error) {
		requests++
		if kind != "workflow" || !strings.HasPrefix(path, "测试湖/") {
			t.Fatalf("approval scope: %s %s", kind, path)
		}
		return approved, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	invoke := func(name, input string) workflowV2ToolOutput {
		t.Helper()
		for _, candidate := range tools {
			info, err := candidate.Info(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if info.Name != name {
				continue
			}
			answer, err := candidate.(tool.InvokableTool).InvokableRun(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			var result workflowV2ToolOutput
			if err := json.Unmarshal([]byte(answer), &result); err != nil {
				t.Fatal(err)
			}
			return result
		}
		t.Fatalf("tool %s missing", name)
		return workflowV2ToolOutput{}
	}
	spec := `{"version":2,"name":"湖概况","nodes":[{"id":"overview","kind":"tool_call","tool":"lake_overview","output_type":"object"}]}`
	input, _ := json.Marshal(workflowV2SpecInput{DefinitionJSON: spec})
	if result := invoke("lake_workflow_v2_dry_run", string(input)); result.Preview == nil || result.Preview.Nodes[0].Target != "lake_overview" || requests != 0 {
		t.Fatalf("dry-run=%+v approvals=%d", result, requests)
	}
	if result := invoke("lake_workflow_v2_save", string(input)); result.Error == "" {
		t.Fatal("save without approval succeeded")
	}
	if items, _ := s.ListWorkflowsV2(ctx, service.Lake.ID); len(items) != 0 {
		t.Fatal("denied save persisted")
	}
	approved = true
	saved := invoke("lake_workflow_v2_save", string(input))
	if saved.ID == "" || saved.Revision != 1 {
		t.Fatalf("saved=%+v", saved)
	}
	request, _ := json.Marshal(workflowV2IDInput{ID: saved.ID})
	run := invoke("lake_workflow_v2_run", string(request))
	if run.Status != "completed" || len(run.Nodes) != 1 || run.Nodes[0].Status != "completed" {
		t.Fatalf("run=%+v", run)
	}
	status, _ := json.Marshal(workflowV2ResumeInput{RunID: run.ID})
	if got := invoke("lake_workflow_v2_status", string(status)); got.Status != "completed" {
		t.Fatalf("status=%+v", got)
	}
	if got := invoke("lake_workflow_v2_events", string(status)); len(got.Events) < 3 {
		t.Fatalf("events=%+v", got)
	}
}
