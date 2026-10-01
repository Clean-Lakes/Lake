package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
	"golang.org/x/term"
)

type workflowV2PreviewNode struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Target        string `json:"target,omitempty"`
	Permission    string `json:"permission"`
	ModelCalls    int    `json:"model_calls"`
	MaxCalls      int    `json:"max_calls"`
	CommandSHA256 string `json:"command_sha256,omitempty"`
}

type workflowV2Preview struct {
	Name                string                  `json:"name"`
	MaxParallel         int                     `json:"max_parallel"`
	MaxExpanded         int                     `json:"max_expanded"`
	EstimatedModelCalls int                     `json:"estimated_model_calls"`
	Nodes               []workflowV2PreviewNode `json:"nodes"`
}

func loadWorkflowV2(path string) (workflow.CompiledV2, json.RawMessage, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return workflow.CompiledV2{}, nil, err
	}
	def, err := workflow.ParseV2(body)
	if err != nil {
		return workflow.CompiledV2{}, nil, err
	}
	compiled, err := workflow.CompileV2(def)
	if err != nil {
		return workflow.CompiledV2{}, nil, err
	}
	canonical, err := json.Marshal(def)
	return compiled, canonical, err
}

func previewWorkflowV2(ctx context.Context, s *store.Store, lakeID string, compiled workflow.CompiledV2) (workflowV2Preview, error) {
	preview := workflowV2Preview{Name: compiled.Definition.Name, MaxParallel: compiled.MaxParallel, MaxExpanded: compiled.MaxExpanded, Nodes: make([]workflowV2PreviewNode, 0, len(compiled.Order))}
	lakeName := ""
	if lakeID != "" {
		lake, err := s.GetLake(ctx, lakeID)
		if err != nil {
			return preview, err
		}
		lakeName = lake.Name
	}
	for _, node := range compiled.Order {
		item := workflowV2PreviewNode{ID: node.ID, Kind: node.Kind, Permission: "read", MaxCalls: 1}
		if node.ForEach != nil {
			item.MaxCalls = node.ForEach.MaxItems
		}
		switch node.Kind {
		case "ssh_check", "ssh_command":
			item.Target = "<result reference>"
			if node.Target != nil && node.Target.Literal != nil {
				item.Target = node.Target.Literal.(string)
				if lakeID != "" {
					resource, err := s.ResolveResource(ctx, lakeName+"/"+item.Target)
					if err != nil {
						return preview, fmt.Errorf("节点 %q 的资源未登记: %w", node.ID, err)
					}
					if resource.LakeID != lakeID || resource.Kind != "host" {
						return preview, fmt.Errorf("节点 %q 的 SSH 目标不属于当前湖", node.ID)
					}
				}
			}
			if node.Kind == "ssh_command" {
				item.Permission = "write_approval"
				if node.Command != nil && node.Command.Literal != nil {
					item.CommandSHA256 = store.CommandSHA256(node.Command.Literal.(string))
				}
			}
		case "code_task":
			item.Target, item.Permission, item.ModelCalls = "<bound project>", "project_approval", item.MaxCalls
		case "specialist_task":
			item.Target, item.Permission, item.ModelCalls = node.Specialist, "specialist_approval", item.MaxCalls
		case "tool_call":
			item.Target, item.Permission = node.Tool, "tool_approval"
			if node.Tool == "lake_script_run" {
				item.Permission = "write_approval"
				values, err := workflowScriptInputs(node)
				if err != nil {
					return preview, fmt.Errorf("节点 %q: %w", node.ID, err)
				}
				if lakeID != "" {
					if err := validateWorkflowScriptNode(ctx, s, lakeID, node); err != nil {
						return preview, fmt.Errorf("节点 %q: %w", node.ID, err)
					}
				}
				item.Target = values["resource"]
				item.CommandSHA256 = values["sha256"]
			}
		}
		preview.EstimatedModelCalls += item.ModelCalls
		preview.Nodes = append(preview.Nodes, item)
	}
	return preview, nil
}

