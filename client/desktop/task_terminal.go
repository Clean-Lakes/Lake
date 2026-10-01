package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/cloudwego/eino/lake/code"
	"github.com/cloudwego/eino/lake/store"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type taskTerminal struct {
	ScopeID   string `json:"scope_id"`
	ID        string `json:"id"`
	Root      string `json:"root"`
	Directory string `json:"directory"`
	User      string `json:"user"`
	Target    string `json:"target"`
	Kind      string `json:"kind"`
	Running   bool   `json:"running"`
	local     *code.TerminalSession
}
type commandProposal struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	Command        string `json:"command"`
	Target         string `json:"target"`
	Kind           string `json:"kind"`
	Owner          string `json:"owner"`
	Running        bool   `json:"running"`
	process        *exec.Cmd
	after          uint64
}

func (a *App) emitTaskEvent(name string, event any) {
	if a.taskEvent != nil {
		a.taskEvent(name, event)
		return
	}
	wailsruntime.EventsEmit(a.ctx, name, event)
}
func (a *App) taskStore() (*store.Store, error) { return store.Open(a.ctx, os.Getenv("LAKE_HOME")) }

func (a *App) acceptCommandProposal(process *exec.Cmd, conversationID string, event map[string]any) error {
	id, _ := event["tool_call_id"].(string)
	kind, _ := event["kind"].(string)
	target, _ := event["path"].(string)
	command, _ := event["command"].(string)
	if id == "" || conversationID == "" || strings.TrimSpace(command) == "" || len(command) > 4000 || strings.ContainsAny(command, "\x00\r\n") {
		return errors.New("命令提案无效")
	}
	data, err := a.taskStore()
	if err != nil {
		return err
	}
	defer data.Close()
	c, err := data.GetConversation(a.ctx, conversationID)
	if err != nil {
		return err
	}
	if kind == "local" {
		if c.ProjectID == "" || target != c.ProjectPath {
			return errors.New("命令目标与当前项目不一致")
		}
	} else if kind == "remote" {
		if target != c.RemoteWorkspaceID || target == "" {
			return errors.New("命令目标与当前远程工作区不一致")
		}
	} else {
		return errors.New("命令执行类型无效")
	}
	preview, _ := store.ExecutionPreview(command, 4000)
	payload, _ := json.Marshal(map[string]any{"proposal_id": id, "command": preview, "target": target, "kind": kind})
	proposed, err := data.AppendAgentEvent(a.ctx, conversationID, store.AgentEventInput{Kind: "terminal_proposed", Actor: "agent", ToolCallID: id, Payload: payload})
	if err != nil {
		return err
	}
	after := proposed.Sequence
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	if a.proposals == nil {
		a.proposals = map[string]*commandProposal{}
	}
	if _, ok := a.proposals[id]; ok {
		return errors.New("重复的命令提案")
	}
	a.proposals[id] = &commandProposal{ID: id, ConversationID: conversationID, Command: command, Target: target, Kind: kind, Owner: "agent", process: process, after: after}
	event["proposal_id"] = id
	event["command"] = preview
	event["conversation_id"] = conversationID
	event["after_sequence"] = after
	directory := c.ProjectPath
	if kind == "remote" {
		directory = c.RemoteRoot
	}
	if t := a.tasks[conversationID]; t != nil && t.local != nil && t.ScopeID == func() string {
		if kind == "remote" {
			return c.RemoteWorkspaceID
		}
		return c.ProjectID
	}() {
		directory = t.local.CurrentDirectory()
	}
	event["working_directory"] = directory
	return nil
}

