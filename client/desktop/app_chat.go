package main

import (
	"encoding/json"
	"errors"
	"strings"
)

type UIUserAction struct {
	SurfaceID         string         `json:"surfaceId"`
	SourceComponentID string         `json:"sourceComponentId"`
	Name              string         `json:"name"`
	Context           map[string]any `json:"context"`
	Revision          uint64         `json:"revision"`
}
type WorkflowRunRequest struct {
	Name     string            `json:"name"`
	Resource string            `json:"resource,omitempty"`
	Bindings map[string]string `json:"bindings,omitempty"`
	Targets  []string          `json:"targets,omitempty"`
}
type WorkflowV2Request struct {
	DefinitionID string `json:"definition_id,omitempty"`
	RunID        string `json:"run_id,omitempty"`
	ProjectID    string `json:"project_id,omitempty"`
	RetryWrites  bool   `json:"retry_writes"`
}
type ImageAttachment struct {
	Name     string `json:"name,omitempty"`
	MIMEType string `json:"mime_type"`
	Data     string `json:"data"`
}

func (a *App) StartConversation(id string) error {
	a.StopConversation()
	if _, err := a.request("conversation.start", map[string]any{"id": id}); err != nil {
		return err
	}
	a.mu.Lock()
	a.conversationID = id
	a.mu.Unlock()
	raw, err := a.Settings(`{"action":"get"}`)
	if err != nil {
		return err
	}
	var settings map[string]any
	if json.Unmarshal([]byte(raw), &settings) != nil {
		return errors.New("模型配置响应无效")
	}
	a.emit(map[string]any{"type": "ready", "model": settings["current_model"]})
	return nil
}
func (a *App) ask(id, prompt string, params map[string]any) error {
	if id == "" || (strings.TrimSpace(prompt) == "" && params["images"] == nil) {
		return errors.New("请输入问题")
	}
	a.mu.Lock()
	conversation := a.conversationID
	if a.activeTurn != "" {
		a.mu.Unlock()
		return errors.New("上一轮对话仍在进行")
	}
	if conversation == "" {
		a.mu.Unlock()
		return errors.New("请先选择任务会话")
	}
	a.activeTurn = id
	a.mu.Unlock()
	params["id"], params["prompt"] = conversation, prompt
	if err := a.writeRequest(id, "conversation.ask", params); err != nil {
		a.mu.Lock()
		a.activeTurn = ""
		a.mu.Unlock()
		return err
	}
	return nil
}
func (a *App) Ask(id, prompt string) error { return a.ask(id, prompt, map[string]any{}) }
func (a *App) ReformatResult(id, prompt string) error {
	return a.ask(id, prompt, map[string]any{"review_only": true})
}
func (a *App) AskWithImages(id, prompt string, images []ImageAttachment) error {
	return a.ask(id, prompt, map[string]any{"images": images})
}
func (a *App) AskWithExecutions(id, prompt string, sequences []uint64, images []ImageAttachment) error {
	return a.ask(id, prompt, map[string]any{"images": images, "execution_sequences": sequences})
}
func (a *App) UIAction(id string, action UIUserAction) error {
	if action.SurfaceID == "" || action.SourceComponentID == "" || action.Name == "" || action.Revision == 0 {
		return errors.New("界面操作参数无效")
	}
	return a.ask(id, "处理用户点击的界面操作", map[string]any{"ui_action": action})
}
func (a *App) RunWorkflow(id, prompt string, request WorkflowRunRequest) error {
	if request.Name == "" {
		return errors.New("工作流缺少名称")
	}
	if strings.TrimSpace(prompt) == "" {
		prompt = "运行运维工作流"
	}
	return a.ask(id, prompt, map[string]any{"workflow": request})
}
func (a *App) RunWorkflowV2(id, prompt string, request WorkflowV2Request) error {
	if request.DefinitionID == "" && request.RunID == "" {
		return errors.New("工作流缺少 ID")
	}
	if strings.TrimSpace(prompt) == "" {
		prompt = "运行运维工作流"
	}
	return a.ask(id, prompt, map[string]any{"workflow_v2": request})
}
func (a *App) ResumeSpecialist(id, prompt, taskID string, retryWrites bool) error {
	if taskID == "" {
		return errors.New("缺少原生 Agent ID")
	}
	if strings.TrimSpace(prompt) == "" {
		prompt = "继续原生 Agent 任务"
	}
	return a.ask(id, prompt, map[string]any{"specialist_resume": map[string]any{"task_id": taskID, "retry_writes": retryWrites}})
}
func (a *App) Approve(id string, approved bool) error {
	return a.call("approval.respond", map[string]any{"id": id, "approved": approved})
}
func (a *App) AnswerQuestion(id, questionID string, answers map[string]string) error {
	if id == "" || questionID == "" || len(answers) == 0 || len(answers) > 4 {
		return errors.New("问题回答无效")
	}
	for _, value := range answers {
		if strings.TrimSpace(value) == "" || len([]rune(value)) > 2048 {
			return errors.New("问题回答为空或过长")
		}
	}
	return a.call("question.answer", map[string]any{"run_id": id, "question_id": questionID, "answers": answers})
}
func (a *App) StopConversation() {
	a.mu.Lock()
	id := a.activeTurn
	a.activeTurn = ""
	a.mu.Unlock()
	if id != "" {
		_ = a.writeRequest("cancel-"+id, "execution.cancel", map[string]any{"id": id})
	}
}
