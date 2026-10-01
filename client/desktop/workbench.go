package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/store"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) workbenchProject(id string) (store.CodeProject, *code.Workspace, error) {
	if id == "" {
		return store.CodeProject{}, nil, errors.New("代码项目未绑定")
	}
	raw, err := a.ListCodeProjects()
	if err != nil {
		return store.CodeProject{}, nil, err
	}
	var projects []store.CodeProject
	if err := json.Unmarshal([]byte(raw), &projects); err != nil {
		return store.CodeProject{}, nil, err
	}
	for _, project := range projects {
		if project.ID == id {
			workspace, err := code.Open(project.Path)
			if err == nil && workspace.Root != project.Path {
				return store.CodeProject{}, nil, errors.New("代码项目路径已变化")
			}
			return project, workspace, err
		}
	}
	return store.CodeProject{}, nil, errors.New("代码项目未在 Lake 中登记")
}

func (a *App) ListProjectFiles(projectID string) (string, error) {
	_, workspace, err := a.workbenchProject(projectID)
	if err != nil {
		return "", err
	}
	items, err := workspace.List(a.ctx, "", 200)
	if err != nil {
		return "", err
	}
	result, err := json.Marshal(items)
	return string(result), err
}

func (a *App) ReadProjectFile(projectID, relative string) (string, error) {
	_, workspace, err := a.workbenchProject(projectID)
	if err != nil {
		return "", err
	}
	result, err := workspace.Read(relative, 1, 200)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(result)
	return string(data), err
}

func (a *App) GitOverview(projectID string) (string, error) {
	_, workspace, err := a.workbenchProject(projectID)
	if err != nil {
		return "", err
	}
	result, err := workspace.GitOverview(a.ctx)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(result)
	return string(data), err
}

func (a *App) GitDiff(projectID, relative string) (string, error) {
	_, workspace, err := a.workbenchProject(projectID)
	if err != nil {
		return "", err
	}
	return workspace.GitDiffForPath(a.ctx, relative)
}

type desktopApprovalBroker struct {
	ask                func(kind, path, detail string) (bool, error)
	kind, path, detail string
}

func (b desktopApprovalBroker) Request(_ context.Context, request agent.PermissionRequest) (agent.PermissionDecision, error) {
	allowed, err := b.ask(b.kind, b.path, b.detail)
	if err != nil {
		return agent.PermissionDecision{}, err
	}
	outcome := agent.PermissionDeny
	if allowed {
		outcome = agent.PermissionAllow
	}
	return agent.PermissionDecision{RequestID: request.ID, Outcome: outcome}, nil
}

func (a *App) askWorkbenchApproval(kind, path, detail string) (bool, error) {
	if a.approvalDialog != nil {
		return a.approvalDialog(kind, path, detail)
	}
	answer, err := wailsruntime.MessageDialog(a.ctx, wailsruntime.MessageDialogOptions{
		Type: wailsruntime.QuestionDialog, Title: "批准代码项目操作", Message: kind + "\n工作目录: " + path + "\n\n" + detail,
		Buttons: []string{"拒绝", "本次允许"}, DefaultButton: "拒绝", CancelButton: "拒绝",
	})
	return answer == "本次允许", err
}

func (a *App) journalWorkbench(actionID, target, tool, event, detail string) error {
	data, err := store.Open(a.ctx, os.Getenv("LAKE_HOME"))
	if err != nil {
		return err
	}
	defer data.Close()
	_, err = data.AppendJournal(a.ctx, store.JournalInput{ActionID: actionID, Actor: "cli", TargetPath: target, Tool: tool, Risk: "write", Event: event, Detail: detail})
	return err
}

func (a *App) approveWorkbench(project store.CodeProject, workspace *code.Workspace, tool, kind, detail string) (string, error) {
	return a.approveWorkbenchWith(project, workspace, tool, kind, detail, a.askWorkbenchApproval)
}

