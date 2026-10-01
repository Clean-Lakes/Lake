package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"golang.org/x/term"
)

func scriptJobCommand(ctx context.Context, s *store.Store, args []string, in io.Reader, out, errOut io.Writer) error {
	if len(args) < 2 {
		return errors.New("用法：lake script start <脚本ID> | status/wait/cancel <任务ID> | jobs <湖名>")
	}
	verb, id := args[0], args[1]
	f := flags("lake script "+verb, errOut)
	target := f.String("resource", "", "启动目标 湖/资源")
	timeout := f.Int("timeout", 1800, "任务最长秒数，1–86400")
	seconds := f.Int("seconds", 60, "单次等待秒数，1–60")
	asJSON := f.Bool("json", false, "JSON输出")
	if err := f.Parse(args[2:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("参数过多")
	}
	if verb == "jobs" {
		lake, err := s.GetLakeByName(ctx, id)
		if err != nil {
			return err
		}
		jobs, err := s.ListScriptJobs(lake.ID)
		if err != nil {
			return err
		}
		return writeJSON(out, jobs)
	}
	var resource store.Resource
	var script store.Script
	var err error
	if verb == "start" {
		script, err = s.GetScript(ctx, id)
		if err != nil {
			return err
		}
		if *target != "" {
			resource, err = s.ResolveResource(ctx, *target)
		} else if script.ResourceID != "" {
			resource, err = s.GetResource(ctx, script.ResourceID)
		} else {
			return errors.New("湖级脚本需要 --resource 湖/主机")
		}
	} else {
		job, e := s.GetScriptJob(id)
		if e != nil {
			return e
		}
		resource, err = s.GetResource(ctx, job.ResourceID)
	}
	if err != nil {
		return err
	}
	lake, err := s.GetLake(ctx, resource.LakeID)
	if err != nil {
		return err
	}
	service, err := operate.NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		return err
	}
	defer service.CloseSessions()
	if file, ok := in.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		scanner := bufio.NewScanner(in)
		service.Confirm = func(_ context.Context, path, summary string) (bool, error) {
			fmt.Fprintf(errOut, "SSH 长任务 %s：%s\n输入 yes 批准：", path, summary)
			if !scanner.Scan() {
				return false, scanner.Err()
			}
			return strings.TrimSpace(scanner.Text()) == "yes", nil
		}
	}
	var value operate.ScriptJobStatus
	switch verb {
	case "start":
		value, err = service.StartScriptJob(ctx, resource.Name, script.ID, script.SHA256, *timeout, "")
	case "status":
		value, err = service.ScriptJobStatus(ctx, id)
	case "wait":
		value, err = service.WaitScriptJob(ctx, id, *seconds, nil)
	case "cancel":
		value, err = service.CancelScriptJob(ctx, id)
	default:
		return errors.New("未知长任务命令")
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return writeJSON(out, value)
	}
	_, err = fmt.Fprintf(out, "任务 %s · %s · %.0f 秒\n%s%s\n", value.Job.ID, value.Status, value.ElapsedSeconds, value.StdoutTail, value.StderrTail)
	return err
}
