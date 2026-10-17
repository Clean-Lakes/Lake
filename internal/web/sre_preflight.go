package web

import (
	"encoding/json"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Repair only the exact legacy bridge validation failure for a command that
// the local validator provably rejects before Execute. Transport errors and
// valid commands never qualify, even when their output uses the same words.
func reconcileSRECommandRejections(t *ai.SRETask) int {
	corrected := 0
	for i := range t.Attempts {
		a := &t.Attempts[i]
		changed := false
		for j := range a.Operations {
			op := &a.Operations[j]
			if op.Status != "unknown" || (op.Call.Name != "shell" && op.Call.Name != "terminal_execute_command") || op.Result != "Invalid command" {
				continue
			}
			var args Object
			if json.Unmarshal([]byte(op.Call.Arguments), &args) != nil {
				continue
			}
			command, ok := args["command"].(string)
			if !ok || validCommand(command) {
				continue
			}
			op.Status, op.ResolvedBy, op.ResolvedAt = "not_executed", "runtime", now()
			op.ResolutionNote = "运行时核实：原命令未通过本地派发前参数校验，未调用终端执行；已修正历史误判，未重跑。"
			changed = true
			corrected++
		}
		if changed && a.Status == "unknown" {
			remaining := false
			for _, op := range a.Operations {
				remaining = remaining || op.Status == "unknown" || op.Status == "dispatched"
			}
			if !remaining {
				a.Status = "failed"
			}
		}
	}
	if corrected > 0 {
		unknown := false
		for _, a := range t.Attempts {
			for _, op := range a.Operations {
				unknown = unknown || op.Status == "unknown" || op.Status == "dispatched"
			}
		}
		if !unknown && (strings.Contains(t.Error, "结果不明") || strings.Contains(t.Error, "结果待核实")) {
			t.Error = "原命令未通过参数校验，未执行；已保留证据，可调整命令后继续。"
		}
		t.AddMessage(ai.SRECoordinator, "", "collaboration", "已核对历史命令校验记录：被本地参数校验拒绝的命令已修正为未执行，没有重跑命令。", "")
		t.Messages[len(t.Messages)-1].Source = "runtime"
	}
	return corrected
}
