package main

import (
	"context"
	"fmt"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
)

type scriptStartInput struct {
	ID             string `json:"id" jsonschema:"description=已登记脚本ID"`
	Resource       string `json:"resource" jsonschema:"description=当前湖SSH资源名"`
	SHA256         string `json:"sha256" jsonschema:"description=已核对脚本SHA256"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty" jsonschema:"description=远端任务最长运行秒数，默认1800，最大86400"`
}
type scriptJobInput struct {
	Resource string `json:"resource" jsonschema:"description=任务所属的当前湖SSH资源名"`
	JobID    string `json:"job_id" jsonschema:"description=启动返回的32位任务ID"`
	Seconds  int    `json:"seconds,omitempty" jsonschema:"description=wait单次等待1到60秒，默认60"`
}
type scriptJobOutput struct {
	Task  *operate.ScriptJobStatus `json:"task,omitempty"`
	Items []store.ScriptJob        `json:"items,omitempty"`
	Error string                   `json:"error,omitempty"`
}

func validateNamedJob(ctx context.Context, service *operate.Service, in scriptJobInput) (store.ScriptJob, error) {
	job, err := service.Store.GetScriptJob(in.JobID)
	if err != nil {
		return job, err
	}
	resource, err := service.Store.ResolveResource(ctx, service.Lake.Name+"/"+in.Resource)
	if err != nil {
		return job, err
	}
	_, frozen := service.Anchors[resource.ID]
	if job.LakeID != service.Lake.ID || job.ResourceID != resource.ID || !frozen || !resource.ExecuteAuthz {
		return job, fmt.Errorf("任务不属于指定的当前湖授权资源")
	}
	return job, nil
}

func newScriptJobTools(service *operate.Service, approve func(string, string, string) (bool, error), progress func(string)) ([]tool.BaseTool, error) {
	start, err := utils.InferTool[scriptStartInput, scriptJobOutput]("lake_script_start", "批准后后台执行已登记脚本，返回持久任务ID；超过20秒的脚本用此工具。starting/running不是完成，随后在同一轮用wait跟到终态。unknown只能查询原ID，禁止再次启动。", func(ctx context.Context, in scriptStartInput) (scriptJobOutput, error) {
		if in.TimeoutSeconds == 0 {
			in.TimeoutSeconds = 1800
		}
		if err := authorizeResourceToolAction(ctx, service, in.Resource, "lake_script_start", "execute", "script_job", fmt.Sprintf("%s/%s timeout=%d", in.ID, in.SHA256, in.TimeoutSeconds), approve); err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		status, err := service.StartScriptJob(ctx, in.Resource, in.ID, in.SHA256, in.TimeoutSeconds, compose.GetToolCallID(ctx))
		if err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		return scriptJobOutput{Task: &status}, nil
	})
	if err != nil {
		return nil, err
	}
	status, err := utils.InferTool[scriptJobInput, scriptJobOutput]("lake_script_status", "只读查询已启动任务的实际状态与有界输出；可安全重试查询，包括启动响应丢失或会话重启后。禁止用再次启动代替查询。", func(ctx context.Context, in scriptJobInput) (scriptJobOutput, error) {
		if _, err := validateNamedJob(ctx, service, in); err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		value, err := service.ScriptJobStatus(ctx, in.JobID)
		if err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		return scriptJobOutput{Task: &value}, nil
	})
	if err != nil {
		return nil, err
	}
	wait, err := utils.InferTool[scriptJobInput, scriptJobOutput]("lake_script_wait", "只读等待任务最多60秒并报告进度，断线只重试状态查询。若仍running/starting，在同一轮继续wait；仅succeeded且exit_code=0可总结成功。未知状态需核对，不重复启动。", func(ctx context.Context, in scriptJobInput) (scriptJobOutput, error) {
		if _, err := validateNamedJob(ctx, service, in); err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		if in.Seconds == 0 {
			in.Seconds = 60
		}
		value, err := service.WaitScriptJob(ctx, in.JobID, in.Seconds, func(value operate.ScriptJobStatus) {
			if progress != nil {
				progress(fmt.Sprintf("长任务 %s · %s · 已运行 %.0f 秒", value.Job.ID[:8], value.Status, value.ElapsedSeconds))
			}
		})
		if err != nil {
			return scriptJobOutput{Task: &value, Error: err.Error()}, nil
		}
		return scriptJobOutput{Task: &value}, nil
	})
	if err != nil {
		return nil, err
	}
	cancel, err := utils.InferTool[scriptJobInput, scriptJobOutput]("lake_script_cancel", "经批准取消指定长任务，仅终止该任务进程组；取消请求返回后用status确认cancelled。", func(ctx context.Context, in scriptJobInput) (scriptJobOutput, error) {
		if _, err := validateNamedJob(ctx, service, in); err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		if err := authorizeResourceToolAction(ctx, service, in.Resource, "lake_script_cancel", "execute", "script_job_cancel", in.JobID, approve); err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		value, err := service.CancelScriptJob(ctx, in.JobID)
		if err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		return scriptJobOutput{Task: &value}, nil
	})
	if err != nil {
		return nil, err
	}
	list, err := utils.InferTool[sshSessionInput, scriptJobOutput]("lake_script_jobs", "列出当前湖指定资源的持久长任务身份，重启后用ID查询或继续等待，不重新执行脚本。", func(ctx context.Context, in sshSessionInput) (scriptJobOutput, error) {
		resource, err := service.Store.ResolveResource(ctx, service.Lake.Name+"/"+in.Resource)
		if err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		_, frozen := service.Anchors[resource.ID]
		if !frozen || !resource.ExecuteAuthz {
			return scriptJobOutput{Error: "资源不在当前授权冻结范围内"}, nil
		}
		all, err := service.Store.ListScriptJobs(service.Lake.ID)
		if err != nil {
			return scriptJobOutput{Error: err.Error()}, nil
		}
		items := []store.ScriptJob{}
		for _, job := range all {
			if job.ResourceID == resource.ID {
				items = append(items, job)
			}
		}
		return scriptJobOutput{Items: items}, nil
	})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{start, status, wait, cancel, list}, nil
}
