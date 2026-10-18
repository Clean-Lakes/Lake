package web

import (
	"encoding/json"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
)

func sreStoreError(err *error) {
	if p := recover(); p != nil {
		switch v := p.(type) {
		case *Failure:
			*err = &ai.SREError{Status: v.Status, Message: v.Message}
		case *ai.SREError:
			*err = v
		default:
			*err = fmt.Errorf("SRE 记录未能保存")
		}
	}
}

func decodeSRETask(row Object) ai.SRETask {
	var task ai.SRETask
	must(json.Unmarshal([]byte(stringOf(required(row, "SRE task")["body"])), &task))
	normalizeSREOperationRisks(&task)
	normalizeSREReadBlocker(&task)
	return task
}
func (s *Store) sreTask(session, id string) ai.SRETask {
	return decodeSRETask(s.row("SELECT body FROM sreTasks WHERE sessionId=? AND id=?", session, id))
}

func (s *Store) CreateSRETask(task ai.SRETask) (out ai.SRETask, err error) {
	defer sreStoreError(&err)
	out = s.update(func() any { return s.createSRETaskLocked(task) }).(ai.SRETask)
	return
}
func (s *Store) createSRETaskLocked(task ai.SRETask) ai.SRETask {
	sess := s.session(task.SessionID)
	if old := s.row("SELECT body FROM sreTasks WHERE sessionId=? AND requestId=?", task.SessionID, task.RequestID); old != nil {
		return decodeSRETask(old)
	}
	if s.row("SELECT id FROM sreTasks WHERE sessionId=? AND status IN ('draft','active','waiting_input','waiting_approval','paused')", task.SessionID) != nil {
		fail(409, "当前会话已有活动任务，请先继续或结束该任务")
	}
	project := stringOf(sess["projectId"])
	if task.Goal == "" || task.RequestID == "" || len(task.Goal) > 4000 || len(task.Scope) > 8 || len(task.Scope) == 0 {
		fail(400, "任务需有目标、请求标识和 1–8 个明确资源")
	}
	if task.Mode != "assist" && task.Mode != "plan_only" {
		fail(400, "无效的 SRE 任务模式")
	}
	for _, rid := range task.Scope {
		required(s.row("SELECT id FROM resources WHERE id=? AND projectId=?", rid, project), "Task resource")
	}
	task.ID, task.ProjectID, task.ProfileID, task.ProfileVersion, task.Status, task.Revision = ident(), project, "lake.sre.assisted", 1, "draft", 1
	task.CreatedAt, task.UpdatedAt = now(), now()
	task.RecoveryStatus, task.RootCauseStatus = "unverified", "unknown"
	s.exec("INSERT INTO sreTasks(id,sessionId,projectId,requestId,status,revision,body,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)", task.ID, task.SessionID, project, task.RequestID, task.Status, task.Revision, jsonText(task), task.CreatedAt, task.UpdatedAt)
	s.persistSRE(&task, "task_created")
	return task
}

// A restart is a new read-only investigation with the exact previous scope.
// Cancellation and creation commit together; failed validation leaves history intact.
func (s *Store) RestartSREInvestigation(session, taskID, requestID, mode string, budget int) (out ai.SRETask, err error) {
	defer sreStoreError(&err)
	out = s.update(func() any {
		if row := s.row("SELECT body FROM sreTasks WHERE sessionId=? AND requestId=?", session, requestID); row != nil {
			return decodeSRETask(row)
		}
		old := s.sreTask(session, taskID)
		if old.Status != "paused" && old.Status != "waiting_input" && old.Status != "draft" {
			fail(409, "只能重新开始已暂停的只读调查")
		}
		if p := old.LatestPlan(); p != nil {
			if p.TaskType != "investigation" && p.TaskType != "query" {
				fail(409, "变更任务不能通过重新开始自动重放")
			}
			for _, step := range p.Steps {
				if step.Kind == "act" {
					fail(409, "含变更步骤的任务不能自动重新开始")
				}
			}
		}
		for _, a := range old.Attempts {
			for _, op := range a.Operations {
				if ai.SREOperationBlocksResume(op) {
					fail(409, "原操作尚未完成或结果未明，核实前不会重新开始")
				}
			}
		}
		must(ai.TransitionSRETask(&old, "cancelled"))
		old.Revision++
		old.UpdatedAt = now()
		old.AddMessage(ai.SRECoordinator, "", "collaboration", "已按重新开始的请求结束旧调查，保留全部证据和操作记录。", "")
		old.Messages[len(old.Messages)-1].Source = "runtime"
		s.persistSRE(&old, "investigation_restarted")
		return s.createSRETaskLocked(ai.SRETask{SessionID: session, Goal: old.Goal, Scope: append([]string(nil), old.Scope...), Mode: mode, RequestID: requestID, TokenBudget: budget, BudgetPolicy: ai.SREFullAgentBudgetPolicy})
	}).(ai.SRETask)
	return
}
func (s *Store) LoadSRETask(session, id string) (out ai.SRETask, err error) {
	defer sreStoreError(&err)
	out = s.read(func() any { s.session(session); return s.sreTask(session, id) }).(ai.SRETask)
	return
}

