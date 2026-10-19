package web

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type scheduleExecution struct {
	ID          string `json:"id"`
	ScheduledAt string `json:"scheduled_at"`
	StartedAt   string `json:"started_at,omitempty"`
	FinishedAt  string `json:"finished_at,omitempty"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	TaskID      string `json:"task_id,omitempty"`
	SessionID   string `json:"session_id,omitempty"`
}

type toolSchedule struct {
	History []scheduleExecution `json:"history,omitempty"`

	ID         string `json:"id"`
	Project    string `json:"project_id"`
	Session    string `json:"session_id"`
	Name       string `json:"name"`
	At         string `json:"at"`
	Interval   int    `json:"interval_seconds"`
	Kind       string `json:"kind"`
	Message    string `json:"message,omitempty"`
	WorkflowID string `json:"workflow_id,omitempty"`
	Version    int    `json:"version,omitempty"`
	Enabled    bool   `json:"enabled"`
	Revision   int    `json:"revision"`
	Status     string `json:"status"`
	LastAt     string `json:"last_at,omitempty"`
	Error      string `json:"error,omitempty"`
	TaskID     string `json:"task_id,omitempty"`
	Options    Object `json:"options,omitempty"`
}

func (b *Server) schedulePath() string { return filepath.Join(b.Store.Dir, "tool-schedules.json") }
func (b *Server) readSchedules() ([]toolSchedule, error) {
	data, err := os.ReadFile(b.schedulePath())
	if os.IsNotExist(err) {
		return []toolSchedule{}, nil
	}
	if err != nil {
		return nil, err
	}
	var rows []toolSchedule
	err = json.Unmarshal(data, &rows)
	return rows, err
}
func (b *Server) writeSchedules(rows []toolSchedule) error {
	data, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(b.Store.Dir, ".schedules-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = platform.Chmod(temp.Name(), 0600); err == nil {
		_, err = temp.Write(data)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return platform.ReplaceFile(temp.Name(), b.schedulePath())
}
func scheduleView(row toolSchedule) Object {
	historyCount := len(row.History)
	row.History = nil
	row.Options = nil
	var out Object
	must(json.Unmarshal([]byte(jsonText(row)), &out))
	delete(out, "options")
	delete(out, "history")
	out["history_count"] = historyCount
	return out
}
func (b *Server) scheduleTool(ctx context.Context, id, project, name string, args Object, approved bool) (any, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	b.scheduleMu.Lock()
	defer b.scheduleMu.Unlock()
	rows, err := b.readSchedules()
	if err != nil {
		return nil, err
	}
	if name == "schedule_list" {
		out := []Object{}
		for _, row := range rows {
			if row.Project == project {
				out = append(out, scheduleView(row))
			}
		}
		return out, nil
	}
	if !approved {
		return nil, errors.New("schedule mutation requires approval")
	}
	if name != "schedule_create" && name != "schedule_update" && name != "schedule_delete" {
		return nil, errors.New("unknown schedule operation")
	}
	index := -1
	var row toolSchedule
	if name == "schedule_create" {
		row = toolSchedule{ID: ident(), Project: project, Session: id, Enabled: true, Revision: 1, Status: "scheduled", Options: b.workflowToolOptions(id)}
	} else {
		for i, r := range rows {
			if r.ID == stringOf(args["schedule_id"]) && r.Project == project {
				index = i
				row = r
				break
			}
		}
		if index < 0 {
			return nil, errors.New("schedule not found in this project")
		}
		if row.Revision != integer(args["expected_revision"]) {
			return nil, errors.New("schedule revision conflict")
		}
		if row.Status == "running" {
			return nil, errors.New("schedule execution is running; stop its task before editing")
		}
		if name == "schedule_delete" {
			rows = append(rows[:index], rows[index+1:]...)
			return Object{"deleted": true}, b.writeSchedules(rows)
		}
		row.Revision++
	}
	if v, ok := args["name"]; ok {
		row.Name = stringOf(v)
	}
	if v, ok := args["at"]; ok {
		row.At = stringOf(v)
	}
	if v, ok := args["kind"]; ok {
		row.Kind = stringOf(v)
	}
	if v, ok := args["message"]; ok {
		row.Message = stringOf(v)
	}
	if v, ok := args["workflow_id"]; ok {
		row.WorkflowID = stringOf(v)
	}
	if v, ok := args["version"]; ok {
		row.Version = integer(v)
	}
	if v, ok := args["interval_seconds"]; ok {
		row.Interval = integer(v)
	}
	if v, ok := args["enabled"]; ok {
		enabled, ok := v.(bool)
		if !ok {
			return nil, errors.New("invalid enabled")
		}
		row.Enabled = enabled
	}
	at, err := time.Parse(time.RFC3339, row.At)
	if err != nil || row.Enabled && !at.After(time.Now()) || row.Interval != 0 && (row.Interval < 60 || row.Interval > 31536000) {
		return nil, errors.New("at must be a future RFC3339 time; interval must be 0 or 60..31536000 seconds")
	}
	if strings.TrimSpace(row.Name) == "" || len(row.Name) > 120 || len(row.Message) > 4000 {
		return nil, errors.New("invalid schedule text")
	}
	if b.Terminals.containsCredential(row.Message + row.Name) {
		return nil, errors.New("credentials cannot be scheduled")
	}
	switch row.Kind {
	case "reminder":
		if strings.TrimSpace(row.Message) == "" {
			return nil, errors.New("reminder message required")
		}
	case "workflow":
		if row.Enabled {
			b.requireScheduledWorkflow(project)
		}
		template := b.Store.Workflow(project, row.WorkflowID)
		if template.Version != row.Version {
			return nil, errors.New("workflow version conflict")
		}
		b.checkToolWorkflowScope(id, template)
	default:
		return nil, errors.New("schedule kind must be reminder or workflow")
	}
	row.Status = "scheduled"
	row.Error = ""
	row.TaskID = ""
	if index < 0 {
		if len(rows) >= 500 {
			return nil, errors.New("schedule limit reached")
		}
		rows = append(rows, row)
	} else {
		rows[index] = row
	}
	if err = b.writeSchedules(rows); err != nil {
		return nil, err
	}
	return scheduleView(row), nil
}
func (b *Server) startScheduler() error {
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	if err == nil {
		current := time.Now()
		for i := range rows {
			r := &rows[i]
			at, e := time.Parse(time.RFC3339, r.At)
			if e != nil {
				r.Enabled = false
				r.Status = "failed"
				r.Error = "invalid persisted schedule time"
				continue
			}
			if r.Status == "running" {
				r.Status = "interrupted"
				r.Error = "Lake restarted; the claimed occurrence was not replayed"
				finishScheduleExecution(r, current)
				r.Revision++
			}
			if r.Enabled && !at.After(current) {
				appendScheduleExecution(r, scheduleExecution{ID: ident(), ScheduledAt: r.At, FinishedAt: current.Format(time.RFC3339), Status: "missed"})
				advanceSchedule(r, current)
				r.Revision++
				r.Status = "missed"
				r.Error = "Missed occurrence skipped after restart"
			}
		}
		if len(rows) > 0 {
			err = b.writeSchedules(rows)
		}
	}
	b.scheduleMu.Unlock()
	if err != nil {
		return err
	}
	b.schedulerWorkers.Add(1)
	go func() {
		defer b.schedulerWorkers.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-b.Context.Done():
				return
			case current := <-ticker.C:
				if b.Context.Err() != nil {
					return
				}
				b.tickSchedules(current)
			}
		}
	}()
	return nil
}
func advanceSchedule(r *toolSchedule, current time.Time) {
	if r.Interval == 0 {
		r.Enabled = false
		return
	}
	at, _ := time.Parse(time.RFC3339, r.At)
	interval := time.Duration(r.Interval) * time.Second
	steps := current.Sub(at)/interval + 1
	if steps < 1 {
		steps = 1
	}
	r.At = at.Add(steps * interval).Format(time.RFC3339)
}
func (b *Server) tickSchedules(current time.Time) {
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	due := []toolSchedule{}
	if err == nil {
		for i := range rows {
			r := &rows[i]
			if r.Status == "running" && r.TaskID != "" {
				b.refreshScheduleTask(r)
			}
			at, e := time.Parse(time.RFC3339, r.At)
			if e != nil || !r.Enabled || r.Status == "running" || at.After(current) {
				continue
			}
			appendScheduleExecution(r, scheduleExecution{ID: ident(), ScheduledAt: r.At, StartedAt: current.Format(time.RFC3339), Status: "running", SessionID: r.Session})
			r.Status = "running"
			r.Error = ""
			r.TaskID = ""
			r.LastAt = current.Format(time.RFC3339)
			r.Revision++
			advanceSchedule(r, current)
			due = append(due, *r)
		}
		if len(rows) > 0 {
			err = b.writeSchedules(rows)
		}
	}
	b.scheduleMu.Unlock()
	if err != nil {
		return
	}
	for _, row := range due {
		if b.Context.Err() != nil {
			return
		}
		b.executeSchedule(row)
	}
}
func (b *Server) refreshScheduleTask(r *toolSchedule) {
	defer func() {
		if r.Status != "running" {
			finishScheduleExecution(r, time.Now())
			r.Revision++
		}
	}()
	defer func() {
		if recover() != nil {
			r.Status = "failed"
			r.Error = "scheduled task unavailable"
		}
	}()
	run := b.Store.WorkflowRun(r.Project, r.TaskID)
	if run["status"] == "running" {
		return
	}
	r.Status = stringOf(run["status"])
	r.Error = b.Terminals.redact(stringOf(run["error"]))
	if len(r.History) > 0 {
		r.History[len(r.History)-1].SessionID = stringOf(run["sessionId"])
	}
	b.Store.AddMessage(r.Session, "system", "定时工作流「"+r.Name+"」已结束："+r.Status+"。"+r.Error, nil)
}
func (b *Server) executeSchedule(row toolSchedule) {
	status, message, taskID, executionSession := "completed", "", "", row.Session
	func() {
		defer func() {
			if p := recover(); p != nil {
				status = "failed"
				message = "调度执行失败"
				if err, ok := p.(error); ok {
					message = err.Error()
				}
			}
		}()
		if b.Store.Session(row.Session)["projectId"] != row.Project {
			fail(403, "schedule project mismatch")
		}
		if row.Kind == "reminder" {
			b.Store.AddMessage(row.Session, "system", "提醒「"+row.Name+"」："+row.Message, nil)
			return
		}
		template := b.Store.Workflow(row.Project, row.WorkflowID)
		b.checkToolWorkflowScope(row.Session, template)
		// Current restrictions can tighten the saved policy, never silently loosen it.
		opts := Object{}
		for k, v := range row.Options {
			opts[k] = v
		}
		current := b.sessionOptions(row.Session)
		for _, k := range []string{"silentReadFiles", "silentWriteFiles", "silentReadSQL", "silentCommands", "silentTerminalCreation"} {
			opts[k] = opts[k] == true && current[k] == true
		}
		opts["denyLocalExecution"] = opts["denyLocalExecution"] == true || current["denyLocalExecution"] == true
		run := b.startWorkflow(row.Project, row.WorkflowID, row.Version, opts)
		taskID = stringOf(run["id"])
		executionSession = stringOf(run["sessionId"])
		status = "running"
		b.Store.AddMessage(row.Session, "system", "定时工作流「"+row.Name+"」已开始。任务："+taskID, nil)
	}()
	message = b.Terminals.redact(message)
	b.scheduleMu.Lock()
	defer b.scheduleMu.Unlock()
	rows, err := b.readSchedules()
	if err != nil {
		return
	}
	for i := range rows {
		if rows[i].ID == row.ID {
			rows[i].Status = status
			rows[i].Error = message
			rows[i].TaskID = taskID
			rows[i].Revision++
			if len(rows[i].History) > 0 {
				last := &rows[i].History[len(rows[i].History)-1]
				last.TaskID = taskID
				last.SessionID = executionSession
			}
			if status != "running" {
				finishScheduleExecution(&rows[i], time.Now())
			}
			break
		}
	}
	_ = b.writeSchedules(rows)
	if status == "failed" {
		func() {
			defer func() { recover() }()
			b.Store.AddMessage(row.Session, "system", "定时任务「"+row.Name+"」失败："+message, nil)
		}()
	}
}

// Execution entries live in the same atomic file as claims; no external effect
// is replayed to reconstruct historical records.
func appendScheduleExecution(row *toolSchedule, run scheduleExecution) {
	row.History = append(row.History, run)
	if len(row.History) > 100 {
		row.History = append([]scheduleExecution{}, row.History[len(row.History)-100:]...)
	}
}
func finishScheduleExecution(row *toolSchedule, now time.Time) {
	if len(row.History) == 0 {
		return
	}
	run := &row.History[len(row.History)-1]
	if run.Status != "running" {
		return
	}
	run.Status = row.Status
	run.Error = row.Error
	run.TaskID = row.TaskID
	run.FinishedAt = now.Format(time.RFC3339)
}

func (b *Server) requireScheduledWorkflow(project string) {
	if !b.Store.SREEnabled(project) {
		fail(409, "只读巡检需要先开启当前项目的 SRE 协作")
	}
	if b.Models.Active() == nil {
		fail(409, "只读巡检需要先连接 Agent 模型")
	}
}
