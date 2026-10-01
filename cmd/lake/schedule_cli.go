package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/scheduler"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
)

func scheduleCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("lake schedule 需要 add/list/status/runs/stop/authorize/serve/install/uninstall")
	}
	verb := args[0]
	args = args[1:]
	switch verb {
	case "add":
		if len(args) == 0 {
			return errors.New("用法：lake schedule add <v2工作流ID> --at RFC3339 或 --cron 表达式")
		}
		id := args[0]
		f := flags("lake schedule add", errOut)
		at := f.String("at", "", "一次性 RFC3339 时间")
		cron := f.String("cron", "", "五字段 cron 表达式")
		tz := f.String("tz", "Local", "时区")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 || (*at == "") == (*cron == "") {
			return errors.New("必须且只能指定 --at 或 --cron")
		}
		kind, expr := "once", *at
		if *cron != "" {
			kind, expr = "cron", *cron
		}
		plan, err := scheduler.Parse(kind, expr, *tz)
		if err != nil {
			return err
		}
		next, err := plan.Next(time.Now())
		if err != nil {
			return err
		}
		def, err := s.GetWorkflowV2(ctx, id)
		if err != nil {
			return err
		}
		if err := authorizeDirectWorkflowAction(ctx, s, def.LakeID, "lake_schedule_add", def.Name, "cli", fmt.Sprintf("workflow=%s revision=%d kind=%s expression=%s timezone=%s", id, def.Revision, kind, expr, *tz)); err != nil {
			return err
		}
		item, err := s.CreateSchedule(ctx, id, kind, expr, *tz, next)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, item)
		}
		_, err = fmt.Fprintf(out, "计划 %s，下次运行 %s\n", item.ID, next.Local().Format(time.RFC3339))
		return err
	case "list":
		f := flags("lake schedule list", errOut)
		lakeName := f.String("lake", "", "湖名")
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("参数过多")
		}
		lakeID := ""
		if *lakeName != "" {
			lake, err := s.GetLakeByName(ctx, *lakeName)
			if err != nil {
				return err
			}
			lakeID = lake.ID
		}
		items, err := s.ListSchedules(ctx, lakeID)
		if err != nil {
			return err
		}
		if *asJSON {
			return writeJSON(out, items)
		}
		for _, item := range items {
			fmt.Fprintf(out, "%s\t%s\t%s\t启用=%t\n", item.ID, item.Kind, item.Expression, item.Enabled)
		}
		return nil
	case "status", "runs", "stop", "authorize":
		if len(args) == 0 {
			return errors.New("需要计划 ID")
		}
		id := args[0]
		if verb == "authorize" {
			return scheduleAuthorize(ctx, s, id, args[1:], out, errOut)
		}
		f := flags("lake schedule "+verb, errOut)
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("参数过多")
		}
		item, err := s.GetSchedule(ctx, id)
		if err != nil {
			return err
		}
		if verb == "stop" {
			if err := authorizeDirectWorkflowAction(ctx, s, item.LakeID, "lake_schedule_stop", item.ID, "cli", item.ID); err != nil {
				return err
			}
			item, err = s.SetScheduleEnabled(ctx, id, false)
			if err != nil {
				return err
			}
		}
		if verb == "runs" {
			runs, err := s.ListScheduleRuns(ctx, id)
			if err != nil {
				return err
			}
			if *asJSON {
				return writeJSON(out, runs)
			}
			for _, run := range runs {
				fmt.Fprintf(out, "%s\t%s\t%s\n", run.ID, run.Status, run.DueAt.Local().Format(time.RFC3339))
			}
			return nil
		}
		if *asJSON {
			return writeJSON(out, item)
		}
		_, err = fmt.Fprintf(out, "%s\t%s\t启用=%t\t失败=%d\t下次=%v\n", item.ID, item.Kind, item.Enabled, item.FailCount, item.NextAt)
		return err
	case "serve":
		if len(args) != 0 {
			return errors.New("serve 不接受参数")
		}
		return scheduleServe(ctx, s, errOut)
	case "install":
		if len(args) != 0 {
			return errors.New("install 不接受参数")
		}
		return installScheduleLaunchAgent(s.Root(), out)
	case "uninstall":
		if len(args) != 0 {
			return errors.New("uninstall 不接受参数")
		}
		return uninstallScheduleLaunchAgent(out)
	default:
		return fmt.Errorf("未知计划命令 %q", verb)
	}
}

