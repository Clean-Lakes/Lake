package web

import (
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
	"time"
)

// Called with the Store transaction held. Only authoritative, uniquely matched
// terminal completion can resolve an unknown operation; no command is replayed.
func (s *Store) reconcileSRECommandCompletions(t *ai.SRETask) int {
	corrected := 0
	for i := range t.Attempts {
		attempt := &t.Attempts[i]
		for j := range attempt.Operations {
			op := &attempt.Operations[j]
			if (op.Status != "unknown" && op.Status != "dispatched") || (op.Call.Name != "shell" && op.Call.Name != "terminal_execute_command") {
				continue
			}
			var args Object
			if json.Unmarshal([]byte(op.Call.Arguments), &args) != nil {
				continue
			}
			command := stringOf(args["command"])
			var handle Object
			_ = json.Unmarshal([]byte(op.Result), &handle)
			knownHandle := stringOf(handle["terminal_id"]) != "" && stringOf(handle["entry_id"]) != ""
			if op.Status == "dispatched" && !knownHandle {
				continue
			}
			dispatched, err := time.Parse(time.RFC3339Nano, op.DispatchedAt)
			if err != nil || command == "" || op.ResourceID == "" {
				continue
			}
			// An adopted terminal may have a different owner, but originSessionId must
			// be this exact task session. Never use another session's similar command.
			upper := dispatched.Add(2 * time.Second).Format(time.RFC3339Nano)
			if knownHandle {
				upper = now()
			}
			rows := s.rows("SELECT e.id,e.terminalId,e.startedAt,e.finishedAt,e.exitCode,e.status FROM terminalEntries e JOIN terminals term ON term.id=e.terminalId WHERE e.originSessionId=? AND term.resourceId=? AND e.actor='agent' AND e.command=? AND e.startedAt>=? AND e.startedAt<=?", t.SessionID, op.ResourceID, command, op.DispatchedAt, upper)
			candidates := []Object{}
			for _, entry := range rows {
				// A fresh identical read is a different dispatch. Its completion must
				// never be used to rewrite an earlier handleless timeout as success.
				if !knownHandle && sreEntryBelongsToLaterCall(*t, *op, command, stringOf(entry["startedAt"])) {
					continue
				}
				if knownHandle && (handle["terminal_id"] != entry["terminalId"] || handle["entry_id"] != entry["id"]) {
					continue
				}
				if tid := stringOf(args["terminal_id"]); tid == "" || tid == stringOf(entry["terminalId"]) {
					candidates = append(candidates, entry)
				}
			}
			if len(candidates) != 1 {
				continue
			}
			entry := candidates[0]
			finished, err := time.Parse(time.RFC3339Nano, stringOf(entry["finishedAt"]))
			if err != nil || finished.Before(dispatched) || entry["status"] != "completed" || entry["exitCode"] == nil {
				continue
			}
			op.Status = "succeeded"
			if integer(entry["exitCode"]) != 0 {
				op.Status = "failed"
			}
			op.FinishedAt = stringOf(entry["finishedAt"])
			op.ResolvedBy, op.ResolvedAt = "runtime", now()
			op.ResolutionNote = "运行时已核对原终端命令的完成记录和退出码；未重发命令。"
			// Retain the original error/output; the completion reference is auditable.
			op.Result = jsonText(Object{"priorResult": op.Result, "terminal_id": entry["terminalId"], "entry_id": entry["id"], "exitCode": entry["exitCode"], "finishedAt": entry["finishedAt"]})
			corrected++
		}
		if attempt.Status == "unknown" {
			unresolved := false
			for _, op := range attempt.Operations {
				unresolved = unresolved || op.Status == "unknown" || op.Status == "dispatched"
			}
			if !unresolved {
				attempt.Status = "failed"
			} // Operation complete is not a completed specialist report.
		}
	}
	if corrected > 0 {
		unresolved := false
		for _, a := range t.Attempts {
			for _, op := range a.Operations {
				unresolved = unresolved || op.Status == "unknown" || op.Status == "dispatched"
			}
		}
		if !unresolved && t.Status == "paused" {
			t.Error = "已核对原命令完成记录，未重跑；可继续完成剩余检查。"
		} else if !unresolved && t.Status == "active" && strings.Contains(t.Error, "操作结果不明") {
			t.Error = ""
		}
		t.AddMessage(ai.SRECoordinator, "", "collaboration", "已核对原命令的终端完成记录，未重发命令。", "")
		t.Messages[len(t.Messages)-1].Source = "runtime"
	}
	return corrected
}

func (s *Store) reconcileSRECommandsForSession(session string) {
	for _, row := range s.rows("SELECT body FROM sreTasks WHERE sessionId=? AND status IN ('active','waiting_approval','paused','waiting_input')", session) {
		task := decodeSRETask(row)
		if s.reconcileSRECommandCompletions(&task) > 0 {
			task.Revision++
			task.UpdatedAt = now()
			s.persistSRE(&task, "terminal_completion_reconciled")
		}
	}
}

func sreEntryBelongsToLaterCall(t ai.SRETask, original ai.SREOperation, command, started string) bool {
	at, err := time.Parse(time.RFC3339Nano, started)
	if err != nil {
		return true
	}
	first, err := time.Parse(time.RFC3339Nano, original.DispatchedAt)
	if err != nil {
		return true
	}
	for _, a := range t.Attempts {
		for _, other := range a.Operations {
			if other.ID == original.ID || other.ResourceID != original.ResourceID || other.Call.Name != original.Call.Name {
				continue
			}
			next, err := time.Parse(time.RFC3339Nano, other.DispatchedAt)
			if err != nil || !next.After(first) || at.Before(next) {
				continue
			}
			var args Object
			if json.Unmarshal([]byte(other.Call.Arguments), &args) == nil && stringOf(args["command"]) == command {
				return true
			}
		}
	}
	return false
}
