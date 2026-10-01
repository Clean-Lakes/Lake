package main

import "errors"

func (a *App) TaskTerminalStatus(conversationID string) (string, error) {
	return a.request("task.status", map[string]any{"id": conversationID})
}
func (a *App) CloseTaskTerminal(conversationID string) error {
	return a.call("task.close", map[string]any{"id": conversationID})
}
func (a *App) RunTaskCommand(conversationID, command string) (string, error) {
	return a.request("task.run", map[string]any{"id": conversationID, "command": command})
}
func (a *App) RunProposedCommand(id string) (string, error) {
	err := a.Approve(id, true)
	return "null", err
}
func (a *App) DeclineProposedCommand(id string) error { return a.Approve(id, false) }
func (a *App) TakeCommandControl(id string) error {
	return errors.New("当前使用原生终端；请在权限卡处理原生工具请求")
}
func (a *App) ReturnCommandControl(id string, sequence uint64) error {
	return errors.New("当前使用原生终端；执行结果由 ZCode 自行管理")
}