func scheduleAuthorize(ctx context.Context, s *store.Store, id string, args []string, out, errOut io.Writer) error {
	f := flags("lake schedule authorize", errOut)
	nodeID := f.String("node", "", "SSH 写节点 ID")
	resourceName := f.String("resource", "", "当前湖资源名")
	digest := f.String("command-sha256", "", "精确命令 SHA-256")
	expiry := f.String("expires", "", "RFC3339 到期时间")
	maxRuns := f.Int("max-runs", 1, "最多运行次数")
	asJSON := f.Bool("json", false, "JSON 输出")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *nodeID == "" || *resourceName == "" || *digest == "" || *expiry == "" {
		return errors.New("authorize 需要 --node、--resource、--command-sha256、--expires")
	}
	item, err := s.GetSchedule(ctx, id)
	if err != nil {
		return err
	}
	def, err := s.GetWorkflowV2(ctx, item.WorkflowID)
	if err != nil {
		return err
	}
	if def.Revision != item.WorkflowRevision {
		return errors.New("计划工作流版本已变化")
	}
	var spec workflow.DefinitionV2
	if err := json.Unmarshal(def.Spec, &spec); err != nil {
		return err
	}
	matched := false
	for _, node := range spec.Nodes {
		if node.ID != *nodeID {
			continue
		}
		if node.Kind != "ssh_command" || node.ForEach != nil || node.Target == nil || node.Target.Literal != *resourceName || node.Command == nil || node.Command.Literal == nil {
			return errors.New("计划授权仅支持目标和命令均固定的单项 SSH 写节点")
		}
		command, ok := node.Command.Literal.(string)
		if !ok || store.CommandSHA256(command) != *digest {
			return errors.New("命令哈希与当前工作流版本不一致")
		}
		matched = true
		break
	}
	if !matched {
		return errors.New("工作流没有该节点")
	}
	lake, err := s.GetLake(ctx, item.LakeID)
	if err != nil {
		return err
	}
	resource, err := s.ResolveResource(ctx, lake.Name+"/"+*resourceName)
	if err != nil {
		return err
	}
	until, err := time.Parse(time.RFC3339, *expiry)
	if err != nil || !until.After(time.Now()) {
		return errors.New("授权到期时间无效")
	}
	if err := authorizeDirectWorkflowAction(ctx, s, item.LakeID, "lake_schedule_authorize", lake.Name+"/"+*resourceName, "cli", fmt.Sprintf("schedule=%s revision=%d node=%s resource_id=%s command_sha256=%s expires=%s max_runs=%d", id, item.WorkflowRevision, *nodeID, resource.ID, *digest, until.Format(time.RFC3339), *maxRuns)); err != nil {
		return err
	}
	grant, err := s.CreateScheduleGrant(ctx, id, *nodeID, resource.ID, *digest, until, *maxRuns)
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, grant)
	}
	_, err = fmt.Fprintf(out, "已授权节点 %s，哈希 %s，最多 %d 次\n", *nodeID, *digest, *maxRuns)
	return err
}

func scheduleServe(ctx context.Context, s *store.Store, errOut io.Writer) error {
	owner, err := store.NewActionID()
	if err != nil {
		return err
	}
	runner := scheduler.Runner{Store: s, Owner: owner, Execute: func(callCtx context.Context, item store.Schedule, run store.ScheduleRun) (string, string, string, error) {
		return executeSchedule(callCtx, s, item, run)
	}}
	tick := func() {
		for i := 0; i < 32; i++ {
			ran, err := runner.RunOne(ctx, time.Now())
			if err != nil {
				fmt.Fprintf(errOut, "调度运行失败: %v\n", err)
				return
			}
			if !ran {
				return
			}
		}
	}
	tick()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			tick()
		}
	}
}

