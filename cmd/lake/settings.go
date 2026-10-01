package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cloudwego/eino/lake/credential"
)

type mcpServerConfig struct {
	Check     func(context.Context) error `json:"-"`
	Name      string                      `json:"name"`
	Transport string                      `json:"transport"`
	Command   string                      `json:"command,omitempty"`
	Args      []string                    `json:"args,omitempty"`
	URL       string                      `json:"url,omitempty"`
	SecretRef string                      `json:"secret_ref,omitempty"`
	Env       map[string]string           `json:"env,omitempty"`
	Headers   map[string]string           `json:"headers,omitempty"`
	Enabled   bool                        `json:"enabled"`
}

type lakeSettings struct {
	Prompts      map[string]string  `json:"prompts"`
	Descriptions map[string]string  `json:"descriptions"`
	MCP          []mcpServerConfig  `json:"mcp"`
	Specialists  []specialistConfig `json:"specialists"`
}

type mcpSecrets struct {
	Env     map[string]string `json:"env,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type settingsRequest struct {
	Specialist      specialistConfig `json:"specialist,omitempty"`
	Action          string           `json:"action"`
	Name            string           `json:"name,omitempty"`
	Prompt          string           `json:"prompt,omitempty"`
	Description     string           `json:"description,omitempty"`
	ClearSecrets    bool             `json:"clear_secrets,omitempty"`
	Model           string           `json:"model,omitempty"`
	Provider        string           `json:"provider,omitempty"`
	BaseURL         string           `json:"base_url,omitempty"`
	APIKey          string           `json:"api_key,omitempty"`
	ContextWindow   int              `json:"context_window,omitempty"`
	MaxOutputTokens int              `json:"max_output_tokens,omitempty"`
	Server          mcpServerConfig  `json:"server,omitempty"`
}

func settingsRoot(root string) (string, error) {
	if root != "" {
		return root, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".lake"), nil
}

func readLakeSettings(root string) (lakeSettings, error) {
	root, err := settingsRoot(root)
	if err != nil {
		return lakeSettings{}, err
	}
	s := lakeSettings{Prompts: map[string]string{}, Descriptions: map[string]string{}, MCP: []mcpServerConfig{}}
	data, err := os.ReadFile(filepath.Join(root, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s, err
	}
	if s.Prompts == nil {
		s.Prompts = map[string]string{}
	}
	if s.Descriptions == nil {
		s.Descriptions = map[string]string{}
	}
	if s.MCP == nil {
		s.MCP = []mcpServerConfig{}
	}
	return s, nil
}

func writeLakeSettings(root string, s lakeSettings) error {
	root, err := settingsRoot(root)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(root, ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(root, "settings.json"))
}

func agentPrompt(root, name string) string {
	s, err := readLakeSettings(root)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(s.Prompts[name])
}

func promptSuffix(root, name string) string {
	if text := agentPrompt(root, name); text != "" {
		return "\n用户配置的补充提示词：\n" + text
	}
	return ""
}

func agentDescription(root, name, fallback string) string {
	s, err := readLakeSettings(root)
	if err == nil && strings.TrimSpace(s.Descriptions[name]) != "" {
		return strings.TrimSpace(s.Descriptions[name])
	}
	return fallback
}

func configuredMCPServers(root string) ([]mcpServerConfig, error) {
	s, err := readLakeSettings(root)
	if err != nil {
		return nil, err
	}
	for index := range s.MCP {
		// Older settings used the server name as the implicit secret reference.
		if s.MCP[index].SecretRef == "" {
			s.MCP[index].SecretRef = s.MCP[index].Name
		}
	}
	declared, err := pluginMCPServers(root)
	if err != nil {
		return nil, err
	}
	return append(s.MCP, declared...), nil
}

func settingsCommand(root string, input io.Reader, out io.Writer) error {
	var req settingsRequest
	if err := json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&req); err != nil {
		return errors.New("无效的设置请求")
	}
	s, err := readLakeSettings(root)
	if err != nil {
		return err
	}
	switch req.Action {
	case "get":
		cfg, err := readSavedModelConfig(root)
		if err != nil {
			return err
		}
		vault := credential.FileVault{Root: root}
		models := make([]map[string]any, 0, len(cfg.ModelCatalog))
		for _, m := range configuredModels(cfg) {
			hasKey, _ := vault.HasModelAPIKey(m.Provider)
			p := cfg.ModelProviders[m.Provider]
			window, output := cfg.ContextWindow, cfg.MaxOutputTokens
			if window == 0 {
				window = 32000
			}
			if output == 0 {
				output = 4096
			}
			models = append(models, map[string]any{"name": m.Name, "provider": m.Provider, "base_url": p.BaseURL, "wire_api": p.WireAPI, "has_key": hasKey, "context_window": window, "max_output_tokens": output})
		}
		servers := make([]mcpServerConfig, len(s.MCP))
		for i, server := range s.MCP {
			servers[i] = server
			servers[i].SecretRef = ""
			servers[i].Env = nil
			servers[i].Headers = nil
		}
		return json.NewEncoder(out).Encode(map[string]any{"current_model": cfg.Model, "models": models, "prompts": s.Prompts, "descriptions": s.Descriptions, "mcp": servers, "specialists": s.Specialists})
	case "specialist_save":
		if err := validateSpecialist(root, req.Specialist.Profile); err != nil {
			return err
		}
		found := false
		for i, p := range s.Specialists {
			if p.Name == req.Specialist.Name {
				s.Specialists[i] = req.Specialist
				found = true
				break
			}
		}
		if !found {
			if len(s.Specialists) >= 32 {
				return errors.New("专员数量超过 32")
			}
			s.Specialists = append(s.Specialists, req.Specialist)
		}
		return writeLakeSettings(root, s)
	case "specialist_delete":
		found := false
		for i, p := range s.Specialists {
			if p.Name == req.Name {
				s.Specialists = append(s.Specialists[:i], s.Specialists[i+1:]...)
				found = true
				break
			}
		}
		if !found {
			return errors.New("专员不存在")
		}
		return writeLakeSettings(root, s)
	case "model_save":
		if !validModelName(req.Model) || !validProviderName(req.Provider) {
			return errors.New("模型或提供方名称无效")
		}
		u, err := url.ParseRequestURI(req.BaseURL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" {
			return errors.New("模型 Base URL 必须是 HTTPS 地址")
		}
		cfg, err := readSavedModelConfig(root)
		if err != nil {
			return err
		}
		if old, exists := cfg.ModelCatalog[req.Model]; exists && old != req.Provider {
			return errors.New("同名模型不能改用其他提供方")
		}
		cfg.ModelProviders[req.Provider] = providerConfig{BaseURL: req.BaseURL, WireAPI: "anthropic"}
		cfg.ModelCatalog[req.Model] = req.Provider
		if req.ContextWindow != 0 {
			cfg.ContextWindow = req.ContextWindow
		}
		if req.MaxOutputTokens != 0 {
			cfg.MaxOutputTokens = req.MaxOutputTokens
		}
		window, output := cfg.ContextWindow, cfg.MaxOutputTokens
		if window == 0 {
			window = 32000
		}
		if output == 0 {
			output = 4096
		}
		if window < 1024 || window > 1000000 || output < 1 || output >= window {
			return errors.New("模型上下文窗口或最大输出 Token 无效")
		}
		if cfg.Model == "" {
			cfg.Model, cfg.ModelProvider = req.Model, req.Provider
		}
		if req.APIKey != "" {
			if err := vaultPutModelKey(root, req.Provider, req.APIKey); err != nil {
				return err
			}
		}
		return saveModelConfig(root, cfg)
	case "model_delete":
		cfg, err := readSavedModelConfig(root)
		if err != nil {
			return err
		}
		if _, ok := cfg.ModelCatalog[req.Model]; !ok {
			return errors.New("模型不存在")
		}
		delete(cfg.ModelCatalog, req.Model)
		if cfg.Model == req.Model {
			cfg.Model, cfg.ModelProvider = "", ""
			for _, m := range configuredModels(cfg) {
				cfg.Model, cfg.ModelProvider = m.Name, m.Provider
				break
			}
		}
		return saveModelConfig(root, cfg)
	case "prompt_save":
		if req.Name != "lake" && req.Name != "ssh" && req.Name != "code" {
			return errors.New("未知专员")
		}
		if len(req.Prompt) > 16000 || len(req.Description) > 500 {
			return errors.New("专员信息过长")
		}
		s.Prompts[req.Name] = strings.TrimSpace(req.Prompt)
		s.Descriptions[req.Name] = strings.TrimSpace(req.Description)
		return writeLakeSettings(root, s)
	case "mcp_save":
		if strings.HasPrefix(req.Server.Name, "plugin_") {
			return errors.New("plugin_ 前缀保留给插件 MCP")
		}
		server := req.Server
		if !validProviderName(server.Name) {
			return errors.New("MCP 名称只能使用小写字母、数字、- 或 _")
		}
		if server.Transport == "stdio" {
			if strings.TrimSpace(server.Command) == "" {
				return errors.New("请填写启动命令")
			}
			server.URL = ""
			server.Headers = nil
		} else if server.Transport == "http" {
			u, err := url.ParseRequestURI(server.URL)
			if err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) || u.Host == "" || u.User != nil || u.RawQuery != "" {
				return errors.New("MCP URL 必须是 HTTPS，或本机 HTTP")
			}
			server.Command = ""
			server.Args = nil
			server.Env = nil
		} else {
			return errors.New("MCP 传输方式只支持 stdio 或 http")
		}
		for key := range server.Env {
			if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "=\x00") {
				return errors.New("无效的环境变量名称")
			}
		}
		for key := range server.Headers {
			if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "\r\n:") {
				return errors.New("无效的 HTTP 请求头名称")
			}
		}
		index := -1
		for i := range s.MCP {
			if s.MCP[i].Name == server.Name {
				index = i
				break
			}
		}
		vault := credential.FileVault{Root: root}
		if index >= 0 && !req.ClearSecrets {
			previous, err := vault.LoadMCPSecrets(server.Name)
			if err != nil {
				return err
			}
			if len(previous) > 0 {
				var old mcpSecrets
				if err := json.Unmarshal(previous, &old); err != nil {
					return err
				}
				if server.Transport == "stdio" && server.Env == nil {
					server.Env = old.Env
				}
				if server.Transport == "http" && server.Headers == nil {
					server.Headers = old.Headers
				}
			}
		}
		secretData, err := json.Marshal(mcpSecrets{Env: server.Env, Headers: server.Headers})
		if err != nil {
			return err
		}
		if err := vault.PutMCPSecrets(server.Name, secretData); err != nil {
			return err
		}
		server.SecretRef = server.Name
		server.Env, server.Headers = nil, nil
		if index >= 0 {
			s.MCP[index] = server
		} else {
			s.MCP = append(s.MCP, server)
		}
		sort.Slice(s.MCP, func(i, j int) bool { return s.MCP[i].Name < s.MCP[j].Name })
		return writeLakeSettings(root, s)
	case "mcp_delete":
		found := false
		filtered := s.MCP[:0]
		for _, item := range s.MCP {
			if item.Name == req.Name {
				found = true
			} else {
				filtered = append(filtered, item)
			}
		}
		if !found {
			return fmt.Errorf("MCP 服务 %q 不存在", req.Name)
		}
		s.MCP = filtered
		if err := writeLakeSettings(root, s); err != nil {
			return err
		}
		return (credential.FileVault{Root: root}).DeleteMCPSecrets(req.Name)
	case "mcp_test":
		servers, err := configuredMCPServers(root)
		if err != nil {
			return err
		}
		for _, server := range servers {
			if server.Name == req.Name {
				return testMCPServer(root, server, out)
			}
		}
		return errors.New("MCP 服务不存在")
	default:
		return errors.New("未知设置操作")
	}
}

func vaultPutModelKey(root, provider, key string) error {
	return (credential.FileVault{Root: root}).PutModelAPIKey(provider, []byte(key))
}