func validateWorkflowScriptNode(ctx context.Context, s *store.Store, lakeID string, node workflow.NodeV2) error {
	values, err := workflowScriptInputs(node)
	if err != nil {
		return err
	}
	script, body, err := s.ReadScript(ctx, values["id"])
	if err != nil {
		return err
	}
	defer clearBytes(body)
	if script.SHA256 != values["sha256"] {
		return errors.New("脚本哈希与保存版本不一致")
	}
	if ok, err := scriptInLake(ctx, s, lakeID, script); err != nil {
		return err
	} else if !ok {
		return errors.New("脚本不属于当前湖")
	}
	lake, err := s.GetLake(ctx, lakeID)
	if err != nil {
		return err
	}
	if strings.Contains(values["resource"], "/") {
		return errors.New("脚本目标只接受当前湖资源名")
	}
	resource, err := s.ResolveResource(ctx, lake.Name+"/"+values["resource"])
	if err != nil {
		return err
	}
	if resource.Kind != "host" || script.ResourceID != "" && script.ResourceID != resource.ID {
		return errors.New("脚本目标不匹配")
	}
	return nil
}

func workflowScriptInputs(node workflow.NodeV2) (map[string]string, error) {
	if node.OutputType != "object" || len(node.Inputs) != 3 {
		return nil, errors.New("脚本工具需要 object 输出及 id、resource、sha256 三个固定输入")
	}
	values := make(map[string]string, 3)
	for _, key := range []string{"id", "resource", "sha256"} {
		value, ok := node.Inputs[key]
		if !ok || value.Type != "string" || value.Ref != nil || value.Item || value.Literal == nil {
			return nil, errors.New("脚本 ID、目标和哈希必须是固定字符串")
		}
		text, ok := value.Literal.(string)
		if !ok || text == "" {
			return nil, errors.New("脚本输入无效")
		}
		values[key] = text
	}
	return values, nil
}

func workflowV2FileCommand(ctx context.Context, s *store.Store, verb string, args []string, out, errOut io.Writer) error {
	var identifier string
	if verb == "save" || verb == "amend" || verb == "dry-run" && len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		if len(args) == 0 {
			return fmt.Errorf("workflow %s 需要湖名或工作流 ID", verb)
		}
		identifier, args = args[0], args[1:]
	}
	f := flags("lake workflow "+verb, errOut)
	path := f.String("file", "", "工作流 v2 JSON/YAML 定义")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *path == "" || (verb == "save" || verb == "amend") && identifier == "" {
		return fmt.Errorf("workflow %s 参数无效；需要 --file", verb)
	}
	compiled, canonical, err := loadWorkflowV2(*path)
	if err != nil {
		return err
	}
	if verb == "validate" {
		if *asJSON {
			return writeJSON(out, compiled)
		}
		_, err = fmt.Fprintf(out, "定义有效：%s，%d 个节点，最多展开 %d 个，最大并行 %d\n", compiled.Definition.Name, len(compiled.Order), compiled.MaxExpanded, compiled.MaxParallel)
		return err
	}
	lakeID := ""
	if verb == "save" || verb == "dry-run" && identifier != "" {
		lake, err := s.GetLakeByName(ctx, identifier)
		if err != nil {
			return err
		}
		lakeID = lake.ID
	}
	var current store.WorkflowV2Definition
	if verb == "amend" {
		current, err = s.GetWorkflowV2(ctx, identifier)
		if err != nil {
			return err
		}
		lakeID = current.LakeID
	}
	preview, err := previewWorkflowV2(ctx, s, lakeID, compiled)
	if err != nil {
		return err
	}
	if verb == "dry-run" {
		if *asJSON {
			return writeJSON(out, preview)
		}
		fmt.Fprintf(out, "%s：最多展开 %d 项，并行 %d，估算模型调用 %d\n", preview.Name, preview.MaxExpanded, preview.MaxParallel, preview.EstimatedModelCalls)
		for _, node := range preview.Nodes {
			fmt.Fprintf(out, "%s\t%s\t目标=%s\t权限=%s\t模型调用=%d", node.ID, node.Kind, node.Target, node.Permission, node.ModelCalls)
			if node.CommandSHA256 != "" {
				fmt.Fprintf(out, "\t命令 SHA-256=%s", node.CommandSHA256)
			}
			fmt.Fprintln(out)
		}
		return nil
	}
	lake, err := s.GetLake(ctx, lakeID)
	if err != nil {
		return err
	}
	action := "lake_workflow_v2_save"
	if verb == "amend" {
		action = "lake_workflow_v2_amend"
	}
	// The approval record captures the exact definition revision and content.
	if err := authorizeDirectWorkflowAction(ctx, s, lakeID, action, lake.Name+"/"+compiled.Definition.Name, "cli", string(canonical)); err != nil {
		return err
	}
	var item store.WorkflowV2Definition
	if verb == "save" {
		item, err = s.CreateWorkflowV2(ctx, lakeID, compiled.Definition.Name, compiled.Definition.Description, canonical)
	} else {
		item, err = s.UpdateWorkflowV2(ctx, current.ID, compiled.Definition.Name, compiled.Definition.Description, canonical)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, item)
	}
	_, err = fmt.Fprintf(out, "已保存工作流 v2 %s/%s（%s），版本 %d\n", lake.Name, item.Name, item.ID, item.Revision)
	return err
}

