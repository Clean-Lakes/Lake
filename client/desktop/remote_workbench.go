package main

func (a *App) ListRemoteCodeWorkspaces() (string, error) {
	return a.cli("code", "remote", "list", "--json")
}
func (a *App) AddRemoteCodeWorkspace(lake, name, resource, root string) (string, error) {
	return a.cli("code", "remote", "add", lake, name, "--resource", resource, "--root", root, "--json")
}
func (a *App) AuthorizeRemoteCodeWorkspace(id string, enabled bool) (string, error) {
	value := "off"
	if enabled {
		value = "on"
	}
	return a.cli("code", "remote", "authz", id, value, "--json")
}
func (a *App) BindConversationRemoteCodeWorkspace(conversationID, workspaceID string) (string, error) {
	if workspaceID == "" {
		workspaceID = "none"
	}
	return a.cli("code", "remote", "bind", conversationID, workspaceID, "--json")
}
func (a *App) ListRemoteCodeFiles(id string) (string, error) {
	return a.request("remote.workbench.files", map[string]any{"id": id})
}
func (a *App) ReadRemoteCodeFile(id, relative string) (string, error) {
	return a.request("remote.workbench.read", map[string]any{"id": id, "path": relative})
}
func (a *App) WriteRemoteCodeFile(id, relative, expectedSHA, content string) (string, error) {
	return a.request("remote.workbench.write", map[string]any{"id": id, "path": relative, "expected_sha256": expectedSHA, "content": content})
}
func (a *App) RunRemoteCodeCommand(id, command string) (string, error) {
	return a.request("remote.workbench.run", map[string]any{"id": id, "command": command})
}