func executeSchedule(ctx context.Context, s *store.Store, item store.Schedule, run store.ScheduleRun) (string, string, string, error) {
	def, err := s.GetWorkflowV2(ctx, item.WorkflowID)
	if err != nil {
		return "", "missed", "definition_missing", nil
	}
	if def.Revision != item.WorkflowRevision || !def.Enabled {
		_, _ = s.SetScheduleEnabled(ctx, item.ID, false)
		return "", "missed", "definition_changed", nil
	}
	lake, err := s.GetLake(ctx, item.LakeID)
	if err != nil {
		return "", "failed", "lake_missing", err
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		return "", "failed", "service_error", err
	}
	defer service.CloseSessions()
	executor := &workflowV2Executor{store: s, service: service}
	defer executor.Close()
	var mu sync.Mutex
	approved := make(map[string]int)
	service.Confirm = func(_ context.Context, path, command string) (bool, error) {
		mu.Lock()
		defer mu.Unlock()
		key := path + "\x00" + store.CommandSHA256(command)
		if approved[key] < 1 {
			return false, nil
		}
		approved[key]--
		return true, nil
	}
	approval := func(callCtx context.Context, node workflow.NodeV2, input json.RawMessage) (bool, error) {
		if node.Kind != "ssh_command" {
			return false, workflow.ErrApprovalPending
		}
		var snapshot struct {
			Calls []struct {
				Target  string `json:"target"`
				Command string `json:"command"`
			} `json:"calls"`
		}
		if err := json.Unmarshal(input, &snapshot); err != nil || len(snapshot.Calls) == 0 {
			return false, workflow.ErrApprovalPending
		}
		uses := make([]store.ScheduleGrantUse, 0, len(snapshot.Calls))
		keys := make([]string, 0, len(snapshot.Calls))
		for _, call := range snapshot.Calls {
			if strings.Contains(call.Target, "/") || call.Target == "" || call.Command == "" {
				return false, workflow.ErrApprovalPending
			}
			resource, err := s.ResolveResource(callCtx, lake.Name+"/"+call.Target)
			if err != nil || !resource.ExecuteAuthz || resource.Kind != "host" {
				return false, workflow.ErrApprovalPending
			}
			uses = append(uses, store.ScheduleGrantUse{NodeID: node.ID, ResourceID: resource.ID, CommandSHA256: store.CommandSHA256(call.Command)})
			keys = append(keys, lake.Name+"/"+call.Target+"\x00"+store.CommandSHA256(call.Command))
		}
		if err := s.ConsumeScheduleGrants(callCtx, item.ID, item.WorkflowRevision, uses, time.Now()); err != nil {
			return false, workflow.ErrApprovalPending
		}
		mu.Lock()
		for _, key := range keys {
			approved[key]++
		}
		mu.Unlock()
		return true, nil
	}
	result, err := workflow.StartV2(ctx, s, def, "schedule", executor, approval)
	if err != nil {
		if scheduleHasWrite(def.Spec) {
			_, _ = s.SetScheduleEnabled(ctx, item.ID, false)
		}
		return result.ID, "failed", "workflow_error", err
	}
	status := result.Status
	if status == "failed" && scheduleHasWrite(def.Spec) {
		_, _ = s.SetScheduleEnabled(ctx, item.ID, false)
	}
	if status != "completed" && status != "failed" && status != "waiting_approval" && status != "interrupted" {
		status = "unknown"
	}
	if status == "interrupted" {
		status = "unknown"
	}
	return result.ID, status, "", nil
}

func scheduleHasWrite(spec json.RawMessage) bool {
	var def workflow.DefinitionV2
	if err := json.Unmarshal(spec, &def); err != nil {
		return true
	}
	for _, node := range def.Nodes {
		if node.Kind != "ssh_check" {
			return true
		}
	}
	return false
}