func (a *App) sendCommandReply(p commandProposal, record *store.ExecutionRecord, err error) error {
	reply := map[string]any{}
	if record != nil {
		reply["record"] = record
	}
	if err != nil {
		reply["error"], _ = store.ExecutionPreview(errorString(err), 2048)
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.mu.Lock()
	stdin := a.stdin
	current := a.process == p.process
	a.mu.Unlock()
	if !current || stdin == nil {
		return errors.New("原任务进程已结束")
	}
	return json.NewEncoder(stdin).Encode(map[string]any{"type": "command_result", "id": p.ID, "command_reply": reply})
}

func (a *App) proposal(id string, owner string, claim bool) (commandProposal, error) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	p := a.proposals[id]
	if p == nil || p.Owner != owner || p.Running {
		return commandProposal{}, errors.New("命令提案已结束或控制权已变化")
	}
	a.mu.Lock()
	current := a.process == p.process
	a.mu.Unlock()
	if !current {
		return commandProposal{}, errors.New("原任务进程已结束")
	}
	if claim {
		p.Running = true
	}
	return *p, nil
}
func (a *App) finishProposal(p commandProposal, record *store.ExecutionRecord, err error) error {
	if sendErr := a.sendCommandReply(p, record, err); sendErr != nil {
		a.taskMu.Lock()
		if current := a.proposals[p.ID]; current != nil {
			current.Running = false
		}
		a.taskMu.Unlock()
		return sendErr
	}
	a.taskMu.Lock()
	delete(a.proposals, p.ID)
	a.taskMu.Unlock()
	a.recordTerminalControl(p.ConversationID, p.ID, "agent", "resolved")
	a.emitTaskEvent("lake:command", map[string]any{"type": "resolved", "proposal_id": p.ID, "conversation_id": p.ConversationID})
	return nil
}

// Only a live proposal received from the current CLI process can use its exact
// command as the approval. Manual/edited commands keep the native approval dialog.
func (a *App) RunProposedCommand(id string) (string, error) {
	p, err := a.proposal(id, "agent", true)
	if err != nil {
		return "", err
	}
	record, runErr := a.runTaskCommand(p.ConversationID, p.Command, "agent", &p)
	if err := a.finishProposal(p, &record, runErr); err != nil {
		return "", err
	}
	if record.ID == "" {
		return "", runErr
	}
	body, err := json.Marshal(record)
	return string(body), err
}
func (a *App) DeclineProposedCommand(id string) error {
	p, err := a.proposal(id, "agent", true)
	if err != nil {
		return err
	}
	return a.finishProposal(p, nil, errors.New("用户拒绝此命令；停止该操作"))
}
func (a *App) TakeCommandControl(id string) error {
	p, err := a.proposal(id, "agent", false)
	if err != nil {
		return err
	}
	a.taskMu.Lock()
	current := a.proposals[id]
	if current == nil || current.Running || current.Owner != "agent" {
		a.taskMu.Unlock()
		return errors.New("控制权已变化")
	}
	current.Owner = "user"
	a.taskMu.Unlock()
	a.recordTerminalControl(p.ConversationID, p.ID, "user", "waiting")
	a.emitTaskEvent("lake:command", map[string]any{"type": "taken", "proposal_id": id, "conversation_id": p.ConversationID})
	return nil
}
func (a *App) ReturnCommandControl(id string, sequence uint64) error {
	p, err := a.proposal(id, "user", true)
	if err != nil {
		return err
	}
	unlock := func() {
		a.taskMu.Lock()
		if v := a.proposals[id]; v != nil {
			v.Running = false
		}
		a.taskMu.Unlock()
	}
	data, err := a.taskStore()
	if err != nil {
		unlock()
		return err
	}
	defer data.Close()
	record, err := data.GetExecution(a.ctx, p.ConversationID, sequence)
	if err != nil || record.Actor != "user" || record.Sequence <= p.after {
		unlock()
		return errors.New("请先在当前任务中执行命令，再交回本次结果")
	}
	c, err := data.GetConversation(a.ctx, p.ConversationID)
	if err != nil || (p.Kind == "local" && (record.ScopeID != c.ProjectID || p.Target != c.ProjectPath)) || (p.Kind == "remote" && (record.ScopeID != c.RemoteWorkspaceID || p.Target != c.RemoteWorkspaceID)) {
		unlock()
		return errors.New("执行结果与提案工作区不一致")
	}
	return a.finishProposal(p, &record, nil)
}

