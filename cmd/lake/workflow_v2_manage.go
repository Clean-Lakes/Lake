package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

type workflowV2ManageRequest struct {
	Action           string `json:"action"`
	Lake             string `json:"lake,omitempty"`
	ID               string `json:"id,omitempty"`
	Definition       string `json:"definition,omitempty"`
	Enabled          bool   `json:"enabled"`
	ExpectedRevision int    `json:"expected_revision,omitempty"`
}

func workflowV2Manage(ctx context.Context, s *store.Store, input io.Reader, out io.Writer) error {
	var req workflowV2ManageRequest
	decoder := json.NewDecoder(io.LimitReader(input, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return errors.New("工作流 v2 管理请求无效")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("管理请求只能有一个 JSON 对象")
	}
	lakeID := ""
	if req.Lake != "" {
		lake, err := s.GetLakeByName(ctx, req.Lake)
		if err != nil {
			return err
		}
		lakeID = lake.ID
	}
	switch req.Action {
	case "list":
		items, err := s.ListWorkflowsV2(ctx, lakeID)
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "runs":
		items, err := s.RecentWorkflowV2Runs(ctx, lakeID)
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "status", "events":
		run, err := s.GetWorkflowV2Run(ctx, req.ID)
		if err != nil {
			return err
		}
		if lakeID != "" && run.LakeID != lakeID {
			return errors.New("运行不属于选定湖")
		}
		if req.Action == "status" {
			return writeJSON(out, run)
		}
		items, err := s.ListWorkflowV2Events(ctx, req.ID)
		if err != nil {
			return err
		}
		return writeJSON(out, items)
	case "enable":
		item, err := s.GetWorkflowV2(ctx, req.ID)
		if err != nil {
			return err
		}
		if lakeID != "" && item.LakeID != lakeID {
			return errors.New("工作流不属于选定湖")
		}
		if err := s.SetWorkflowV2Enabled(ctx, item.ID, req.Enabled); err != nil {
			return err
		}
		item, err = s.GetWorkflowV2(ctx, item.ID)
		if err != nil {
			return err
		}
		return writeJSON(out, item)
	case "validate", "preview", "save", "amend":
		compiled, canonical, err := parseWorkflowV2Tool(req.Definition)
		if err != nil {
			return err
		}
		if req.Action != "validate" && lakeID == "" {
			return errors.New("预览和保存需要湖名")
		}
		preview, err := previewWorkflowV2(ctx, s, lakeID, compiled)
		if err != nil {
			return err
		}
		if req.Action == "validate" || req.Action == "preview" {
			return writeJSON(out, preview)
		}
		if err := authorizeDirectWorkflowAction(ctx, s, lakeID, "lake_workflow_v2_"+req.Action, compiled.Definition.Name, "desktop", string(canonical)); err != nil {
			return err
		}
		var saved store.WorkflowV2Definition
		if req.Action == "save" {
			saved, err = s.CreateWorkflowV2(ctx, lakeID, compiled.Definition.Name, compiled.Definition.Description, canonical)
		} else {
			current, e := s.GetWorkflowV2(ctx, req.ID)
			if e != nil {
				return e
			}
			if current.LakeID != lakeID {
				return errors.New("工作流不属于选定湖")
			}
			if req.ExpectedRevision < 1 {
				return errors.New("修订需要 expected_revision")
			}
			saved, err = s.UpdateWorkflowV2Revision(ctx, current.ID, req.ExpectedRevision, compiled.Definition.Name, compiled.Definition.Description, canonical)
		}
		if err != nil {
			return err
		}
		return writeJSON(out, saved)
	default:
		return errors.New("未知工作流 v2 管理操作")
	}
}

type workflowV2DesktopInput struct {
	DefinitionID string `json:"definition_id,omitempty"`
	RunID        string `json:"run_id,omitempty"`
	ProjectID    string `json:"project_id,omitempty"`
	RetryWrites  bool   `json:"retry_writes"`
}

func executeWorkflowV2Desktop(ctx context.Context, s *store.Store, service *operate.Service, workspace *code.Workspace, in workflowV2DesktopInput, approve func(string, string, string) (bool, error), report workflow.Reporter, runtimes ...workflowV2ToolRuntime) (store.WorkflowV2Run, error) {
	if service == nil {
		return store.WorkflowV2Run{}, store.ErrNoCurrentLake
	}
	var saved store.WorkflowV2Definition
	var err error
	name := ""
	verb := "run"
	if in.RunID != "" {
		run, e := s.GetWorkflowV2Run(ctx, in.RunID)
		if e != nil {
			return run, e
		}
		if run.LakeID != service.Lake.ID {
			return run, errors.New("运行不属于当前湖")
		}
		name = run.Name
		verb = "resume"
	} else {
		saved, err = resolveWorkflowV2(ctx, s, service.Lake.ID, in.DefinitionID)
		if err != nil {
			return store.WorkflowV2Run{}, err
		}
		name = saved.Name
		compiled, _, err := parseWorkflowV2Tool(string(saved.Spec))
		if err != nil {
			return store.WorkflowV2Run{}, err
		}
		if _, err := previewWorkflowV2(ctx, s, service.Lake.ID, compiled); err != nil {
			return store.WorkflowV2Run{}, err
		}
	}
	detail, _ := json.Marshal(in)
	if err := authorizeToolAction(ctx, service.Lake.ID, "", "lake_workflow_v2_"+verb, "workflow", name, "workflow", string(detail), approve); err != nil {
		return store.WorkflowV2Run{}, err
	}
	ssh, err := operate.NewServiceForLake(ctx, s, service.Lake.Name)
	if err != nil {
		return store.WorkflowV2Run{}, err
	}
	defer ssh.CloseSessions()
	ssh.Confirm = service.Confirm
	ssh.Anchors = map[string]struct{}{}
	for id := range service.Anchors {
		ssh.Anchors[id] = struct{}{}
	}
	executor := &workflowV2Executor{store: s, service: ssh, workspace: workspace, projectID: in.ProjectID, approve: approve, report: report, retryWrites: in.RetryWrites}
	if len(runtimes) > 0 {
		executor.model = runtimes[0].Model
		executor.modelID = runtimes[0].ModelID
	}
	defer executor.Close()
	var approval workflow.ApprovalV2
	if approve != nil {
		approval = func(_ context.Context, node workflow.NodeV2, input json.RawMessage) (bool, error) {
			return approve("workflow", service.Lake.Name+"/"+node.ID, fmt.Sprintf("节点 %s (%s)\n%s", node.ID, node.Kind, input))
		}
	}
	if in.RunID != "" {
		return workflow.ResumeV2(ctx, s, in.RunID, in.RetryWrites, executor, approval)
	}
	return workflow.StartV2(ctx, s, saved, "desktop", executor, approval)
}
