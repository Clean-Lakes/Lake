package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/code"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	taskMu             sync.Mutex
	tasks              map[string]*taskTerminal
	proposals          map[string]*commandProposal
	taskEvent          func(string, any)
	conversationID     string
	agentRunID         string
	ctx                context.Context
	mu                 sync.Mutex
	process            *exec.Cmd
	stdin              io.WriteCloser
	writeMu            sync.Mutex
	terminalMu         sync.Mutex
	terminal           *code.TerminalSession
	terminalProjectID  string
	approvalDialog     func(kind, path, detail string) (bool, error)
	saveDownloadDialog func(wailsruntime.SaveDialogOptions) (string, error)
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

func (a *App) shutdown(_ context.Context) {
	a.StopConversation()
	a.CloseTerminal("")
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	for _, t := range a.tasks {
		if t.local != nil {
			t.local.Close()
		}
	}
}

func lakeBinary() (string, error) {
	name := "lake"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if explicit := os.Getenv("LAKE_CLI_PATH"); explicit != "" {
		return explicit, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	executableDir := filepath.Dir(executable)
	candidates := []string{
		filepath.Join(executableDir, name),
		filepath.Join(executableDir, "..", "Resources", name),
		filepath.Join("..", "..", "bin", name),
		filepath.Join("bin", name),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return filepath.Abs(candidate)
		}
	}
	return "", fmt.Errorf("找不到 Lake CLI；请先编译 bin/%s", name)
}

func (a *App) cli(args ...string) (string, error) {
	path, err := lakeBinary()
	if err != nil {
		return "", err
	}
	result, err := exec.CommandContext(a.ctx, path, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("lake %s: %s: %w", strings.Join(args, " "), strings.TrimSpace(string(result)), err)
	}
	return strings.TrimSpace(string(result)), nil
}

func (a *App) ListLakes() (string, error)   { return a.cli("ls", "--json") }
func (a *App) CurrentLake() (string, error) { return a.cli("current", "--json") }
func (a *App) ListModels() (string, error)  { return a.cli("model", "ls", "--json") }

// Settings uses stdin so API keys and MCP credentials never appear in process arguments.
func (a *App) Settings(payload string) (string, error) {
	// WebView is a display/configuration surface, never a credential entry point.
	var request struct {
		APIKey string `json:"api_key"`
		Server struct {
			Env     map[string]string `json:"env"`
			Headers map[string]string `json:"headers"`
		} `json:"server"`
	}
	if err := json.Unmarshal([]byte(payload), &request); err != nil {
		return "", errors.New("无效的设置请求")
	}
	if request.APIKey != "" || len(request.Server.Env) != 0 || len(request.Server.Headers) != 0 {
		return "", errors.New("凭据只能通过本地 Lake CLI 配置")
	}
	path, err := lakeBinary()
	if err != nil {
		return "", err
	}
	command := exec.CommandContext(a.ctx, path, "settings")
	command.Stdin = strings.NewReader(payload)
	result, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("设置失败: %s", strings.TrimSpace(string(result)))
	}
	return strings.TrimSpace(string(result)), nil
}

