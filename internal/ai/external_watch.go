package ai

import (
	"context"
	"errors"
	"strings"
	"time"
)

func releaseWatchState(value any, handle string) (string, error) {
	if obj(value)["isError"] == true {
		return "", errors.New("外部服务返回错误，未确认任务成功")
	}
	data := obj(obj(value)["structuredContent"])
	if str(data["id"]) != handle {
		return "", errors.New("外部状态与原任务句柄不匹配")
	}
	switch str(data["status"]) {
	case "building", "deploying", "queued", "running", "pending":
		return "running", nil
	case "success", "succeeded", "completed", "built", "deployed", "build_success":
		return "completed", nil
	case "failed", "error", "cancelled", "rejected":
		return "failed", nil
	default:
		return "", errors.New("外部服务返回未支持的任务状态，未推断成功")
	}
}
func watchDelay(attempt int, id string) time.Duration {
	seconds := []int{5, 10, 20, 40, 60}[min(max(attempt-1, 0), 4)]
	// Stable jitter never depends on provider text or mutable process randomness.
	jitter := int(hash(id)[0])%21 - 10
	return time.Duration(seconds)*time.Second + time.Duration(seconds*jitter)*time.Second/100
}
func (e *Engine) observeWork(ctx context.Context, g WorkGoal, w *ExternalWatch, c Config) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	switch w.Adapter {
	case "release-v1":
		if c.Permissions == nil || !c.Permissions.SilentCommands || c.Permissions.BlockUnreferencedAssets {
			return "", errors.New("当前权限需要人工确认外部状态读取")
		}
		value, err := e.bridgeCall(ctx, g.SessionID, "work_release_observe", map[string]any{"server_id": w.ServerID, "order_id": w.Handle, "configurationRevision": w.Revision}, false)
		if err != nil {
			return "", err
		}
		state, parseErr := releaseWatchState(value, w.Handle)
		if parseErr != nil {
			return "", parseErr
		}
		return e.recordWorkObservation(g, w, c, state, value)
	case "shell-v1":
		if c.Permissions != nil && (c.Permissions.BlockUnreferencedAssets || c.Permissions.DenyLocalExecution) {
			return "", errors.New("当前权限禁止自动读取原命令结果")
		}
		store, err := e.adkStore()
		if err != nil {
			return "", err
		}
		var op nativeOperation
		if err = store.DB.First(&op, "id = ? AND session_id = ?", w.OperationID, g.SessionID).Error; err != nil {
			return "", err
		}
		if op.Tool != "shell" && op.Tool != "terminal_execute_command" {
			return "", errors.New("原操作不是 Shell 任务")
		}
		// A live local job is usable only through its original owning process.
		owner := e.workOwner()
		if _, ok := owner.shells.Load(g.SessionID + ":" + w.Handle); ok {
			value, err := owner.shellJob(ctx, g.SessionID, "shell_output", map[string]any{"shell_id": w.Handle})
			if err != nil {
				return "", err
			}
			data := obj(value)
			if data["status"] == "running" {
				return e.recordWorkObservation(g, w, c, "running", value)
			}
			if data["status"] == "completed" {
				if num(obj(data["result"])["exitCode"], 0) != 0 {
					return e.recordWorkObservation(g, w, c, "failed", value)
				}
				return e.recordWorkObservation(g, w, c, "completed", value)
			}
			return e.recordWorkObservation(g, w, c, "failed", value)
		}
		terminal, entry, ok := strings.Cut(op.Handle, ":")
		if !ok || terminal == "" || entry == "" {
			return "", errors.New("原本机进程句柄已不可恢复；未重新执行命令")
		}
		value, err := e.bridgeCall(ctx, g.SessionID, "terminal_command_status", map[string]any{"terminal_id": terminal, "entry_id": entry}, false)
		if err != nil {
			return "", err
		}
		data := obj(value)
		if data["status"] == "running" || data["partial"] == true {
			return e.recordWorkObservation(g, w, c, "running", value)
		}
		if data["exitCode"] != nil {
			if num(data["exitCode"], -1) == 0 {
				return e.recordWorkObservation(g, w, c, "completed", value)
			}
			return e.recordWorkObservation(g, w, c, "failed", value)
		}
		return "", errors.New("原命令结果未知；未重新派发")
	}
	return "", errors.New("没有可信只读观察适配器")
}
