package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

var workflowIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

type workflowTemplate struct {
	ID        string            `json:"id"`
	ProjectID string            `json:"projectId"`
	Name      string            `json:"name"`
	Goal      string            `json:"goal"`
	Steps     []ai.WorkflowStep `json:"steps"`
	Version   int               `json:"version"`
	CreatedAt string            `json:"createdAt"`
	UpdatedAt string            `json:"updatedAt"`
}

func workflowFromRow(row Object) workflowTemplate {
	var steps []ai.WorkflowStep
	must(json.Unmarshal([]byte(stringOf(row["steps"])), &steps))
	return workflowTemplate{ID: stringOf(row["id"]), ProjectID: stringOf(row["projectId"]), Name: stringOf(row["name"]), Goal: stringOf(row["goal"]), Steps: steps, Version: integer(row["version"]), CreatedAt: stringOf(row["createdAt"]), UpdatedAt: stringOf(row["updatedAt"])}
}
func (b *Server) validateWorkflowTemplate(project string, data Object) workflowTemplate {
	b.Store.Project(project)
	template := workflowTemplate{ProjectID: project, Name: text(data["name"], "name", 120), Goal: text(data["goal"], "goal", 1000)}
	raw := data["steps"]
	if _, ok := raw.([]any); !ok {
		fail(400, "工作流步骤须为数组")
	}
	if json.Unmarshal([]byte(jsonText(raw)), &template.Steps) != nil || len(template.Steps) < 1 || len(template.Steps) > 7 {
		fail(400, "工作流须包含 1–7 个步骤")
	}
	if b.Terminals.containsCredential(template.Goal) || b.Terminals.containsCredential(template.Name) {
		fail(400, "调查目标不能包含凭据")
	}
	seen := map[string]bool{}
	for _, step := range template.Steps {
		if !workflowIdentifier.MatchString(step.ID) || step.ID == "_verify" || seen[step.ID] || strings.TrimSpace(step.Task) == "" || len(step.Task) > 4000 || len(step.ResourceIDs) < 1 || len(step.ResourceIDs) > 3 {
			fail(400, "无效的步骤：目标最多 4000 字节，每步选择 1–3 个资源，步骤 ID 不可重复")
		}
		if b.Terminals.containsCredential(step.Task) {
			fail(400, "步骤目标不能包含凭据")
		}
		seen[step.ID] = true
		refs := map[string]bool{}
		for _, id := range step.ResourceIDs {
			if !workflowIdentifier.MatchString(id) || refs[id] {
				fail(400, "步骤资源必须互不重复")
			}
			refs[id] = true
			resource := b.Store.Resource(id)
			if resource["projectId"] != project {
				fail(400, "工作流只能使用本项目资源")
			}
			if !ai.WorkflowRoleAllows(step.Role, stringOf(resource["kind"])) {
				fail(400, "步骤 Agent 与资源类型不匹配")
			}
		}
	}
	return template
}
func (s *Store) Workflows(project string) []workflowTemplate {
	return s.read(func() any {
		required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
		out := []workflowTemplate{}
		for _, row := range s.rows("SELECT * FROM workflows WHERE projectId=? ORDER BY updatedAt DESC,id", project) {
			out = append(out, workflowFromRow(row))
		}
		return out
	}).([]workflowTemplate)
}
func (s *Store) Workflow(project, id string) workflowTemplate {
	return s.read(func() any {
		return workflowFromRow(required(s.row("SELECT * FROM workflows WHERE projectId=? AND id=?", project, id), "Workflow"))
	}).(workflowTemplate)
}
func (s *Store) SaveWorkflow(project, id string, version int, template workflowTemplate) workflowTemplate {
	return s.update(func() any {
		required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
		t := now()
		if id == "" {
			id = ident()
			s.exec("INSERT INTO workflows(id,projectId,name,goal,steps,version,createdAt,updatedAt) VALUES(?,?,?,?,?,1,?,?)", id, project, template.Name, template.Goal, jsonText(template.Steps), t, t)
		} else {
			old := required(s.row("SELECT version FROM workflows WHERE id=? AND projectId=?", id, project), "Workflow")
			if integer(old["version"]) != version {
				fail(409, "工作流已被修改，请刷新后重试")
			}
			s.exec("UPDATE workflows SET name=?,goal=?,steps=?,version=version+1,updatedAt=? WHERE id=?", template.Name, template.Goal, jsonText(template.Steps), t, id)
		}
		return workflowFromRow(s.row("SELECT * FROM workflows WHERE id=?", id))
	}).(workflowTemplate)
}
func (s *Store) DeleteWorkflow(project, id string, version int) {
	s.update(func() any {
		old := required(s.row("SELECT version FROM workflows WHERE id=? AND projectId=?", id, project), "Workflow")
		if integer(old["version"]) != version {
			fail(409, "工作流已被修改，请刷新后重试")
		}
		s.exec("DELETE FROM workflows WHERE id=?", id)
		return nil
	})
}
func (s *Store) CreateWorkflowRun(project, id string, version int) Object {
	return s.update(func() any {
		template := workflowFromRow(required(s.row("SELECT * FROM workflows WHERE id=? AND projectId=?", id, project), "Workflow"))
		if template.Version != version {
			fail(409, "工作流已被修改，请刷新后重试")
		}
		if len(s.rows("SELECT id FROM workflowRuns WHERE status='running'")) >= 3 {
			fail(409, "最多同时运行 3 个工作流")
		}
		if s.row("SELECT id FROM workflowRuns WHERE workflowId=? AND status='running'", id) != nil {
			fail(409, "此模板仍在执行，请先结束当前运行")
		}
		session, run, t := ident(), ident(), now()
		s.exec("INSERT INTO sessions(id,projectId,title,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", session, project, "工作流 · "+template.Name, "investigating", t, t)
		s.message(session, "user", template.Goal, nil)
		s.exec("INSERT INTO workflowRuns(id,workflowId,projectId,sessionId,template,status,createdAt) VALUES(?,?,?,?,?,'running',?)", run, id, project, session, jsonText(template), t)
		s.event(session, "session")
		return s.workflowRun(project, run)
	}).(Object)
}
func (s *Store) workflowRun(project, id string) Object {
	row := required(s.row("SELECT * FROM workflowRuns WHERE projectId=? AND id=?", project, id), "Workflow run")
	row["template"] = parsed(stringOf(row["template"]))
	return row
}
func (s *Store) WorkflowRun(project, id string) Object {
	return s.read(func() any { return s.workflowRun(project, id) }).(Object)
}
func (s *Store) WorkflowRuns(project string) []Object {
	return s.read(func() any {
		required(s.row("SELECT id FROM projects WHERE id=?", project), "Project")
		out := []Object{}
		for _, row := range s.rows("SELECT id FROM workflowRuns WHERE projectId=? ORDER BY createdAt DESC,id LIMIT 30", project) {
			out = append(out, s.workflowRun(project, stringOf(row["id"])))
		}
		return out
	}).([]Object)
}
func (s *Store) FinishWorkflowRun(id, status, message string) {
	s.update(func() any {
		if row := s.row("SELECT sessionId FROM workflowRuns WHERE id=? AND status='running'", id); row != nil {
			s.exec("UPDATE workflowRuns SET status=?,error=?,finishedAt=? WHERE id=?", status, message, now(), id)
			sessionStatus := "failed"
			if status == "completed" || status == "cancelled" {
				sessionStatus = "completed"
			}
			s.status(stringOf(row["sessionId"]), sessionStatus)
		}
		return nil
	})
}