// ExtensionStatus projects CLI responses into an allowlisted view. In particular,
// neither credential references nor MCP command arguments cross into WebView.
func (a *App) ExtensionStatus(projectPath string) (string, error) {
	if projectPath != "" {
		var err error
		projectPath, err = a.registeredProjectPath(projectPath)
		if err != nil {
			return "", err
		}
	}
	var settings struct {
		MCP []struct {
			Name      string `json:"name"`
			Transport string `json:"transport"`
			Enabled   bool   `json:"enabled"`
		} `json:"mcp"`
	}
	raw, err := a.Settings(`{"action":"get"}`)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		return "", errors.New("读取 MCP 状态失败")
	}
	var plugins []struct {
		Name             string   `json:"name"`
		Version          string   `json:"version"`
		State            string   `json:"state"`
		SHA256           string   `json:"sha256"`
		MCPServers       []string `json:"mcp_servers"`
		HookDeclarations int      `json:"hook_declarations"`
	}
	raw, err = a.cli("plugin", "list", "--json")
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal([]byte(raw), &plugins); err != nil {
		return "", errors.New("读取插件状态失败")
	}
	var skills []struct {
		Name   string `json:"name"`
		Scope  string `json:"scope"`
		SHA256 string `json:"sha256"`
	}
	skillArgs := []string{"skill", "list"}
	if projectPath != "" {
		skillArgs = append(skillArgs, "-C", projectPath)
	}
	skillArgs = append(skillArgs, "--json")
	raw, err = a.cli(skillArgs...)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal([]byte(raw), &skills); err != nil {
		return "", errors.New("读取 Skill 状态失败")
	}
	hook := struct {
		Status string `json:"status"`
		SHA256 string `json:"sha256,omitempty"`
		Hooks  int    `json:"hooks"`
	}{Status: "unbound"}
	if projectPath != "" {
		raw, err = a.cli("hook", "status", "-C", projectPath, "--json")
		if err != nil {
			// No Hook manifest is a normal project state.
			if _, statErr := os.Stat(filepath.Join(projectPath, ".lake", "hooks.json")); errors.Is(statErr, os.ErrNotExist) {
				hook.Status = "absent"
			} else {
				return "", err
			}
		} else if err := json.Unmarshal([]byte(raw), &hook); err != nil {
			return "", errors.New("读取 Hook 状态失败")
		}
	}
	result, err := json.Marshal(struct {
		MCP     any `json:"mcp"`
		Plugins any `json:"plugins"`
		Skills  any `json:"skills"`
		Hook    any `json:"hook"`
	}{settings.MCP, plugins, skills, hook})
	if err != nil {
		return "", err
	}
	return string(result), nil
}

func (a *App) SetPluginEnabled(name string, enabled bool) (string, error) {
	mode := "disable"
	if enabled {
		mode = "enable"
	}
	if _, err := a.cli("plugin", mode, name); err != nil {
		return "", err
	}
	return a.ExtensionStatus("")
}

func (a *App) SetWorkspaceHookEnabled(projectPath string, enabled bool) (string, error) {
	if projectPath == "" {
		return "", errors.New("当前会话未绑定代码项目")
	}
	var err error
	projectPath, err = a.registeredProjectPath(projectPath)
	if err != nil {
		return "", err
	}
	mode := "disable"
	if enabled {
		mode = "enable"
	}
	if _, err := a.cli("hook", mode, "-C", projectPath); err != nil {
		return "", err
	}
	return a.ExtensionStatus(projectPath)
}

