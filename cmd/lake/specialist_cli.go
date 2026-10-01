package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent/specialist"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/code/remote"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"golang.org/x/term"
)

type specialistResumeInput struct {
	TaskID      string `json:"task_id"`
	RetryWrites bool   `json:"retry_writes"`
}

func resumeSpecialist(ctx context.Context, s *store.Store, service *operate.Service, workspace *code.Workspace, in specialistResumeInput, approve func(string, string, string) (bool, error)) (string, error) {
	state, err := specialist.LoadCheckpoint(s.Root(), in.TaskID)
	if err != nil {
		return "", err
	}
	task, err := s.GetSpecialistTask(ctx, in.TaskID)
	if err != nil {
		return "", err
	}
	if task.Name == "lake_workflow_recovery_agent" {
		return "", fmt.Errorf("该专员属于工作流步骤，请从工作流运行 %s 核对实际结果后恢复", strings.Split(task.ParentRunID, "/adaptive/")[0])
	}
	if service == nil || state.Prepared.Scope.LakeID != service.Lake.ID {
		return "", errors.New("专员任务不属于当前湖")
	}
	if state.Prepared.Scope.ProjectRoot != "" && (workspace == nil || workspace.Root != state.Prepared.Scope.ProjectRoot) {
		return "", errors.New("恢复需要绑定任务原来的代码项目")
	}
	if err := authorizeToolAction(ctx, service.Lake.ID, state.Prepared.Scope.ProjectRoot, "lake_specialist_resume", "workflow", task.Name, "workflow", fmt.Sprintf("task=%s retry_writes=%t", task.ID, in.RetryWrites), approve); err != nil {
		return "", err
	}
	ssh, err := operate.NewServiceForLake(ctx, s, service.Lake.Name)
	if err != nil {
		return "", err
	}
	defer ssh.CloseSessions()
	ssh.Confirm = service.Confirm
	ssh.Anchors = map[string]struct{}{}
	for _, id := range state.Prepared.Scope.ResourceIDs {
		if _, ok := service.Anchors[id]; ok {
			ssh.Anchors[id] = struct{}{}
		}
	}
	execution := specialistExecution{Root: s.Root(), LakeID: service.Lake.ID, SessionID: task.ParentRunID, ConversationID: task.ConversationID, ModelID: task.Model, Store: s}
	var candidate tool.BaseTool
	if strings.HasPrefix(task.Name, "lake_specialist_") {
		extras, cleanup, _ := loadMCPTools(ctx, s.Root(), approve, service.Lake.ID)
		defer cleanup()
		candidates, err := customSpecialists(ctx, execution, ssh, workspace, approve, extras)
		if err != nil {
			return "", err
		}
		for _, c := range candidates {
			info, _ := c.Info(ctx)
			if info.Name == task.Name {
				candidate = c
				break
			}
		}
	} else {
		instance, cleanup, err := specialistModel(s.Root(), task.Model)
		if err != nil {
			return "", err
		}
		defer cleanup()
		switch task.Name {
		case "lake_code_agent":
			isRemote := false
			for _, name := range state.Prepared.Scope.ToolNames {
				if strings.HasPrefix(name, "lake_remote_code_") {
					isRemote = true
				}
			}
			if isRemote {
				conversation, e := s.GetConversation(ctx, task.ConversationID)
				if e != nil {
					return "", e
				}
				bound, e := s.GetCodeWorkspace(ctx, conversation.RemoteWorkspaceID)
				if e != nil {
					return "", e
				}
				candidate, err = newRemoteCodeAgentTool(ctx, instance, bound, remote.Service{Store: s, Approve: approve, Origin: "model", Actor: "agent", RunID: task.ParentRunID}, execution)
			} else {
				if workspace == nil {
					return "", errors.New("未绑定代码项目")
				}
				candidate, err = newCodeAgentTool(ctx, instance, workspace, approve, execution)
			}
		case "lake_ssh_agent":
			candidate, err = newSSHAgentTool(ctx, instance, ssh, execution)
		default:
			return "", errors.New("该专员的恢复适配器不可用")
		}
		if err != nil {
			return "", err
		}
	}
	if candidate == nil {
		return "", errors.New("专员当前已停用或配置范围不可用")
	}
	resumable, ok := candidate.(interface {
		Resume(context.Context, string, bool) (string, error)
	})
	if !ok {
		return "", errors.New("该专员没有恢复能力")
	}
	return resumable.Resume(ctx, task.ID, in.RetryWrites)
}
func specialistCommand(ctx context.Context, s *store.Store, args []string, input io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("用法：lake specialist list|configure|tasks|status|run|resume")
	}
	if args[0] == "configure" {
		return settingsCommand(s.Root(), input, out)
	}
	if args[0] == "list" {
		cfg, err := readLakeSettings(s.Root())
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(cfg.Specialists)
	}
	if args[0] == "tasks" {
		items, err := s.RecentSpecialistTasks(ctx)
		if err != nil {
			return err
		}
		type view struct {
			store.SpecialistTask
			CheckpointAvailable bool   `json:"checkpoint_available"`
			ResumeAvailable     bool   `json:"resume_available"`
			WorkflowRunID       string `json:"workflow_run_id,omitempty"`
		}
		views := make([]view, 0, len(items))
		for _, task := range items {
			_, err := specialist.LoadCheckpoint(s.Root(), task.ID)
			item := view{SpecialistTask: task, CheckpointAvailable: err == nil, ResumeAvailable: err == nil}
			if task.Name == "lake_workflow_recovery_agent" {
				item.ResumeAvailable = false
				item.WorkflowRunID = strings.Split(task.ParentRunID, "/adaptive/")[0]
			}
			views = append(views, item)
		}
		return json.NewEncoder(out).Encode(views)
	}
	if args[0] == "status" && len(args) == 2 {
		item, err := s.GetSpecialistTask(ctx, args[1])
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(item)
	}
	if (args[0] != "run" && args[0] != "resume") || len(args) < 2 {
		return errors.New("用法：lake specialist run <专员名> --request-file 文件 [--lake 湖名] [--project 项目ID]；resume <任务ID> [--retry-writes]")
	}
	f := flags("lake specialist "+args[0], errOut)
	lakeName := f.String("lake", "", "湖名")
	project := f.String("project", "", "项目ID")
	requestFile := f.String("request-file", "", "任务文本文件")
	retry := f.Bool("retry-writes", false, "核对后允许未知写重试")
	if err := f.Parse(args[2:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("专员参数过多")
	}
	var lake store.Lake
	var err error
	if *lakeName != "" {
		lake, err = s.GetLakeByName(ctx, *lakeName)
	} else {
		lake, err = s.CurrentLake(ctx)
	}
	if err != nil {
		return err
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		return err
	}
	defer service.CloseSessions()
	var approve func(string, string, string) (bool, error)
	if file, ok := input.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		scanner := bufio.NewScanner(input)
		approve = func(kind, path, detail string) (bool, error) {
			fmt.Fprintf(errOut, "%s %s\n%s\n输入 yes 批准：", kind, path, detail)
			if !scanner.Scan() {
				return false, scanner.Err()
			}
			return strings.TrimSpace(scanner.Text()) == "yes", nil
		}
	}
	service.Confirm = func(_ context.Context, path, command string) (bool, error) {
		if approve == nil {
			return false, nil
		}
		return approve("ssh", path, command)
	}
	executor := workflowV2Executor{store: s, service: service, projectID: *project, approve: approve}
	defer executor.Close()
	if args[0] == "resume" {
		state, err := specialist.LoadCheckpoint(s.Root(), args[1])
		if err != nil {
			return err
		}
		var workspace *code.Workspace
		if state.Prepared.Scope.ProjectRoot != "" {
			projects, err := s.ListCodeProjects(ctx)
			if err != nil {
				return err
			}
			for _, p := range projects {
				if p.LakeID == lake.ID && p.Path == state.Prepared.Scope.ProjectRoot && (*project == "" || p.ID == *project) {
					workspace, err = code.Open(p.Path)
					if err != nil {
						return err
					}
					break
				}
			}
		}
		output, err := resumeSpecialist(ctx, s, service, workspace, specialistResumeInput{TaskID: args[1], RetryWrites: *retry}, approve)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, output)
		return err
	}
	if *requestFile == "" {
		return errors.New("run 需要 --request-file")
	}
	body, err := os.ReadFile(*requestFile)
	if err != nil {
		return err
	}
	if len(body) == 0 || len(body) > 64*1024 {
		return errors.New("任务为空或过大")
	}
	executor.parentRunID, err = store.NewActionID()
	if err != nil {
		return err
	}
	result, err := executor.invokeSpecialist(ctx, args[1], string(body))
	if err != nil {
		return err
	}
	return json.NewEncoder(out).Encode(result)
}