func getWorkflowV2IfPresent(ctx context.Context, s *store.Store, id string) (store.WorkflowV2Definition, bool, error) {
	item, err := s.GetWorkflowV2(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return item, false, nil
	}
	return item, err == nil, err
}

func getWorkflowV2RunIfPresent(ctx context.Context, s *store.Store, id string) (store.WorkflowV2Run, bool, error) {
	item, err := s.GetWorkflowV2Run(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return item, false, nil
	}
	return item, err == nil, err
}

func workflowV2RunCLI(ctx context.Context, s *store.Store, saved store.WorkflowV2Definition, runID string, retryWrites bool, projectID string, in io.Reader, out, errOut io.Writer, asJSON bool) error {
	lakeID := saved.LakeID
	if runID != "" {
		prior, err := s.GetWorkflowV2Run(ctx, runID)
		if err != nil {
			return err
		}
		lakeID = prior.LakeID
		saved.ID, saved.Name, saved.Revision = prior.DefinitionID, prior.Name, prior.Revision
	}
	lake, err := s.GetLake(ctx, lakeID)
	if err != nil {
		return err
	}
	if runID == "" {
		var def workflow.DefinitionV2
		if err := json.Unmarshal(saved.Spec, &def); err != nil {
			return err
		}
		compiled, err := workflow.CompileV2(def)
		if err != nil {
			return err
		}
		if _, err := previewWorkflowV2(ctx, s, lakeID, compiled); err != nil {
			return err
		}
	}
	proposal, _ := json.Marshal(map[string]any{"definition_id": saved.ID, "run_id": runID, "revision": saved.Revision, "project_id": projectID, "retry_writes": retryWrites})
	verb := "run"
	if runID != "" {
		verb = "resume"
	}
	if err := authorizeDirectWorkflowAction(ctx, s, lakeID, "lake_workflow_v2_"+verb, lake.Name+"/"+saved.Name, "cli", string(proposal)); err != nil {
		return err
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		return err
	}
	defer service.CloseSessions()
	executor := &workflowV2Executor{store: s, service: service, projectID: projectID, retryWrites: retryWrites}
	defer executor.Close()
	var approve workflow.ApprovalV2
	if file, ok := in.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		var mu sync.Mutex
		scanner := bufio.NewScanner(in)
		ask := func(label string, detail []byte) (bool, error) {
			mu.Lock()
			defer mu.Unlock()
			digest := sha256.Sum256(detail)
			fmt.Fprintf(errOut, "%s，输入快照 SHA-256 %x；输入 yes 批准：", label, digest)
			if !scanner.Scan() {
				return false, scanner.Err()
			}
			return strings.TrimSpace(scanner.Text()) == "yes", nil
		}
		approve = func(_ context.Context, node workflow.NodeV2, input json.RawMessage) (bool, error) {
			return ask("工作流节点 "+node.ID+" ("+node.Kind+")", input)
		}
		service.Confirm = func(_ context.Context, path, command string) (bool, error) {
			return ask("SSH 命令 "+path, []byte(command))
		}
		executor.approve = func(kind, path, detail string) (bool, error) {
			return ask("专员操作 "+kind+" "+path, []byte(detail))
		}
	}
	var result store.WorkflowV2Run
	if runID == "" {
		result, err = workflow.StartV2(ctx, s, saved, "cli", executor, approve)
	} else {
		result, err = workflow.ResumeV2(ctx, s, runID, retryWrites, executor, approve)
	}
	if err != nil {
		return err
	}
	if asJSON {
		return writeJSON(out, result)
	}
	fmt.Fprintf(out, "v2 %s（%s）：%s\n", result.Name, result.ID, result.Status)
	for _, node := range result.Nodes {
		fmt.Fprintf(out, "%s\t%s\t%s\n", node.NodeID, node.Status, node.ErrorCode)
	}
	return nil
}