func (a *App) registeredProjectPath(path string) (string, error) {
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New("代码项目目录不存在")
	}
	raw, err := a.ListCodeProjects()
	if err != nil {
		return "", err
	}
	var projects []struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(raw), &projects); err != nil {
		return "", errors.New("读取代码项目失败")
	}
	for _, project := range projects {
		if project.Path == canonical {
			return canonical, nil
		}
	}
	return "", errors.New("代码项目未在 Lake 中登记")
}
func (a *App) GetPermissions() (string, error) {
	return a.cli("permissions", "--json")
}
func (a *App) SetPermission(key string, enabled bool) (string, error) {
	value := "off"
	if enabled {
		value = "on"
	}
	return a.cli("permissions", "set", key, value, "--json")
}
func (a *App) UseModel(model string) error {
	if _, err := a.cli("model", "use", model); err != nil {
		return err
	}
	a.StopConversation()
	return nil
}
func (a *App) ListResources(lake string) (string, error) {
	return a.cli("res", "ls", "--lake", lake, "--json")
}
func (a *App) ListAllResources() (string, error) { return a.cli("res", "ls", "--all", "--json") }
func (a *App) PickKubeconfigFile() (string, error) {
	return wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "选择 kubeconfig 文件"})
}
func (a *App) ListKubeContexts(path string) (string, error) {
	return a.cli("res", "k8s-contexts", "--kubeconfig", path)
}
func (a *App) AddK8sResource(lake, name, path, contextName, namespace string) (string, error) {
	return a.cli("res", "add-k8s", lake+"/"+name, "--kubeconfig", path, "--context", contextName, "--namespace", namespace, "--json")
}
func (a *App) AddDatabaseResource(lake, name, kind, host string, port int, username, database, tlsMode, password string) (string, error) {
	path, err := lakeBinary()
	if err != nil {
		return "", err
	}
	args := []string{"res", "add-db", lake + "/" + name, "--kind", kind, "--host", host, "--port", fmt.Sprint(port), "--user", username, "--database", database, "--tls", tlsMode, "--json"}
	if password != "" {
		args = append(args, "--password-stdin")
	}
	command := exec.CommandContext(a.ctx, path, args...)
	if password != "" {
		command.Stdin = strings.NewReader(password)
	}
	result, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("添加数据库资源失败: %s", strings.TrimSpace(string(result)))
	}
	return strings.TrimSpace(string(result)), nil
}
func (a *App) ListCodeProjects() (string, error) { return a.cli("code", "list", "--json") }
func (a *App) ListWorkflows() (string, error)    { return a.cli("workflow", "list", "--json") }
func (a *App) ListWorkflowRuns(lake string) (string, error) {
	if lake == "" {
		return a.cli("workflow", "runs", "--json")
	}
	return a.cli("workflow", "runs", "--lake", lake, "--json")
}
func (a *App) GetWorkflowRun(id string) (string, error) {
	return a.cli("workflow", "status", id, "--json")
}
func (a *App) PickCodeProjectDirectory() (string, error) {
	return wailsruntime.OpenDirectoryDialog(a.ctx, wailsruntime.OpenDialogOptions{Title: "选择代码项目目录"})
}
func (a *App) AddCodeProject(lake, path string) (string, error) {
	return a.cli("code", "add", lake, filepath.Base(path), "--path", path, "--json")
}
func (a *App) BindConversationProject(conversationID, projectID string) (string, error) {
	if projectID == "" {
		projectID = "none"
	}
	return a.cli("code", "bind", conversationID, projectID, "--json")
}
func (a *App) ListConversations() (string, error) { return a.cli("conversation", "list", "--json") }
func (a *App) ListArchivedConversations() (string, error) {
	return a.cli("conversation", "archived", "--json")
}
func (a *App) CreateConversation(lake string) (string, error) {
	return a.cli("conversation", "create", lake, "--json")
}
func (a *App) GetConversation(id string) (string, error) {
	return a.cli("conversation", "show", id, "--json")
}
func (a *App) GetMemory() (string, error) { return a.cli("memory", "show", "--json") }
func (a *App) SetMemoryEnabled(enabled bool) (string, error) {
	if enabled {
		return a.cli("memory", "on", "--json")
	}
	return a.cli("memory", "off", "--json")
}
func (a *App) DeleteMemory(id string) (string, error) { return a.cli("memory", "delete", id, "--json") }
func (a *App) RenameConversation(id, title string) (string, error) {
	return a.cli("conversation", "rename", id, title, "--json")
}
func (a *App) ArchiveConversation(id string) error {
	if _, err := a.cli("conversation", "archive", id, "--json"); err != nil {
		return err
	}
	return nil
}
func (a *App) RestoreConversation(id string) error {
	_, err := a.cli("conversation", "restore", id, "--json")
	return err
}

func (a *App) UseLake(lake string) error {
	a.StopConversation()
	_, err := a.cli("use", lake, "--json")
	return err
}

func (a *App) AuthorizeResource(path string, allow bool) error {
	value := "off"
	if allow {
		value = "on"
	}
	_, err := a.cli("res", "authz", path, value, "--json")
	return err
}

