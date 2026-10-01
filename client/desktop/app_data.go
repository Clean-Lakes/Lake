package main

import (
	"encoding/json"
	"errors"
	"fmt"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"path/filepath"
)

func (a *App) ListLakes() (string, error)   { return a.cli("ls", "--json") }
func (a *App) CurrentLake() (string, error) { return a.cli("current", "--json") }
func (a *App) ListModels() (string, error)  { return a.cli("model", "ls", "--json") }
func (a *App) Settings(payload string) (string, error) {
	var params map[string]any
	if json.Unmarshal([]byte(payload), &params) != nil {
		return "", errors.New("无效的设置请求")
	}
	return a.request("settings", params)
}
func (a *App) ExtensionStatus(path string) (string, error) {
	return a.request("native.extensions", map[string]any{"project_path": path})
}
func (a *App) SetPluginEnabled(name string, enabled bool) (string, error) {
	return a.request("native.plugin.set", map[string]any{"name": name, "enabled": enabled})
}
func (a *App) SetWorkspaceHookEnabled(path string, enabled bool) (string, error) {
	return a.request("native.hook.set", map[string]any{"project_path": path, "enabled": enabled})
}
func (a *App) GetPermissions() (string, error) { return a.cli("permissions", "--json") }
func (a *App) SetPermission(key string, enabled bool) (string, error) {
	return a.cli("permissions", "set", key, fmt.Sprint(enabled), "--json")
}
func (a *App) UseModel(model string) error { _, err := a.cli("model", "use", model); return err }
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
	args := []string{"res", "add-db", lake + "/" + name, "--kind", kind, "--host", host, "--port", fmt.Sprint(port), "--user", username, "--database", database, "--tls", tlsMode, "--json"}
	if password != "" {
		args = append(args, "--password-stdin")
	}
	return a.cliInput(password, args...)
}
func (a *App) ListCodeProjects() (string, error) { return a.cli("code", "list", "--json") }
func (a *App) ListWorkflows() (string, error)    { return a.cli("workflow", "list", "--json") }
func (a *App) ListWorkflowRuns(lake string) (string, error) {
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
	action := "off"
	if enabled {
		action = "on"
	}
	return a.cli("memory", action, "--json")
}
func (a *App) DeleteMemory(id string) (string, error) { return a.cli("memory", "delete", id, "--json") }
func (a *App) RenameConversation(id, title string) (string, error) {
	return a.cli("conversation", "rename", id, title, "--json")
}
func (a *App) ArchiveConversation(id string) error {
	_, err := a.cli("conversation", "archive", id)
	return err
}
func (a *App) RestoreConversation(id string) error {
	_, err := a.cli("conversation", "restore", id)
	return err
}
func (a *App) UseLake(lake string) error {
	a.StopConversation()
	_, err := a.cli("use", lake)
	return err
}
func (a *App) AuthorizeResource(path string, allow bool) error {
	value := "deny"
	if allow {
		value = "allow"
	}
	_, err := a.cli("res", "authz", path, value)
	return err
}
func (a *App) WorkflowV2Manage(payload string) (string, error) {
	return a.cliInput(payload, "workflow-v2", "manage")
}
func (a *App) WorkflowLibrary(payload string) (string, error) {
	return a.cliInput(payload, "workflow", "library")
}
func (a *App) ListSpecialistTasks() (string, error) {
	a.mu.Lock()
	id := a.conversationID
	a.mu.Unlock()
	return a.request("native.subagents", map[string]any{"id": id})
}
