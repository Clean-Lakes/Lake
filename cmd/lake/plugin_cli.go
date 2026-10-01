package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/cloudwego/eino/lake/extension/plugins"
	"github.com/cloudwego/eino/lake/store"
)

func pluginCommand(ctx context.Context, s *store.Store, args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("用法：lake plugin inspect|list|install|enable|disable")
	}
	manager := plugins.NewManager(s.Root(), s)
	switch args[0] {
	case "inspect":
		if len(args) != 2 {
			return errors.New("用法：lake plugin inspect <本地目录>")
		}
		bundle, err := plugins.Inspect(args[1])
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(map[string]any{"name": bundle.Manifest.Name, "version": bundle.Manifest.Version, "description": bundle.Manifest.Description, "sha256": bundle.Digest, "skills": bundle.Manifest.Skills, "mcp": bundle.Manifest.MCP, "hooks": bundle.Manifest.Hooks})
	case "list":
		f := flags("lake plugin list", errOut)
		asJSON := f.Bool("json", false, "JSON 输出")
		if err := f.Parse(args[1:]); err != nil || f.NArg() != 0 {
			return errors.New("用法：lake plugin list [--json]")
		}
		items, err := s.ListPluginExtensions(ctx)
		if err != nil {
			return err
		}
		type view struct {
			Name             string   `json:"name"`
			Version          string   `json:"version"`
			State            string   `json:"state"`
			SHA256           string   `json:"sha256"`
			MCPServers       []string `json:"mcp_servers"`
			HookDeclarations int      `json:"hook_declarations"`
		}
		views := make([]view, 0, len(items))
		for _, item := range items {
			state := "disabled"
			if item.Enabled {
				state = "enabled"
			}
			if manager.Verify(item) != nil {
				state = "invalid"
			}
			var manifest plugins.Manifest
			if err := json.Unmarshal(item.ManifestJSON, &manifest); err != nil {
				return err
			}
			var names []string
			for _, declared := range manifest.MCP {
				data, err := os.ReadFile(filepath.Join(item.InstallPath, declared))
				if err != nil {
					continue
				}
				var d plugins.MCPDeclaration
				if json.Unmarshal(data, &d) != nil {
					continue
				}
				if d.Name == "" {
					d.Name = strings.TrimSuffix(filepath.Base(declared), ".json")
				}
				names = append(names, plugins.MCPName(item.Name, d.Name))
			}
			views = append(views, view{Name: item.Name, Version: item.Version, State: state, SHA256: item.SHA256, MCPServers: names, HookDeclarations: len(manifest.Hooks)})
		}
		if *asJSON {
			return json.NewEncoder(out).Encode(views)
		}
		w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
		if _, err := fmt.Fprintln(w, "NAME\tVERSION\tSTATE\tSHA256"); err != nil {
			return err
		}
		for _, item := range views {
			if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", item.Name, item.Version, item.State, item.SHA256); err != nil {
				return err
			}
		}
		return w.Flush()
	case "install":
		if len(args) < 2 {
			return errors.New("用法：lake plugin install <本地目录> --sha256 <校验值>")
		}
		f := flags("lake plugin install", errOut)
		digest := f.String("sha256", "", "插件树 SHA-256")
		if err := f.Parse(args[2:]); err != nil || f.NArg() != 0 || *digest == "" {
			return errors.New("用法：lake plugin install <本地目录> --sha256 <校验值>")
		}
		item, err := manager.Install(ctx, args[1], *digest)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(out, "已安装插件 %s %s（默认关闭）\n", item.Name, item.Version)
		return err
	case "enable", "disable":
		if len(args) != 2 {
			return errors.New("用法：lake plugin enable|disable <名称>")
		}
		item, err := manager.SetEnabled(ctx, args[1], args[0] == "enable")
		if err != nil {
			return err
		}
		state := "关闭"
		if item.Enabled {
			state = "启用"
		}
		_, err = fmt.Fprintf(out, "插件 %s 已%s\n", item.Name, state)
		return err
	default:
		return errors.New("用法：lake plugin inspect|list|install|enable|disable")
	}
}