func (a *App) TaskTerminalStatus(conversationID string) (string, error) {
	data, err := a.taskStore()
	if err != nil {
		return "", err
	}
	defer data.Close()
	c, err := data.GetConversation(a.ctx, conversationID)
	if err != nil {
		return "", err
	}
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	t := a.tasks[conversationID]
	scope := c.ProjectID
	if c.RemoteWorkspaceID != "" {
		scope = c.RemoteWorkspaceID
	}
	if t != nil && (t.ScopeID != scope || t.ID == "") {
		t = nil
	}
	if t != nil && t.local != nil {
		t.Directory = t.local.CurrentDirectory()
		if t.local.IsClosed() {
			t = nil
		}
	}
	body, err := json.Marshal(t)
	return string(body), err
}
func (a *App) CloseTaskTerminal(conversationID string) error {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	for _, p := range a.proposals {
		if p.ConversationID == conversationID {
			return errors.New("当前任务正在等待终端操作；请完成交接后关闭")
		}
	}
	if t := a.tasks[conversationID]; t != nil {
		if t.Running {
			return errors.New("终端命令正在执行，请等待结果后关闭")
		}
		if t.local != nil {
			t.local.Close()
		}
		delete(a.tasks, conversationID)
	}
	return nil
}
func (a *App) RunTaskCommand(conversationID, command string) (string, error) {
	record, err := a.runTaskCommand(conversationID, command, "user", nil)
	if record.ID == "" {
		return "", err
	}
	body, marshalErr := json.Marshal(record)
	return string(body), marshalErr
}
func (a *App) runTaskCommand(conversationID, command, actor string, p *commandProposal) (store.ExecutionRecord, error) {
	if strings.TrimSpace(command) == "" || len(command) > 4000 || strings.ContainsAny(command, "\x00\r\n") {
		return store.ExecutionRecord{}, errors.New("终端命令须为不超过 4000 字符的单行文本")
	}
	data, err := a.taskStore()
	if err != nil {
		return store.ExecutionRecord{}, err
	}
	defer data.Close()
	c, err := data.GetConversation(a.ctx, conversationID)
	if err != nil {
		return store.ExecutionRecord{}, err
	}
	if p != nil && ((p.Kind == "local" && (p.Target != c.ProjectPath || c.ProjectID == "")) || (p.Kind == "remote" && (p.Target != c.RemoteWorkspaceID || c.RemoteWorkspaceID == ""))) {
		return store.ExecutionRecord{}, errors.New("任务工作区绑定已变化")
	}
	// Reserve the task before showing approval, so two windows cannot authorize
	// commands against different snapshots of one persistent shell.
	a.taskMu.Lock()
	if actor == "user" {
		a.mu.Lock()
		agentBusy := a.conversationID == conversationID && a.agentRunID != ""
		a.mu.Unlock()
		manual := false
		for _, proposal := range a.proposals {
			if proposal.ConversationID == conversationID && proposal.Owner == "user" && !proposal.Running {
				manual = true
			}
		}
		if agentBusy && !manual {
			a.taskMu.Unlock()
			return store.ExecutionRecord{}, errors.New("Lake 正在处理任务；请在命令提案中选择“这一步我来”")
		}
	}
	if a.tasks == nil {
		a.tasks = map[string]*taskTerminal{}
	}
	t := a.tasks[conversationID]
	scope := c.ProjectID
	if c.RemoteWorkspaceID != "" {
		scope = c.RemoteWorkspaceID
	}
	if scope == "" {
		a.taskMu.Unlock()
		return store.ExecutionRecord{}, errors.New("当前任务未绑定代码工作区")
	}
	if t != nil && t.Running {
		a.taskMu.Unlock()
		return store.ExecutionRecord{}, errors.New("此工作终端已有命令正在执行")
	}
	if t != nil && (t.ScopeID != scope || t.local != nil && t.local.IsClosed() || c.RemoteWorkspaceID != "" && (t.Root != c.RemoteRoot || t.Target != fmt.Sprintf("%s@%s:%d", c.RemoteUsername, c.RemoteHost, c.RemotePort))) {
		if t.local != nil {
			t.local.Close()
		}
		t = nil
	}
	if t == nil {
		t = &taskTerminal{ScopeID: scope}
		a.tasks[conversationID] = t
	}
	t.Running = true
	a.taskMu.Unlock()
	defer func() { a.taskMu.Lock(); t.Running = false; a.taskMu.Unlock() }()
	approve := a.askWorkbenchApproval
	if p != nil {
		approve = func(kind, target, detail string) (bool, error) {
			a.mu.Lock()
			current := a.process == p.process
			a.mu.Unlock()
			if !current {
				return false, errors.New("原任务已结束")
			}
			if p.ConversationID != conversationID || p.Command != detail {
				return false, errors.New("批准内容已变化")
			}
			return true, nil
		}
	}
	baseApprove := approve
	approve = func(kind, target, detail string) (bool, error) {
		allowed, err := baseApprove(kind, target, detail)
		if err != nil || !allowed {
			return allowed, err
		}
		fresh, err := data.GetConversation(a.ctx, conversationID)
		if err != nil || fresh.ProjectID != c.ProjectID || fresh.ProjectPath != c.ProjectPath || fresh.RemoteWorkspaceID != c.RemoteWorkspaceID || fresh.RemoteRoot != c.RemoteRoot {
			return false, errors.New("批准期间工作区绑定已变化")
		}
		return true, nil
	}
	id, err := store.NewActionID()
	if err != nil {
		return store.ExecutionRecord{}, err
	}
	record := store.ExecutionRecord{ID: id, ScopeID: scope, Actor: actor, Command: command, Status: "running", ExitCode: -1}
	started := time.Now()
	var auditID string
	var run func() (code.CommandResult, string, bool, error)
	if c.RemoteWorkspaceID != "" {
		service, done, err := a.remoteCodeService()
		if err != nil {
			return store.ExecutionRecord{}, err
		}
		defer done()
		service.Approve = approve
		// Remote execution keeps the registered scope and its per-command revocation check.
		a.taskMu.Lock()
		t.Kind = "remote"
		t.Root = c.RemoteRoot
		t.Directory = c.RemoteRoot
		if t.local != nil {
			t.Directory = t.local.CurrentDirectory()
		}
		t.User = c.RemoteUsername
		t.Target = fmt.Sprintf("%s@%s:%d", c.RemoteUsername, c.RemoteHost, c.RemotePort)
		if t.ID == "" {
			t.ID = id
		}
		session := t.local
		a.taskMu.Unlock()
		run = func() (code.CommandResult, string, bool, error) {
			r, e := service.RunInTerminal(a.ctx, c.RemoteWorkspaceID, command, &session)
			a.taskMu.Lock()
			t.local = session
			if session != nil {
				t.ID = session.ID
			}
			a.taskMu.Unlock()
			if r.WorkingDirectory != "" {
				record.WorkingDirectory = r.WorkingDirectory
			} else if e != nil {
				r.ExitCode = -1
			}
			record.Truncated = r.Truncated
			return r.CommandResult, r.NextDirectory, e != nil && r.WorkingDirectory != "", e
		}
	} else {
		project, workspace, err := a.workbenchProject(c.ProjectID)
		if err != nil {
			return store.ExecutionRecord{}, err
		}
		if workspace.Root != c.ProjectPath || project.LakeID != c.LakeID {
			return store.ExecutionRecord{}, errors.New("工作区绑定已变化")
		}
		// Reuse the policy/journal broker with a one-use approval from this proposal.
		auditID, err = a.approveWorkbenchWith(project, workspace, "lake_code_terminal_run", "执行工作终端命令", command, approve)
		if err != nil {
			return store.ExecutionRecord{}, err
		}
		a.taskMu.Lock()
		existing := t.local
		a.taskMu.Unlock()
		if existing == nil {
			session, err := code.NewTerminalSession(workspace)
			if err != nil {
				return store.ExecutionRecord{}, err
			}
			a.taskMu.Lock()
			t.local = session
			t.ID = session.ID
			a.taskMu.Unlock()
		}
		a.taskMu.Lock()
		t.Kind = "local"
		t.Root = workspace.Root
		t.Directory = t.local.CurrentDirectory()
		t.User = t.local.User
		t.Target = "本机"
		a.taskMu.Unlock()
		run = func() (code.CommandResult, string, bool, error) {
			r, e := t.local.Run(a.ctx, command)
			record.Truncated = r.Truncated
			return r.CommandResult, r.NextDirectory, e != nil, e
		}
	}
	a.taskMu.Lock()
	record.SessionID, record.Target, record.WorkingDirectory, record.User = t.ID, t.Target, t.Directory, t.User
	a.taskMu.Unlock()
	// A remote service authorizes inside Run. Persist only the attempted operation;
	// denial will become a failed record and never be mistaken for successful output.
	saved, event, err := data.AppendExecution(a.ctx, conversationID, record)
	if err != nil {
		return store.ExecutionRecord{}, err
	}
	a.emitTaskEvent("lake:execution", event)
	if auditID != "" {
		if err := a.journalWorkbench(auditID, c.ProjectPath, "lake_code_terminal_run", "started", ""); err != nil {
			return store.ExecutionRecord{}, err
		}
	}
	result, next, unknown, runErr := run()
	actualDirectory, actualTruncated := record.WorkingDirectory, record.Truncated
	record = saved
	record.WorkingDirectory, record.Truncated = actualDirectory, actualTruncated
	a.taskMu.Lock()
	record.SessionID = t.ID
	a.taskMu.Unlock()
	record.Sequence = 0
	record.Actor = actor
	record.Stdout, record.Stderr, record.ExitCode = result.Stdout, result.Stderr, result.ExitCode
	record.NextDirectory = next
	record.DurationMS = time.Since(started).Milliseconds()
	record.Error = errorString(runErr)
	record.Status = "completed"
	if result.ExitCode != 0 || runErr != nil {
		record.Status = "failed"
	}
	if unknown {
		record.Status = "unknown"
	}
	a.taskMu.Lock()
	if next != "" {
		t.Directory = next
	}
	a.taskMu.Unlock()
	saved, event, err = data.AppendExecution(context.WithoutCancel(a.ctx), conversationID, record)
	if err != nil {
		return store.ExecutionRecord{}, err
	}
	a.emitTaskEvent("lake:execution", event)
	if auditID != "" {
		if err := a.journalWorkbench(auditID, c.ProjectPath, "lake_code_terminal_run", saved.Status, ""); err != nil {
			return saved, err
		}
	}
	return saved, runErr
}
func (a *App) AskWithExecutions(id, prompt string, sequences []uint64, images []ImageAttachment) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(prompt) == "" {
		return errors.New("请输入问题")
	}
	if len(sequences) > 4 || len(images) > 4 {
		return errors.New("每次最多引用四条执行和四张图片")
	}
	return a.send(map[string]any{"type": "ask", "id": id, "prompt": prompt, "execution_refs": sequences, "images": images})
}

func (a *App) recordTerminalControl(conversationID, id, owner, status string) {
	data, err := a.taskStore()
	if err != nil {
		return
	}
	defer data.Close()
	payload, _ := json.Marshal(map[string]any{"proposal_id": id, "owner": owner, "status": status})
	_, _ = data.AppendAgentEvent(context.WithoutCancel(a.ctx), conversationID, store.AgentEventInput{Kind: "terminal_control", Actor: "user", ToolCallID: id, Payload: payload})
}

func (a *App) discardProcessProposals(process *exec.Cmd) {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	for id, p := range a.proposals {
		if p.process == process {
			delete(a.proposals, id)
		}
	}
}
