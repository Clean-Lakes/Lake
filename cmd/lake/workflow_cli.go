package main

import (
	"bufio"
	"bytes"
	"context"
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

func workflowCommand(ctx context.Context, s *store.Store, args []string, in io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("需要工作流命令：validate、dry-run、save、amend、add、update、list、show、plan、run、runs、status、events、resume、enable、disable")
	}
	if args[0] == "manage" {
		if len(args) != 1 {
			return errors.New("manage 通过 stdin 接受请求")
		}
		return workflowV2Manage(ctx, s, in, out)
	}
	verb := args[0]
	args = args[1:]
	if verb == "validate" || verb == "dry-run" || verb == "save" || verb == "amend" {
		return workflowV2FileCommand(ctx, s, verb, args, out, errOut)
	}
	if verb == "add" {
		if len(args) == 0 {
			return errors.New("workflow add 需要湖名")
		}
		lakeName := args[0]
		f := flags("lake workflow add", errOut)
		path := f.String("file", "", "工作流 JSON 定义")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *path == "" {
			return errors.New("用法：lake workflow add <湖名> --file 定义.json")
		}
		def, err := loadWorkflowDefinition(*path)
		if err != nil {
			return err
		}
		lake, err := s.GetLakeByName(ctx, lakeName)
		if err != nil {
			return err
		}
		if err := workflow.CheckTargets(ctx, s, lake.Name, def, nil, true); err != nil {
			return err
		}
		canonical, err := json.Marshal(def)
		if err != nil {
			return err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, lake.ID, "lake_workflow_create", lake.Name+"/"+def.Name, "cli", string(canonical)); err != nil {
			return err
		}
		item, err := s.CreateWorkflow(ctx, lakeName, def.Name, def.Description, canonical)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, item)
		}
		_, err = fmt.Fprintf(out, "已创建工作流 %s/%s（%s），共 %d 步\n", item.Lake, item.Name, item.ID, len(def.Steps))
		return err
	}
	if verb == "update" {
		if len(args) == 0 {
			return errors.New("workflow update 需要工作流 ID")
		}
		f := flags("lake workflow update", errOut)
		path := f.String("file", "", "更新后的完整工作流 JSON 定义")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || *path == "" {
			return errors.New("用法：lake workflow update <工作流ID> --file 定义.json")
		}
		item, err := s.GetWorkflow(ctx, args[0])
		if err != nil {
			return err
		}
		def, err := loadWorkflowDefinition(*path)
		if err != nil {
			return err
		}
		if err := workflow.CheckTargets(ctx, s, item.Lake, def, nil, true); err != nil {
			return err
		}
		canonical, err := json.Marshal(def)
		if err != nil {
			return err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, item.LakeID, "lake_workflow_update", item.Lake+"/"+item.Name, "cli", string(canonical)); err != nil {
			return err
		}
		updated, err := s.UpdateWorkflow(ctx, item.ID, def.Name, def.Description, canonical)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, updated)
		}
		_, err = fmt.Fprintf(out, "已更新工作流 %s/%s（%s），共 %d 步\n", updated.Lake, updated.Name, updated.ID, len(def.Steps))
		return err
	}
	if verb == "list" || verb == "runs" {
		f := flags("lake workflow "+verb, errOut)
		lakeName := f.String("lake", "", "湖名")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("参数过多")
		}
		if verb == "list" {
			items, err := s.ListWorkflows(ctx, *lakeName)
			if err != nil {
				return err
			}
			lakeID := ""
			if *lakeName != "" {
				lake, err := s.GetLakeByName(ctx, *lakeName)
				if err != nil {
					return err
				}
				lakeID = lake.ID
			}
			v2, err := s.ListWorkflowsV2(ctx, lakeID)
			if err != nil {
				return err
			}
			if *asJSON {
				combined := make([]any, 0, len(items)+len(v2))
				for _, item := range items {
					combined = append(combined, item)
				}
				for _, item := range v2 {
					combined = append(combined, item)
				}
				return writeJSON(out, combined)
			}
			for _, item := range items {
				fmt.Fprintf(out, "%s\t%s/%s\t启用=%t\n", item.ID, item.Lake, item.Name, item.Enabled)
			}
			for _, item := range v2 {
				fmt.Fprintf(out, "%s\tv2/%s\t版本=%d\t启用=%t\n", item.ID, item.Name, item.Revision, item.Enabled)
			}
			return nil
		}
		lakeID := ""
		if *lakeName != "" {
			lake, err := s.GetLakeByName(ctx, *lakeName)
			if err != nil {
				return err
			}
			lakeID = lake.ID
		}
		items, err := s.ListWorkflowRuns(ctx, lakeID, 30)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, items)
		}
		for _, item := range items {
			fmt.Fprintf(out, "%s\t%s\t%s\t%s\n", item.ID, item.Name, item.Status, item.CreatedAt.Local().Format("2006-01-02 15:04:05"))
		}
		return nil
	}
	if len(args) == 0 {
		return fmt.Errorf("workflow %s 需要 ID", verb)
	}
	id := args[0]
	f := flags("lake workflow "+verb, errOut)
	asJSON := f.Bool("json", false, "JSON 输出")
	resourceTarget := f.String("resource", "", "本次运行的单主机目标资源名")
	var planFromRun string
	if verb == "plan" {
		f.StringVar(&planFromRun, "from-run", "", "仅评估指定历史运行的原配置，不恢复或执行")
	}
	var bindings workflowBindings
	f.Var(&bindings, "bind", "资源映射，格式为 原资源名=当前湖资源名；可重复")
	var targets workflowTargets
	f.Var(&targets, "target", "多选工作流的本次目标资源名；可重复")
	retryWrites := f.Bool("retry-writes", false, "人工核对后重试可能已执行的 SSH 命令")
	projectID := f.String("project", "", "工作流 v2 代码专员使用的已登记项目 ID")
	force := f.Bool("force", false, "确认原执行进程已退出")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("参数过多")
	}
	switch verb {
	case "plan":
		item, err := s.GetWorkflow(ctx, id)
		if err != nil {
			return err
		}
		var def workflow.Definition
		source := item.Spec
		if planFromRun != "" {
			run, err := s.GetWorkflowRun(ctx, planFromRun)
			if err != nil {
				return err
			}
			if run.WorkflowID != item.ID {
				return errors.New("评估来源不属于当前工作流")
			}
			source = run.Spec
		}
		if err := json.Unmarshal(source, &def); err != nil {
			return err
		}
		def, err = workflow.BindTargets(def, *resourceTarget, bindings, targets)
		if err != nil {
			return err
		}
		if def.ExecutionMode == "fixed" {
			return writeJSON(out, workflow.PlanningReview{Status: "unchanged", Message: "固定执行模式，沿用原计划"})
		}
		history, err := s.ListWorkflowHistory(ctx, item.ID, "", 5)
		if err != nil {
			return err
		}
		runtime := &workflowV2Executor{store: s}
		defer runtime.Close()
		executor := &workflowAdaptiveExecutor{runtime: runtime}
		proposal, err := executor.PlanWorkflow(ctx, def, history)
		if err != nil {
			return err
		}
		_, review, err := workflow.ApplyPlan(def, proposal)
		if err != nil {
			return err
		}
		return writeJSON(out, review)
	case "show":
		if item, found, err := getWorkflowV2IfPresent(ctx, s, id); err != nil {
			return err
		} else if found {
			if *asJSON {
				return writeJSON(out, item)
			}
			_, err = fmt.Fprintf(out, "v2 %s（%s），版本 %d\n%s\n", item.Name, item.ID, item.Revision, item.Spec)
			return err
		}
		item, err := s.GetWorkflow(ctx, id)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, item)
		}
		_, err = fmt.Fprintf(out, "%s/%s（%s）\n%s\n%s\n", item.Lake, item.Name, item.ID, item.Description, item.Spec)
		return err
	case "enable", "disable":
		current, err := s.GetWorkflow(ctx, id)
		if err != nil {
			return err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, current.LakeID, "lake_workflow_"+verb, current.Lake+"/"+current.Name, "cli", verb); err != nil {
			return err
		}
		item, err := s.SetWorkflowEnabled(ctx, id, verb == "enable")
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, item)
		}
		_, err = fmt.Fprintf(out, "%s：启用=%t\n", item.Name, item.Enabled)
		return err
	case "status":
		if run, found, err := getWorkflowV2RunIfPresent(ctx, s, id); err != nil {
			return err
		} else if found {
			if *asJSON {
				return writeJSON(out, run)
			}
			fmt.Fprintf(out, "v2 %s（%s）：%s\n", run.Name, run.ID, run.Status)
			for _, node := range run.Nodes {
				fmt.Fprintf(out, "%s\t%s\t%s\n", node.NodeID, node.Status, node.ErrorCode)
			}
			return nil
		}
		run, err := s.GetWorkflowRun(ctx, id)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, run)
		}
		_, err = io.WriteString(out, workflow.Summarize(run))
		return err
	case "recover":
		if !*force {
			return errors.New("请确认原执行进程已退出，再使用 --force 标记中断")
		}
		prior, err := s.GetWorkflowRun(ctx, id)
		if err != nil {
			return err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, prior.LakeID, "lake_workflow_recover", prior.LakeID+"/"+prior.Name, "cli", id); err != nil {
			return err
		}
		if err := s.RecoverWorkflowRun(ctx, id); err != nil {
			return err
		}
		run, err := s.GetWorkflowRun(ctx, id)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, run)
		}
		_, err = io.WriteString(out, workflow.Summarize(run))
		return err
	case "events":
		if _, found, err := getWorkflowV2RunIfPresent(ctx, s, id); err != nil {
			return err
		} else if found {
			events, err := s.ListWorkflowV2Events(ctx, id)
			if err != nil {
				return err
			}
			if *asJSON {
				return writeJSON(out, events)
			}
			for _, event := range events {
				fmt.Fprintf(out, "%d\t%s\t%s\t%s\n", event.Sequence, event.NodeID, event.Kind, event.Payload)
			}
			return nil
		}
		if _, err := s.GetWorkflowRun(ctx, id); err != nil {
			return err
		}
		events, err := s.ListWorkflowEvents(ctx, id)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, events)
		}
		for _, event := range events {
			fmt.Fprintf(out, "%s\t%s\t%s\t%s\n", event.Timestamp.Local().Format("2006-01-02 15:04:05"), event.StepID, event.Status, event.Message)
		}
		return nil
	case "run", "resume":
		if verb == "run" {
			if item, found, err := getWorkflowV2IfPresent(ctx, s, id); err != nil {
				return err
			} else if found {
				if *resourceTarget != "" || len(bindings) != 0 || len(targets) != 0 {
					return errors.New("工作流 v2 的目标由节点定义，请勿使用 v1 资源绑定参数")
				}
				return workflowV2RunCLI(ctx, s, item, "", false, *projectID, in, out, errOut, *asJSON)
			}
		} else {
			if run, found, err := getWorkflowV2RunIfPresent(ctx, s, id); err != nil {
				return err
			} else if found {
				if *resourceTarget != "" || len(bindings) != 0 || len(targets) != 0 {
					return errors.New("恢复工作流 v2 不接受资源绑定")
				}
				return workflowV2RunCLI(ctx, s, store.WorkflowV2Definition{}, run.ID, *retryWrites, *projectID, in, out, errOut, *asJSON)
			}
		}
		if verb == "resume" && (*resourceTarget != "" || len(bindings) != 0 || len(targets) != 0) {
			return errors.New("恢复运行沿用原运行快照，不接受新的资源绑定")
		}
		var item store.WorkflowDefinition
		var err error
		if verb == "run" {
			item, err = s.GetWorkflow(ctx, id)
		} else {
			prior, loadErr := s.GetWorkflowRun(ctx, id)
			if loadErr != nil {
				return loadErr
			}
			item, err = s.GetWorkflow(ctx, prior.WorkflowID)
		}
		if err != nil {
			return err
		}
		if verb == "run" {
			var saved workflow.Definition
			if err := json.Unmarshal(item.Spec, &saved); err != nil {
				return err
			}
			resolved, err := workflow.BindTargets(saved, *resourceTarget, bindings, targets)
			if err != nil {
				return err
			}
			if err := workflow.CheckTargets(ctx, s, item.Lake, resolved, nil, false); err != nil {
				return err
			}
		}
		proposal, err := json.Marshal(map[string]any{"workflow_id": item.ID, "resource": *resourceTarget, "bindings": bindings, "targets": targets, "retry_writes": *retryWrites})
		if err != nil {
			return err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, item.LakeID, "lake_workflow_"+verb, item.Lake+"/"+item.Name, "cli", string(proposal)); err != nil {
			return err
		}
		service, err := operate.NewServiceForLake(ctx, s, item.Lake)
		if err != nil {
			return err
		}
		defer service.CloseSessions()
		var promptMu sync.Mutex
		scanner := bufio.NewScanner(in)
		service.Confirm = func(_ context.Context, path, command string) (bool, error) {
			promptMu.Lock()
			defer promptMu.Unlock()
			file, ok := in.(*os.File)
			if !ok || !term.IsTerminal(int(file.Fd())) {
				return false, nil
			}
			fmt.Fprintf(errOut, "SSH 操作 %s：\n%s\n输入 yes 批准：", path, command)
			if !scanner.Scan() {
				return false, scanner.Err()
			}
			return strings.TrimSpace(scanner.Text()) == "yes", nil
		}
		report := func(progress workflow.Progress) {
			if !*asJSON {
				fmt.Fprintf(errOut, "工作流 %s：%d/%d %s %s\n", progress.Name, progress.Completed, progress.Total, progress.StepID, progress.StepStatus)
			}
		}
		var result store.WorkflowRun
		var snapshot workflow.Definition
		if verb == "run" {
			_ = json.Unmarshal(item.Spec, &snapshot)
		} else {
			prior, _ := s.GetWorkflowRun(ctx, id)
			_ = json.Unmarshal(prior.Spec, &snapshot)
		}
		recovery := &workflowV2Executor{store: s, service: service, approve: func(_ string, path, detail string) (bool, error) { return service.Confirm(ctx, path, detail) }}
		defer recovery.Close()
		executor := &workflowAdaptiveExecutor{Service: service, runtime: recovery, definition: snapshot, report: report}
		if verb == "run" {
			resolved, bindErr := workflow.BindTargets(snapshot, *resourceTarget, bindings, targets)
			if bindErr != nil {
				return bindErr
			}
			executor.definition = resolved
			result, err = workflow.StartWithTargets(ctx, s, item, "cli", *resourceTarget, bindings, targets, executor, report)
		} else {
			result, err = workflow.Resume(ctx, s, id, *retryWrites, executor, report)
		}
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, result)
		}
		_, err = io.WriteString(out, workflow.Summarize(result))
		return err
	default:
		return fmt.Errorf("未知工作流命令 %q", verb)
	}
}