func (s *Store) ActiveWorkflowRun(session string) string {
	return s.read(func() any {
		return stringOf(s.row("SELECT id FROM workflowRuns WHERE sessionId=? AND status='running'", session)["id"])
	}).(string)
}

func (b *Server) cancelSessionWorkflow(session string) {
	run := b.Store.ActiveWorkflowRun(session)
	if run == "" {
		return
	}
	b.workflowMu.Lock()
	if cancel := b.workflowCancels[run]; cancel != nil {
		cancel()
	}
	b.workflowMu.Unlock()
}
func (b *Server) workflowRunView(run Object) Object {
	view, err := b.Engine.Snapshot(stringOf(run["sessionId"]))
	aiFailure(err)
	workflowAgents := []ai.AgentRun{}
	for _, agent := range view.AgentRuns {
		if agent.WorkflowStepID != "" {
			workflowAgents = append(workflowAgents, agent)
		}
	}
	run["agentRuns"] = workflowAgents
	if run["status"] == "running" && view.Status == "waiting_approval" {
		run["waitingApproval"] = true
	}
	for _, agent := range workflowAgents {
		if run["status"] == "running" && agent.Status == "waiting_approval" {
			run["waitingApproval"] = true
		}
	}
	return run
}
func (b *Server) startWorkflow(project, id string, version int, inherited ...Object) Object {
	if !b.Store.SREEnabled(project) {
		fail(409, "工作流协作执行需要先开启本项目的 SRE 协作")
	}
	if b.Models.Active() == nil {
		fail(400, "请先配置 Agent 模型")
	}
	template := b.Store.Workflow(project, id)
	// Revalidate all resources against the current project before admitting any execution.
	var data Object
	must(json.Unmarshal([]byte(jsonText(template)), &data))
	b.validateWorkflowTemplate(project, data)
	b.workflowMu.Lock()
	defer b.workflowMu.Unlock()
	run := b.Store.CreateWorkflowRun(project, id, version)
	if len(inherited) > 0 {
		b.Store.SaveOptions(stringOf(run["sessionId"]), inherited[0])
	}
	// Always execute the frozen snapshot, including if another editor saves now.
	var snapshot workflowTemplate
	must(json.Unmarshal([]byte(jsonText(run["template"])), &snapshot))
	ctx, cancel := context.WithCancel(b.Context)
	if b.workflowCancels == nil {
		b.workflowCancels = map[string]context.CancelFunc{}
	}
	b.workflowCancels[stringOf(run["id"])] = cancel
	b.workers.Add(1)
	go b.executeWorkflowRun(ctx, cancel, run, snapshot)
	return run
}
func (b *Server) executeWorkflowRun(ctx context.Context, cancel context.CancelFunc, run Object, template workflowTemplate) {
	defer b.workers.Done()
	defer cancel()
	runID, id := stringOf(run["id"]), stringOf(run["sessionId"])
	status, message := "failed", "工作流执行失败"
	defer func() {
		if recover() != nil {
			status, message = "failed", "工作流服务发生错误，请检查配置后重新运行"
		}
		if b.Context.Err() != nil {
			status, message = "interrupted", "服务停止，工作流已中断；未自动重放"
		} else if ctx.Err() != nil {
			status, message = "cancelled", "工作流已停止"
		}
		b.Store.FinishWorkflowRun(runID, status, message)
		b.workflowMu.Lock()
		delete(b.workflowCancels, runID)
		b.workflowMu.Unlock()
	}()
	if ctx.Err() != nil {
		return
	}
	b.configure(id, Object{"profile": "core", "multiAgentMode": "off", "blockUnreferencedAssets": true, "maxSteps": 34})
	refs := []string{}
	seen := map[string]bool{}
	steps := []ai.SREPlanStep{}
	previous := ""
	for _, step := range template.Steps {
		for _, ref := range step.ResourceIDs {
			if !seen[ref] {
				refs = append(refs, ref)
				seen[ref] = true
			}
		}
		deps := []string{}
		if previous != "" {
			deps = append(deps, previous)
		}
		steps = append(steps, ai.SREPlanStep{ID: step.ID, Role: ai.SREInvestigator, Kind: "observe", Capability: step.Role, Description: step.Task, ResourceIDs: step.ResourceIDs, DependsOn: deps, CompletionChecks: []string{"取得可追溯的实际证据"}})
		previous = step.ID
	}
	summaryID := "sre_summary"
	for {
		found := false
		for _, step := range steps {
			found = found || step.ID == summaryID
		}
		if !found {
			break
		}
		summaryID += "_"
	}
	steps = append(steps, ai.SREPlanStep{ID: summaryID, Role: ai.SRECoordinator, Kind: "summarize", Description: "汇总工作流调查事实、缺失证据和建议", ResourceIDs: refs, DependsOn: []string{previous}, CompletionChecks: []string{"基于真实证据汇总，不宣称未经验证的恢复"}})
	task := b.createSRETask(id, template.Goal, "assist", "workflow_"+runID, refs)
	plan := ai.SREPlanRevision{Goal: template.Goal, TaskType: "investigation", Scope: refs, Steps: steps, Acceptance: []ai.SRECheck{}, ChangeReason: "已保存工作流通过 SRE 专员执行"}
	if _, err := b.Engine.ReviseSREPlan(id, task.ID, 0, plan); err != nil {
		message = err.Error()
		return
	}
	if err := b.Engine.StartSRETask(ctx, id, task.ID, false, ""); err != nil {
		message = err.Error()
		if errors.Is(err, context.Canceled) {
			status, message = "cancelled", "工作流已停止"
		}
		return
	}
	view, err := b.Engine.Snapshot(id)
	if err != nil {
		return
	}
	for i := len(view.Cards) - 1; i >= 0; i-- {
		if card := view.Cards[i]; card.Type == "message" && card.Content != "" {
			b.Store.AddMessage(id, "assistant", card.Content, nil)
			break
		}
	}
	status, message = "completed", ""
}
func (b *Server) workflowRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "projects" || (parts[3] != "workflows" && parts[3] != "workflow-runs") {
		return false
	}
	project := parts[2]
	b.Store.Project(project)
	if parts[3] == "workflow-runs" {
		if len(parts) == 5 && method == "GET" {
			reply(w, 200, b.workflowRunView(b.Store.WorkflowRun(project, parts[4])))
			return true
		}
		if len(parts) == 6 && parts[5] == "cancel" && method == "POST" {
			run := b.Store.WorkflowRun(project, parts[4])
			b.workflowMu.Lock()
			cancel := b.workflowCancels[parts[4]]
			if cancel != nil {
				cancel()
			}
			b.workflowMu.Unlock()
			aiFailure(b.Engine.Abort(stringOf(run["sessionId"])))
			reply(w, 200, Object{"stopping": run["status"] == "running"})
			return true
		}
	} else {
		if len(parts) == 4 && method == "GET" {
			runs := b.Store.WorkflowRuns(project)
			for _, run := range runs {
				b.workflowRunView(run)
			}
			reply(w, 200, Object{"templates": b.Store.Workflows(project), "runs": runs})
			return true
		}
		if len(parts) == 4 && method == "POST" {
			data := body(w, r, 65536)
			reply(w, 201, b.Store.SaveWorkflow(project, "", 0, b.validateWorkflowTemplate(project, data)))
			return true
		}
		if len(parts) == 5 && method == "PUT" {
			data := body(w, r, 65536)
			reply(w, 200, b.Store.SaveWorkflow(project, parts[4], workflowVersion(data), b.validateWorkflowTemplate(project, data)))
			return true
		}
		if len(parts) == 5 && method == "DELETE" {
			data := body(w, r, 1024)
			b.Store.DeleteWorkflow(project, parts[4], workflowVersion(data))
			reply(w, 200, Object{"deleted": true})
			return true
		}
		if len(parts) == 6 && parts[5] == "run" && method == "POST" {
			data := body(w, r, 1024)
			reply(w, 202, b.startWorkflow(project, parts[4], workflowVersion(data)))
			return true
		}
	}
	fail(404, "Workflow route not found")
	return true
}
func workflowVersion(data Object) int {
	version := integer(data["version"])
	if version < 1 || float64(version) != number(data["version"]) {
		fail(400, "工作流版本必须是正整数")
	}
	return version
}