func (a *App) approveWorkbenchWith(project store.CodeProject, workspace *code.Workspace, tool, kind, detail string, approve func(string, string, string) (bool, error)) (string, error) {
	if project.LakeID == "" || workspace == nil {
		return "", errors.New("代码项目缺少湖范围")
	}
	id, err := store.NewActionID()
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(detail))
	auditDetail := "arguments_sha256=" + hex.EncodeToString(digest[:])
	if err := a.journalWorkbench(id, workspace.Root, tool, "requested", auditDetail); err != nil {
		return "", err
	}
	request := agent.PermissionRequest{ID: id, ToolName: tool, Capability: "execute", Target: workspace.Root, ArgumentsSHA: hex.EncodeToString(digest[:])}
	err = policy.Authorize(a.ctx, policy.Input{Spec: agent.ToolSpec{Name: tool, Capability: "execute"}, Scope: agent.RunScope{LakeID: project.LakeID, AllTools: true, ProjectRoot: workspace.Root}, Origin: "desktop", Request: request, ProjectBound: true, ProjectPath: workspace.Root}, desktopApprovalBroker{ask: approve, kind: kind, path: workspace.Root, detail: detail})
	if err != nil {
		if logErr := a.journalWorkbench(id, workspace.Root, tool, "denied", auditDetail); logErr != nil {
			return "", logErr
		}
		return "", err
	}
	if err := a.journalWorkbench(id, workspace.Root, tool, "approved", auditDetail); err != nil {
		return "", err
	}
	return id, nil
}

func (a *App) OpenTerminal(projectID string) (string, error) {
	project, workspace, err := a.workbenchProject(projectID)
	if err != nil {
		return "", err
	}
	if _, err := a.approveWorkbench(project, workspace, "lake_code_terminal_open", "启动受控 Shell 会话", "每条命令仍须单独批准；命令从项目根目录启动"); err != nil {
		return "", err
	}
	session, err := code.NewTerminalSession(workspace)
	if err != nil {
		return "", err
	}
	a.terminalMu.Lock()
	if a.terminal != nil {
		a.terminal.Close()
	}
	a.terminal = session
	a.terminalProjectID = projectID
	a.terminalMu.Unlock()
	data, err := json.Marshal(session)
	return string(data), err
}

func (a *App) RunTerminal(sessionID, command string) (string, error) {
	a.terminalMu.Lock()
	session := a.terminal
	projectID := a.terminalProjectID
	a.terminalMu.Unlock()
	if session == nil || session.ID != sessionID {
		return "", errors.New("终端会话不存在")
	}
	if strings.TrimSpace(command) == "" || len(command) > 4000 || strings.ContainsAny(command, "\x00\r\n") {
		return "", errors.New("终端命令无效")
	}
	project, workspace, err := a.workbenchProject(projectID)
	if err != nil {
		return "", err
	}
	if workspace.Root != session.Root {
		return "", errors.New("终端绑定的项目路径已变化")
	}
	actionID, err := a.approveWorkbench(project, workspace, "lake_code_terminal_run", "执行本地终端命令", command)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(command))
	auditDetail := "arguments_sha256=" + hex.EncodeToString(digest[:])
	if err := a.journalWorkbench(actionID, session.Root, "lake_code_terminal_run", "started", auditDetail); err != nil {
		return "", err
	}
	result, runErr := session.Run(a.ctx, command)
	event := "completed"
	if runErr != nil || result.ExitCode != 0 {
		event = "failed"
	}
	if err := a.journalWorkbench(actionID, session.Root, "lake_code_terminal_run", event, auditDetail); err != nil {
		return "", err
	}
	if runErr != nil {
		return "", runErr
	}
	data, err := json.Marshal(result)
	return string(data), err
}

func (a *App) CloseTerminal(sessionID string) error {
	a.terminalMu.Lock()
	defer a.terminalMu.Unlock()
	if a.terminal == nil {
		return nil
	}
	if sessionID != "" && a.terminal.ID != sessionID {
		return fmt.Errorf("终端会话 %s 不存在", sessionID)
	}
	a.terminal.Close()
	a.terminal = nil
	a.terminalProjectID = ""
	return nil
}
