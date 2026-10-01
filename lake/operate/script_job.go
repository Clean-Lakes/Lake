package operate

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/store"
)

//go:embed script_job_controller.py
var scriptJobController string

type ScriptJobStatus struct {
	Job            store.ScriptJob `json:"job"`
	Status         string          `json:"status"`
	StartedAt      float64         `json:"started_at,omitempty"`
	FinishedAt     float64         `json:"finished_at,omitempty"`
	ElapsedSeconds float64         `json:"elapsed_seconds,omitempty"`
	ExitCode       *int            `json:"exit_code,omitempty"`
	StdoutTail     string          `json:"stdout_tail,omitempty"`
	StderrTail     string          `json:"stderr_tail,omitempty"`
	Error          string          `json:"error,omitempty"`
}

func (j ScriptJobStatus) Terminal() bool {
	switch j.Status {
	case "succeeded", "failed", "timed_out", "cancelled", "unknown", "not_started":
		return true
	}
	return false
}

func scriptTargetSHA(resource store.Resource) string {
	b, _ := json.Marshal(resource.SSH)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (s *Service) scriptJobResource(ctx context.Context, job store.ScriptJob) (store.Resource, error) {
	resource, err := s.Store.GetResource(ctx, job.ResourceID)
	if err != nil {
		return resource, err
	}
	_, frozen := s.Anchors[resource.ID]
	if job.LakeID != s.Lake.ID || resource.LakeID != s.Lake.ID || resource.Kind != "host" || !frozen || !resource.ExecuteAuthz {
		return resource, errors.New("脚本任务资源不在当前授权冻结范围内")
	}
	if scriptTargetSHA(resource) != job.TargetSHA256 {
		return resource, errors.New("脚本任务 SSH 目标已变更，拒绝发送控制请求")
	}
	return resource, nil
}

func (s *Service) StartScriptJob(ctx context.Context, resourceName, scriptID, expectedSHA string, timeout int, identity string) (ScriptJobStatus, error) {
	var result ScriptJobStatus
	if strings.Contains(resourceName, "/") || timeout < 1 || timeout > 86400 {
		return result, errors.New("长任务参数无效")
	}
	script, content, err := s.Store.ReadScript(ctx, scriptID)
	if err != nil {
		return result, err
	}
	defer clearBytes(content)
	if expectedSHA == "" || script.SHA256 != expectedSHA {
		return result, errors.New("脚本摘要不匹配")
	}
	resource, err := s.Store.ResolveResource(ctx, s.Lake.Name+"/"+resourceName)
	if err != nil {
		return result, err
	}
	if script.LakeID != "" && script.LakeID != s.Lake.ID || script.ResourceID != "" && script.ResourceID != resource.ID {
		return result, errors.New("脚本不属于目标湖或资源")
	}
	if identity == "" {
		identity, err = store.NewActionID()
		if err != nil {
			return result, err
		}
	}
	hash := sha256.Sum256([]byte(s.RunID + "/" + identity))
	id := hex.EncodeToString(hash[:16])
	job := store.ScriptJob{ID: id, LakeID: s.Lake.ID, ResourceID: resource.ID, ScriptID: script.ID, ScriptSHA256: script.SHA256, TargetSHA256: scriptTargetSHA(resource), Language: script.Language, TimeoutSeconds: timeout, CreatedAt: time.Now().UTC()}
	if _, err = s.scriptJobResource(ctx, job); err != nil {
		return result, err
	}
	prior, err := s.Store.GetScriptJob(id)
	if err == nil {
		if prior.ScriptID != job.ScriptID || prior.ScriptSHA256 != job.ScriptSHA256 || prior.ResourceID != job.ResourceID || prior.TargetSHA256 != job.TargetSHA256 || prior.TimeoutSeconds != timeout {
			return result, errors.New("任务身份已绑定另一执行请求")
		}
		return s.ScriptJobStatus(ctx, id) // Repeated tool call only observes.
	}
	if !errors.Is(err, store.ErrNotFound) {
		return result, err
	}
	if err = s.Store.SaveScriptJob(job); err != nil {
		return result, err
	}
	result, err = s.controlScriptJob(ctx, job, "start", string(content))
	if err != nil {
		// A lost launch response must not lose the job ID or cause another start.
		if result.Status == "" && !errors.Is(err, ErrSSHExecutionUnknown) {
			return ScriptJobStatus{Job: job, Status: "not_started", Error: err.Error()}, nil
		}
		return ScriptJobStatus{Job: job, Status: "unknown", Error: err.Error()}, nil
	}
	return result, nil
}

func shellLiteral(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\\''") + "'" }

func (s *Service) controlScriptJob(ctx context.Context, job store.ScriptJob, action, content string) (ScriptJobStatus, error) {
	result := ScriptJobStatus{Job: job}
	resource, err := s.scriptJobResource(ctx, job)
	if err != nil {
		return result, err
	}
	request := map[string]any{"action": action, "job": job}
	if action == "start" {
		request["content"] = content
		request["controller"] = scriptJobController
	}
	input, err := json.Marshal(request)
	if err != nil {
		return result, err
	}
	defer clearBytes(input)
	risk := "read"
	if action != "status" {
		risk = "write"
	}
	preview := fmt.Sprintf("script_job=%s action=%s script_id=%s sha256=%s timeout_seconds=%d", job.ID, action, job.ScriptID, job.ScriptSHA256, job.TimeoutSeconds)
	output, err := s.runWithInputBound(ctx, resource.Name, "python3 -c "+shellLiteral(scriptJobController), risk, preview, input, preview, job.TargetSHA256)
	if err != nil {
		return result, err
	}
	if output.Truncated {
		return result, scriptControlResponseError(action, "脚本任务控制响应超过上限")
	}
	if err = json.Unmarshal([]byte(output.Stdout), &result); err != nil {
		return ScriptJobStatus{Job: job}, scriptControlResponseError(action, "脚本任务控制响应无效")
	}
	result.Job = job
	switch result.Status {
	case "starting", "running", "succeeded", "failed", "timed_out", "cancelled", "unknown":
	default:
		return result, scriptControlResponseError(action, "脚本任务状态无效")
	}
	if output.ExitCode != 0 {
		return result, fmt.Errorf("脚本任务控制失败: %s", result.Error)
	}
	return result, nil
}

func scriptControlResponseError(action, message string) error {
	if action != "status" {
		return fmt.Errorf("%w: %s", ErrSSHExecutionUnknown, message)
	}
	return errors.New(message)
}

func (s *Service) ScriptJobStatus(ctx context.Context, id string) (ScriptJobStatus, error) {
	job, err := s.Store.GetScriptJob(id)
	if err != nil {
		return ScriptJobStatus{}, err
	}
	return s.controlScriptJob(ctx, job, "status", "")
}

func (s *Service) CancelScriptJob(ctx context.Context, id string) (ScriptJobStatus, error) {
	job, err := s.Store.GetScriptJob(id)
	if err != nil {
		return ScriptJobStatus{}, err
	}
	return s.controlScriptJob(ctx, job, "cancel", "")
}

func (s *Service) WaitScriptJob(ctx context.Context, id string, seconds int, progress func(ScriptJobStatus)) (ScriptJobStatus, error) {
	if seconds < 1 || seconds > 60 {
		return ScriptJobStatus{}, errors.New("单次长任务等待必须为 1–60 秒")
	}
	job, err := s.Store.GetScriptJob(id)
	if err != nil {
		return ScriptJobStatus{}, err
	}
	if _, err = s.scriptJobResource(ctx, job); err != nil {
		return ScriptJobStatus{}, err
	}
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	last := ScriptJobStatus{Job: job, Status: "unknown"}
	for {
		if time.Until(deadline) <= 0 {
			return last, nil
		}
		if _, err := s.scriptJobResource(ctx, job); err != nil {
			return last, err
		}
		// Reads can retry safely; this never resends start or cancel.
		readCtx, cancel := context.WithTimeout(ctx, min(10*time.Second, time.Until(deadline)))
		status, readErr := s.ScriptJobStatus(readCtx, id)
		cancel()
		if readErr == nil {
			last = status
			if progress != nil {
				progress(last)
			}
			if last.Terminal() {
				return last, nil
			}
		} else {
			last.Error = readErr.Error()
		}
		if ctx.Err() != nil {
			return last, ctx.Err()
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return last, nil
		}
		timer := time.NewTimer(min(3*time.Second, remaining))
		select {
		case <-ctx.Done():
			timer.Stop()
			return last, ctx.Err()
		case <-timer.C:
		}
	}
}
