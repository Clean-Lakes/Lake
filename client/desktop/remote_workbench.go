package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	"github.com/cloudwego/eino/lake/code/remote"
	"github.com/cloudwego/eino/lake/store"
)

func (a *App) ListRemoteCodeWorkspaces() (string, error) {
	return a.cli("code", "remote", "list", "--json")
}

func (a *App) AddRemoteCodeWorkspace(lake, name, resource, root string) (string, error) {
	return a.cli("code", "remote", "add", lake, name, "--resource", lake+"/"+resource, "--root", root, "--json")
}

func (a *App) AuthorizeRemoteCodeWorkspace(id string, enabled bool) (string, error) {
	mode := "off"
	if enabled {
		mode = "on"
	}
	return a.cli("code", "remote", "authz", id, mode, "--json")
}

func (a *App) BindConversationRemoteCodeWorkspace(conversationID, workspaceID string) (string, error) {
	if workspaceID == "" {
		workspaceID = "none"
	}
	return a.cli("code", "remote", "bind", conversationID, workspaceID, "--json")
}

func (a *App) remoteCodeService() (remote.Service, func(), error) {
	data, err := store.Open(a.ctx, os.Getenv("LAKE_HOME"))
	if err != nil {
		return remote.Service{}, nil, err
	}
	return remote.Service{Store: data, Origin: "desktop", Actor: "cli", Approve: a.askWorkbenchApproval}, func() { _ = data.Close() }, nil
}

func (a *App) ListRemoteCodeFiles(id string) (string, error) {
	service, done, err := a.remoteCodeService()
	if err != nil {
		return "", err
	}
	defer done()
	files, err := service.List(a.ctx, id)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(files)
	return string(data), err
}

func (a *App) ReadRemoteCodeFile(id, relative string) (string, error) {
	service, done, err := a.remoteCodeService()
	if err != nil {
		return "", err
	}
	defer done()
	content, err := service.Read(a.ctx, id, relative)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(map[string]string{"path": relative, "content": content, "sha256": remote.ContentSHA([]byte(content))})
	return string(data), err
}

func (a *App) WriteRemoteCodeFile(id, relative, expectedSHA, content string) (string, error) {
	service, done, err := a.remoteCodeService()
	if err != nil {
		return "", err
	}
	defer done()
	result, err := service.Write(a.ctx, id, relative, expectedSHA, []byte(content))
	if err != nil && !result.Unknown {
		return "", err
	}
	data, marshalErr := json.Marshal(struct {
		remote.RunResult
		Error string `json:"error,omitempty"`
	}{result, errorString(err)})
	return string(data), marshalErr
}

func (a *App) RunRemoteCodeCommand(id, command string) (string, error) {
	service, done, err := a.remoteCodeService()
	if err != nil {
		return "", err
	}
	defer done()
	result, err := service.Run(a.ctx, id, command)
	if err != nil && !result.Unknown {
		return "", err
	}
	data, marshalErr := json.Marshal(struct {
		remote.RunResult
		Error string `json:"error,omitempty"`
	}{result, errorString(err)})
	return string(data), marshalErr
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "操作已取消；远端结果可能未知"
	}
	return err.Error()
}