func (s *Store) SRETaskByRequest(session, request string) (out *ai.SRETask, err error) {
	defer sreStoreError(&err)
	s.read(func() any {
		s.session(session)
		if row := s.row("SELECT body FROM sreTasks WHERE sessionId=? AND requestId=?", session, request); row != nil {
			task := decodeSRETask(row)
			out = &task
		}
		return nil
	})
	return
}
func (s *Store) ListSRETasks(session string, limit int, cursor string) (out []ai.SRETask, err error) {
	defer sreStoreError(&err)
	if limit < 1 || limit > 50 {
		limit = 20
	}
	out = s.update(func() any {
		s.session(session)
		s.reconcileSRECommandsForSession(session)
		out := []ai.SRETask{}
		for _, row := range s.rows("SELECT body FROM sreTasks WHERE sessionId=? AND (?='' OR (createdAt,id)<(SELECT createdAt,id FROM sreTasks WHERE id=? AND sessionId=?)) ORDER BY createdAt DESC,id DESC LIMIT ?", session, cursor, cursor, session, limit) {
			out = append(out, decodeSRETask(row))
		}
		return out
	}).([]ai.SRETask)
	return
}
func (s *Store) MutateSRETask(session, id string, revision int, event string, update func(*ai.SRETask) error) (out ai.SRETask, err error) {
	defer sreStoreError(&err)
	out = s.update(func() any {
		t := s.sreTask(session, id)
		if revision > 0 && t.Revision != revision {
			fail(409, "任务已更新，请刷新后重试")
		}
		if e := update(&t); e != nil {
			panic(e)
		}
		t.Revision++
		t.UpdatedAt = now()
		s.persistSRE(&t, event)
		return t
	}).(ai.SRETask)
	return
}
func (s *Store) persistSRE(t *ai.SRETask, event string) {
	seqResult := s.exec("INSERT INTO sreEvents(taskId,sessionId,type,payload,createdAt) VALUES(?,?,?,?,?)", t.ID, t.SessionID, event, jsonText(Object{"revision": t.Revision, "status": t.Status}), now())
	seq, e := seqResult.LastInsertId()
	must(e)
	for i := range t.Messages {
		if t.Messages[i].Sequence == 0 {
			t.Messages[i].Sequence = seq
		}
		m := t.Messages[i]
		s.exec("INSERT INTO sreMessages(id,taskId,sequence,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", m.ID, t.ID, m.Sequence, jsonText(m))
	}
	for _, p := range t.Plans {
		s.exec("INSERT OR IGNORE INTO srePlanRevisions(id,taskId,version,body) VALUES(?,?,?,?)", p.ID, t.ID, p.Version, jsonText(p))
	}
	for _, r := range t.Runs {
		s.exec("INSERT INTO srePlanRuns(id,taskId,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", r.ID, t.ID, jsonText(r))
	}
	for _, a := range t.Attempts {
		s.exec("INSERT INTO sreStepAttempts(id,taskId,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", a.ID, t.ID, jsonText(a))
	}
	for _, v := range t.Verifications {
		s.exec("INSERT INTO sreVerificationResults(id,taskId,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", v.ID, t.ID, jsonText(v))
	}
	payload := Object{"revision": t.Revision, "status": t.Status, "outcome": t.Outcome, "budgetSpent": t.BudgetSpent, "profileVersion": t.ProfileVersion}
	if p := t.LatestPlan(); p != nil {
		payload["planVersion"] = p.Version
	}
	if run := t.ActiveRun(); run != nil {
		payload["run"] = run
	}
	if len(t.Attempts) > 0 {
		payload["attempt"] = t.Attempts[len(t.Attempts)-1]
	}
	if len(t.Messages) > 0 {
		payload["message"] = t.Messages[len(t.Messages)-1]
	}
	if len(t.Verifications) > 0 {
		payload["verification"] = t.Verifications[len(t.Verifications)-1]
	}
	s.exec("UPDATE sreEvents SET payload=? WHERE id=?", jsonText(payload), seq)
	s.exec("UPDATE sreTasks SET status=?,revision=?,body=?,updatedAt=? WHERE id=? AND sessionId=?", t.Status, t.Revision, jsonText(t), t.UpdatedAt, t.ID, t.SessionID)
	status := map[string]string{"draft": "idle", "active": "investigating", "waiting_approval": "waiting_approval", "paused": "failed", "waiting_input": "failed", "completed": "completed", "failed": "failed", "cancelled": "completed"}[t.Status]
	if status != "" {
		s.exec("UPDATE sessions SET status=?,updatedAt=? WHERE id=? AND status<>?", status, now(), t.SessionID, status)
	}
	// The existing persistent session event is committed in this same transaction.
	// SSE replay therefore cannot lose a task update between commit and notify.
	s.event(t.SessionID, "session")
}
func (s *Store) SREEvents(session, id string, after int64, limit int) (out []ai.SREEvent, err error) {
	defer sreStoreError(&err)
	if limit < 1 || limit > 100 {
		limit = 100
	}
	out = s.read(func() any {
		s.sreTask(session, id)
		out := []ai.SREEvent{}
		for _, row := range s.rows("SELECT * FROM sreEvents WHERE sessionId=? AND taskId=? AND id>? ORDER BY id LIMIT ?", session, id, after, limit) {
			out = append(out, ai.SREEvent{ID: int64(integer(row["id"])), TaskID: id, SessionID: session, Type: stringOf(row["type"]), Payload: json.RawMessage(stringOf(row["payload"])), CreatedAt: stringOf(row["createdAt"])})
		}
		return out
	}).([]ai.SREEvent)
	return
}
func (s *Store) SREEnabled(project string) bool {
	return s.read(func() any {
		return s.row("SELECT projectId FROM sreProjectSettings WHERE projectId=? AND enabled=1", project) != nil
	}).(bool)
}
func (s *Store) SetSREEnabled(project string, enabled bool) {
	s.update(func() any {
		required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
		s.exec("INSERT INTO sreProjectSettings(projectId,enabled) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET enabled=excluded.enabled", project, enabled)
		for _, row := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(row["id"]), "session")
		}
		return nil
	})
}
func (s *Store) RecoverSRETasks() {
	s.update(func() any {
		for _, row := range s.rows("SELECT body FROM sreTasks WHERE status IN ('active','waiting_approval')") {
			t := decodeSRETask(row)
			t.Status = "paused"
			t.Error = "服务重启，任务已暂停；已派发操作不会自动重放。"
			t.Revision++
			t.UpdatedAt = now()
			for i := range t.Runs {
				r := &t.Runs[i]
				if r.Status == "running" || r.Status == "queued" || r.Status == "waiting_approval" {
					r.Status = "interrupted"
					for _, a := range t.Attempts {
						if a.PlanRunID == r.ID && a.Status == "waiting_input" {
							r.Status = "paused"
						}
						for _, op := range a.Operations {
							if a.PlanRunID == r.ID && op.Status == "waiting_approval" && strings.HasPrefix(op.ApprovalID, "adk-") {
								r.Status = "paused"
							}
						}
					}
					r.FinishedAt = now()
				}
			}
			for i := range t.Attempts {
				a := &t.Attempts[i]
				nativeWait := a.Status == "waiting_input"
				for _, op := range a.Operations {
					nativeWait = nativeWait || op.Status == "waiting_approval" && strings.HasPrefix(op.ApprovalID, "adk-")
				}
				if !nativeWait && (a.Status == "running" || a.Status == "waiting_approval") {
					a.Status = "interrupted"
					a.FinishedAt = now()
				}
				for j := range a.Operations {
					op := &a.Operations[j]
					if op.Status == "dispatched" {
						op.Status = "unknown"
					}
					if (op.Status == "waiting_approval" || op.Status == "prepared") && !strings.HasPrefix(op.ApprovalID, "adk-") {
						op.Status = "interrupted"
						op.ApprovalID = ""
					}
				}
			}
			s.persistSRE(&t, "recovered")
		}
		for _, row := range s.rows("SELECT body FROM sreTasks WHERE status IN ('paused','waiting_input','draft')") {
			t := decodeSRETask(row)
			if s.reconcileSRECommandCompletions(&t) > 0 {
				t.Revision++
				t.UpdatedAt = now()
				s.persistSRE(&t, "terminal_completion_reconciled")
			}
			if reconcileSRECommandRejections(&t) > 0 {
				t.Revision++
				t.UpdatedAt = now()
				s.persistSRE(&t, "pre_dispatch_rejection_reconciled")
			}
		}
		return nil
	})
}

var _ ai.SRERepository = (*Store)(nil)
