package main

import (
	"context"
	"fmt"

	"github.com/cloudwego/eino/lake/extension/plugins"
	"github.com/cloudwego/eino/lake/store"
)

func pluginMCPServers(root string) ([]mcpServerConfig, error) {
	root, err := settingsRoot(root)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	s, err := store.Open(ctx, root)
	if err != nil {
		return nil, err
	}
	defer s.Close()
	runtime, err := plugins.NewManager(root, s).EnabledRuntime(ctx)
	if err != nil {
		return nil, err
	}
	var result []mcpServerConfig
	for _, bundle := range runtime {
		for _, d := range bundle.MCP {
			expected := bundle.Plugin
			result = append(result, mcpServerConfig{Name: d.Name, Transport: d.Transport, Command: d.Command, Args: d.Args, URL: d.URL, SecretRef: d.Name, Enabled: true, Check: func(ctx context.Context) error {
				current, err := store.Open(ctx, root)
				if err != nil {
					return err
				}
				defer current.Close()
				return plugins.NewManager(root, current).CheckRuntime(ctx, expected)
			}})
		}
	}
	return result, nil
}
func checkMCPConfig(ctx context.Context, server mcpServerConfig) error {
	if server.Check != nil {
		return server.Check(ctx)
	}
	return nil
}
func pluginWarning(err error) string { return fmt.Sprintf("插件运行时未加载: %v", err) }