type workflowBindings map[string]string

type workflowTargets []string

func (t *workflowTargets) String() string {
	if t == nil {
		return ""
	}
	return strings.Join(*t, ",")
}

func (t *workflowTargets) Set(value string) error {
	if value == "" {
		return errors.New("--target 需要资源名")
	}
	*t = append(*t, value)
	return nil
}

func (b *workflowBindings) String() string {
	if b == nil {
		return ""
	}
	parts := make([]string, 0, len(*b))
	for key, value := range *b {
		parts = append(parts, key+"="+value)
	}
	return strings.Join(parts, ",")
}

func (b *workflowBindings) Set(value string) error {
	key, target, ok := strings.Cut(value, "=")
	if !ok || key == "" || target == "" {
		return errors.New("--bind 需要 原资源名=目标资源名")
	}
	if *b == nil {
		*b = make(workflowBindings)
	}
	if _, exists := (*b)[key]; exists {
		return fmt.Errorf("资源绑定 %q 重复", key)
	}
	(*b)[key] = target
	return nil
}

func loadWorkflowDefinition(path string) (workflow.Definition, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return workflow.Definition{}, err
	}
	if len(body) > 64*1024 {
		return workflow.Definition{}, errors.New("工作流定义文件超过 64 KiB")
	}
	var def workflow.Definition
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&def); err != nil {
		return workflow.Definition{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return workflow.Definition{}, errors.New("工作流定义只能包含一个 JSON 对象")
	}
	if err := workflow.Validate(def); err != nil {
		return workflow.Definition{}, err
	}
	return def, nil
}