func (a *App) StartConversation(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.process != nil {
		return nil
	}
	path, err := lakeBinary()
	if err != nil {
		return err
	}
	args := []string{"bridge"}
	if id != "" {
		args = append(args, "--conversation", id)
	}
	command := exec.Command(path, args...)
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	a.process, a.stdin = command, stdin
	a.conversationID = id
	if err := json.NewEncoder(stdin).Encode(map[string]any{"type": "hello", "version": 1, "task_commands": true}); err != nil {
		stdin.Close()
		command.Process.Kill()
		a.process, a.stdin = nil, nil
		return err
	}
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4096), 32*1024*1024)
		for scanner.Scan() {
			var event map[string]any
			if json.Unmarshal(scanner.Bytes(), &event) == nil {
				a.mu.Lock()
				current := a.process == command
				a.mu.Unlock()
				if current {
					if event["type"] == "result" || event["type"] == "fatal" {
						a.mu.Lock()
						a.agentRunID = ""
						a.mu.Unlock()
					}
					if event["type"] == "command_proposed" {
						if err := a.acceptCommandProposal(command, id, event); err != nil {
							proposalID, _ := event["tool_call_id"].(string)
							_ = a.sendCommandReply(commandProposal{ID: proposalID, process: command}, nil, err)
							continue
						}
					}
					wailsruntime.EventsEmit(a.ctx, "lake:event", event)
				}
			}
		}
		if err := scanner.Err(); err != nil {
			a.mu.Lock()
			current := a.process == command
			a.mu.Unlock()
			if current {
				wailsruntime.EventsEmit(a.ctx, "lake:event", map[string]any{"type": "fatal", "error": err.Error()})
			}
		}
	}()
	go func() {
		message, _ := io.ReadAll(io.LimitReader(stderr, 64*1024))
		if len(message) != 0 {
			wailsruntime.EventsEmit(a.ctx, "lake:stderr", strings.TrimSpace(string(message)))
		}
	}()
	go func() {
		err := command.Wait()
		a.mu.Lock()
		wasCurrent := a.process == command
		if wasCurrent {
			a.process, a.stdin = nil, nil
			a.agentRunID = ""
		}
		a.mu.Unlock()
		a.discardProcessProposals(command)
		if err != nil && wasCurrent {
			wailsruntime.EventsEmit(a.ctx, "lake:event", map[string]any{"type": "fatal", "error": err.Error()})
		}
	}()
	return nil
}

func (a *App) send(request map[string]any) error {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	requestType, _ := request["type"].(string)
	startsRun := requestType == "ask" || requestType == "ui_action" || requestType == "workflow_run" || requestType == "workflow_v2_run" || requestType == "specialist_resume"
	a.taskMu.Lock()
	a.mu.Lock()
	stdin := a.stdin
	if stdin == nil {
		a.mu.Unlock()
		a.taskMu.Unlock()
		return errors.New("Lake Agent 尚未启动")
	}
	if startsRun {
		if t := a.tasks[a.conversationID]; t != nil && t.Running {
			a.mu.Unlock()
			a.taskMu.Unlock()
			return errors.New("工作终端正在执行，请等待结果后发送 AI 请求")
		}
		a.agentRunID, _ = request["id"].(string)
	}
	a.mu.Unlock()
	a.taskMu.Unlock()
	err := json.NewEncoder(stdin).Encode(request)
	if err != nil && startsRun {
		a.mu.Lock()
		if a.agentRunID == request["id"] {
			a.agentRunID = ""
		}
		a.mu.Unlock()
	}
	return err
}

func (a *App) Ask(id, prompt string) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(prompt) == "" {
		return errors.New("请输入问题")
	}
	return a.send(map[string]any{"type": "ask", "id": id, "prompt": prompt})
}

func (a *App) ReformatResult(id, prompt string) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(prompt) == "" {
		return errors.New("请输入要整理的结果")
	}
	return a.send(map[string]any{"type": "ask", "id": id, "prompt": prompt, "review_only": true})
}

func (a *App) UIAction(id string, action agent.UIUserAction) error {
	if strings.TrimSpace(id) == "" || action.SurfaceID == "" || action.SourceComponentID == "" || action.Name == "" || action.Revision == 0 {
		return errors.New("界面操作参数无效")
	}
	return a.send(map[string]any{"type": "ui_action", "id": id, "ui_action": action})
}

