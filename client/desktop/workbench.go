package main

import "encoding/json"

func (a *App) ListProjectFiles(projectID string) (string, error) {
	return a.request("workbench.files", map[string]any{"project_id": projectID})
}
func (a *App) ReadProjectFile(projectID, relative string) (string, error) {
	return a.request("workbench.read", map[string]any{"project_id": projectID, "path": relative})
}
func (a *App) GitOverview(projectID string) (string, error) {
	return a.request("workbench.git", map[string]any{"project_id": projectID})
}
func (a *App) GitDiff(projectID, relative string) (string, error) {
	raw, err := a.request("workbench.diff", map[string]any{"project_id": projectID, "path": relative})
	if err != nil {
		return "", err
	}
	var result string
	err = json.Unmarshal([]byte(raw), &result)
	return result, err
}
func (a *App) OpenTerminal(projectID string) (string, error) {
	return a.request("workbench.terminal.open", map[string]any{"project_id": projectID})
}
func (a *App) RunTerminal(sessionID, command string) (string, error) {
	return a.request("workbench.terminal.run", map[string]any{"id": sessionID, "command": command})
}
func (a *App) CloseTerminal(sessionID string) error {
	if sessionID == "" {
		return nil
	}
	return a.call("workbench.terminal.close", map[string]any{"id": sessionID})
}
