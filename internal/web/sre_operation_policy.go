package web

import (
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
)

// Risk is runtime metadata. Old SRE records predate it; classify their exact
// saved arguments with the same policy used for new calls, never their prose,
// plan type, role, timeout text, or model-supplied readonly flags.
func normalizeSREOperationRisks(t *ai.SRETask) {
	for i := range t.Attempts {
		for j := range t.Attempts[i].Operations {
			op := &t.Attempts[i].Operations[j]
			if op.Risk != "" {
				continue
			}
			op.Risk = "write"
			var a map[string]any
			if json.Unmarshal([]byte(op.Call.Arguments), &a) != nil || a == nil {
				continue
			}
			switch op.Call.Name {
			case "shell", "terminal_execute_command":
				op.Risk = CommandPolicy(stringOf(a["command"])).Risk
			case "execute_sql", "redis_command", "write", "edit", "multi_edit", "append", "delete", "stage_attachment", "scp_transfer", "docker_container_action", "ssh_terminal_send", "terminal_send_input", "ssh_terminal_key", "terminal_send_key", "call_mcp_tool":
				op.Risk = ai.ToolRisk(op.Call.Name, a)
			}
		}
	}
}

// Presentation never turns a failed observation into success or asks a human to
// attest a pure read. The exact original result and messages remain untouched.
func normalizeSREReadBlocker(t *ai.SRETask) {
	hasReadGap, blocked := false, false
	for i := range t.Attempts {
		a := &t.Attempts[i]
		readGap, attemptBlocked := false, false
		for _, op := range a.Operations {
			readGap = readGap || op.Status == "unknown" && op.Risk == "readonly"
			attemptBlocked = attemptBlocked || ai.SREOperationBlocksResume(op)
		}
		hasReadGap = hasReadGap || readGap
		blocked = blocked || attemptBlocked
		if a.Status == "unknown" && readGap && !attemptBlocked {
			a.Status = "failed"
		}
	}
	if hasReadGap && !blocked && (strings.Contains(t.Error, "结果不明") || strings.Contains(t.Error, "核实")) {
		t.Error = "只读检查未完成，可继续任务重新检查；原始超时记录已保留。"
	}
}