type WorkflowRunRequest struct {
	Name     string            `json:"name"`
	Resource string            `json:"resource,omitempty"`
	Bindings map[string]string `json:"bindings,omitempty"`
	Targets  []string          `json:"targets,omitempty"`
}

func (a *App) RunWorkflow(id, prompt string, request WorkflowRunRequest) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(request.Name) == "" {
		return errors.New("工作流运行需要名称和请求 ID")
	}
	return a.send(map[string]any{"type": "workflow_run", "id": id, "prompt": prompt, "workflow": request})
}

type ImageAttachment struct {
	Name     string `json:"name,omitempty"`
	MIMEType string `json:"mime_type"`
	Data     string `json:"data"`
}

func (a *App) AskWithImages(id, prompt string, images []ImageAttachment) error {
	if strings.TrimSpace(id) == "" || (strings.TrimSpace(prompt) == "" && len(images) == 0) {
		return errors.New("请输入问题或添加图片")
	}
	if len(images) > 4 {
		return errors.New("每轮最多上传 4 张图片")
	}
	return a.send(map[string]any{"type": "ask", "id": id, "prompt": prompt, "images": images})
}

func (a *App) Approve(id string, approved bool) error {
	return a.send(map[string]any{"type": "approve", "id": id, "approved": approved})
}

func (a *App) AnswerQuestion(id, questionID string, answers map[string]string) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(questionID) == "" || len(id) > 128 || len(questionID) > 128 || len(answers) < 1 || len(answers) > 3 {
		return errors.New("问题回答需要当前运行和问题标识")
	}
	for _, answer := range answers {
		if strings.TrimSpace(answer) == "" || len([]rune(answer)) > 2048 {
			return errors.New("请回答全部问题，每题最多 2048 字")
		}
	}
	return a.send(map[string]any{"type": "question_answer", "id": id, "question_id": questionID, "answers": answers})
}

func (a *App) StopConversation() {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.mu.Lock()
	stdin, process := a.stdin, a.process
	a.stdin, a.process = nil, nil
	a.agentRunID = ""
	a.mu.Unlock()
	if stdin != nil {
		_ = json.NewEncoder(stdin).Encode(map[string]any{"type": "close"})
		_ = stdin.Close()
	}
	if process != nil && process.Process != nil {
		_ = process.Process.Kill()
	}
	a.discardProcessProposals(process)
}

// WorkflowV2Manage sends definitions over stdin; execution always uses the
// live bridge so every node and tool approval reaches the desktop.
func (a *App) WorkflowV2Manage(payload string) (string, error) {
	if len(payload) > 1<<20 || !json.Valid([]byte(payload)) {
		return "", errors.New("无效的工作流请求")
	}
	path, err := lakeBinary()
	if err != nil {
		return "", err
	}
	cmd := exec.CommandContext(a.ctx, path, "workflow", "manage")
	cmd.Stdin = strings.NewReader(payload)
	data, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("工作流管理失败: %s", strings.TrimSpace(string(data)))
	}
	return strings.TrimSpace(string(data)), nil
}
func (a *App) ListSpecialistTasks() (string, error) { return a.cli("specialist", "tasks") }

type WorkflowV2Request struct {
	DefinitionID string `json:"definition_id,omitempty"`
	RunID        string `json:"run_id,omitempty"`
	ProjectID    string `json:"project_id,omitempty"`
	RetryWrites  bool   `json:"retry_writes"`
}

func (a *App) RunWorkflowV2(id, prompt string, request WorkflowV2Request) error {
	if id == "" || (request.DefinitionID == "" && request.RunID == "") {
		return errors.New("缺少工作流 ID")
	}
	return a.send(map[string]any{"type": "workflow_v2_run", "id": id, "prompt": prompt, "workflow_v2": request})
}
func (a *App) ResumeSpecialist(id, prompt, taskID string, retryWrites bool) error {
	if id == "" || taskID == "" {
		return errors.New("缺少专员任务 ID")
	}
	return a.send(map[string]any{"type": "specialist_resume", "id": id, "prompt": prompt, "specialist_resume": map[string]any{"task_id": taskID, "retry_writes": retryWrites}})
}
