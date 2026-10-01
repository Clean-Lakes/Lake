package plugins

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/cloudwego/eino/lake/extension/hooks"
	"github.com/cloudwego/eino/lake/store"
)

type MCPDeclaration struct {
	Name      string   `json:"name"`
	Transport string   `json:"transport"`
	Command   string   `json:"command,omitempty"`
	Args      []string `json:"args,omitempty"`
	URL       string   `json:"url,omitempty"`
}
type RuntimeDeclarations struct {
	Plugin store.PluginExtension
	MCP    []MCPDeclaration
	Hooks  []*hooks.Runner
}

func readMCP(root, declared string) (MCPDeclaration, error) {
	var d MCPDeclaration
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(declared)))
	if err != nil {
		return d, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(&d) != nil {
		return d, errors.New("插件 MCP 声明字段无效")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return d, errors.New("插件 MCP 声明无效")
	}
	if d.Name == "" {
		d.Name = strings.TrimSuffix(path.Base(declared), ".json")
	}
	if !pluginName.MatchString(d.Name) || len(d.Args) > 32 {
		return d, errors.New("插件 MCP 名称或参数无效")
	}
	for _, arg := range d.Args {
		if len(arg) > 4096 || strings.ContainsRune(arg, '\x00') {
			return d, errors.New("插件 MCP 参数无效")
		}
	}
	switch d.Transport {
	case "stdio":
		if d.Command == "" || len(d.Command) > 1024 || strings.ContainsRune(d.Command, '\x00') || d.URL != "" {
			return d, errors.New("插件 MCP 命令无效")
		}
		if strings.HasPrefix(d.Command, "assets/") {
			d.Command = filepath.Join(root, filepath.FromSlash(d.Command))
		}
	case "http":
		u, err := url.ParseRequestURI(d.URL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) || d.Command != "" || len(d.Args) > 0 {
			return d, errors.New("插件 MCP URL 无效")
		}
	default:
		return d, errors.New("插件 MCP transport 无效")
	}
	return d, nil
}
func validateRuntimeDeclarations(root string, m Manifest) error {
	seen := map[string]bool{}
	assets := map[string]bool{}
	for _, a := range m.Assets {
		assets[a] = true
	}
	for _, p := range m.MCP {
		d, err := readMCP(root, p)
		if err != nil {
			return err
		}
		if seen[d.Name] {
			return errors.New("插件 MCP 名称重复")
		}
		seen[d.Name] = true
		if strings.HasPrefix(d.Command, root+string(filepath.Separator)+"assets/") {
			rel, _ := filepath.Rel(root, d.Command)
			if !assets[filepath.ToSlash(rel)] {
				return errors.New("插件 MCP 命令必须声明为 asset")
			}
		}
	}
	for _, p := range m.Hooks {
		r, err := hooks.LoadFile(root, p)
		if err != nil {
			return err
		}
		for _, h := range r.Manifest.Hooks {
			if !assets[h.Command] {
				return errors.New("插件 Hook 命令必须声明为 asset")
			}
		}
	}
	return nil
}
func (m *Manager) EnabledRuntime(ctx context.Context) ([]RuntimeDeclarations, error) {
	items, err := m.store.ListPluginExtensions(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]RuntimeDeclarations, 0)
	for _, item := range items {
		if !item.Enabled {
			continue
		}
		if err := m.Verify(item); err != nil {
			return nil, err
		}
		var manifest Manifest
		if json.Unmarshal(item.ManifestJSON, &manifest) != nil {
			return nil, errors.New("插件清单无效")
		}
		d := RuntimeDeclarations{Plugin: item}
		for _, p := range manifest.MCP {
			server, err := readMCP(item.InstallPath, p)
			if err != nil {
				return nil, err
			}
			server.Name = MCPName(item.Name, server.Name)
			d.MCP = append(d.MCP, server)
		}
		for _, p := range manifest.Hooks {
			r, err := hooks.LoadFile(item.InstallPath, p)
			if err != nil {
				return nil, err
			}
			r.Enabled = true
			d.Hooks = append(d.Hooks, r)
		}
		result = append(result, d)
	}
	return result, nil
}

// CheckRuntime revokes a running session when the enabled version or digest changes.
func (m *Manager) CheckRuntime(ctx context.Context, expected store.PluginExtension) error {
	current, err := m.store.GetPluginExtension(ctx, expected.Name)
	if err != nil {
		return err
	}
	if !current.Enabled || current.Version != expected.Version || current.SHA256 != expected.SHA256 {
		return errors.New("插件已停用或版本已变化")
	}
	return m.Verify(current)
}

func MCPName(plugin, name string) string {
	digest := sha256.Sum256([]byte(plugin + ":" + name))
	p := strings.ReplaceAll(plugin, "-", "_")
	n := strings.ReplaceAll(name, "-", "_")
	return fmt.Sprintf("plugin_%s_%s_%x", p[:min(len(p), 20)], n[:min(len(n), 20)], digest[:4])
}
