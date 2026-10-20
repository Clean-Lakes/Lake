package extensions

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

// ParseServerImport accepts the two common named-server configuration shapes.
// Error messages never include supplied JSON or credential values.
func ParseServerImport(raw []byte) ([]Server, error) {
	var root map[string]json.RawMessage
	if len(raw) > 100000 || json.Unmarshal(raw, &root) != nil || len(root) == 0 {
		return nil, errors.New("请输入有效的 MCP JSON 对象")
	}
	if wrapped, ok := root["mcpServers"]; ok {
		var nested map[string]json.RawMessage
		if len(root) != 1 || json.Unmarshal(wrapped, &nested) != nil || len(nested) == 0 {
			return nil, errors.New("mcpServers 须为非空的服务器配置对象")
		}
		root = nested
	}
	if len(root) > 50 {
		return nil, errors.New("一次最多导入 50 个 MCP 服务")
	}
	names := make([]string, 0, len(root))
	for name := range root {
		names = append(names, name)
	}
	sort.Strings(names)
	rows := make([]Server, 0, len(root))
	allowed := map[string]bool{"type": true, "transport": true, "command": true, "args": true, "url": true, "headers": true, "env": true, "enabled": true, "timeoutMs": true, "protocolVersion": true}
	for _, name := range names {
		var fields map[string]json.RawMessage
		if json.Unmarshal(root[name], &fields) != nil || len(fields) == 0 {
			return nil, errors.New("每个服务器须包含有效配置对象")
		}
		for key, value := range fields {
			if !allowed[key] || strings.TrimSpace(string(value)) == "null" {
				return nil, errors.New("服务器包含不支持的字段或空值")
			}
		}
		var value struct {
			Type            string            `json:"type"`
			Transport       string            `json:"transport"`
			Command         string            `json:"command"`
			Args            []string          `json:"args"`
			URL             string            `json:"url"`
			Headers         map[string]string `json:"headers"`
			Env             map[string]string `json:"env"`
			Enabled         *bool             `json:"enabled"`
			TimeoutMS       *int              `json:"timeoutMs"`
			ProtocolVersion string            `json:"protocolVersion"`
		}
		if json.Unmarshal(root[name], &value) != nil {
			return nil, errors.New("服务器配置字段类型无效，参数须为字符串数组，请求头和环境变量须为字符串对象")
		}
		normalize := func(kind string) string {
			kind = strings.ToLower(strings.TrimSpace(kind))
			if kind == "streamable-http" {
				return "http"
			}
			return kind
		}
		transport := normalize(value.Type)
		alternate := normalize(value.Transport)
		if transport != "" && alternate != "" && transport != alternate {
			return nil, errors.New("type 与 transport 连接类型不一致")
		}
		if transport == "" {
			transport = alternate
		}
		if transport == "" {
			if value.Command != "" {
				transport = "stdio"
			} else if value.URL != "" {
				transport = "http"
			}
		}
		enabled := true
		if value.Enabled != nil {
			enabled = *value.Enabled
		}
		timeout := 30000
		if value.TimeoutMS != nil {
			timeout = *value.TimeoutMS
			if timeout < 1000 || timeout > 300000 {
				return nil, errors.New("超时时间须为 1000～300000 毫秒")
			}
		}
		protocol := value.ProtocolVersion
		if protocol == "auto" {
			protocol = ""
		}
		row := Server{ID: "import", Name: strings.TrimSpace(name), Transport: transport, Command: value.Command, Args: value.Args, URL: value.URL, Headers: value.Headers, Env: value.Env, Enabled: enabled, TimeoutMS: timeout, ProtocolVersion: protocol}
		if err := ValidateServer(row); err != nil {
			return nil, err
		}
		row.ID = ""
		rows = append(rows, row)
	}
	return rows, nil
}

// All entries are validated and committed in one private-file transaction.
// Imports only create new entries; a same-name entry is never overwritten.
func (s *Store) ImportServers(rows []Server) error {
	if len(rows) == 0 {
		return errors.New("没有可导入的 MCP 服务")
	}
	return s.Update(func(c *Config) error {
		if len(c.Servers)+len(rows) > 50 {
			return errors.New("最多配置 50 个 MCP 服务")
		}
		names := map[string]bool{}
		ids := map[string]bool{}
		for _, old := range c.Servers {
			names[strings.ToLower(strings.TrimSpace(old.Name))] = true
			ids[old.ID] = true
		}
		for _, row := range rows {
			if err := ValidateServer(row); err != nil {
				return err
			}
			name := strings.ToLower(strings.TrimSpace(row.Name))
			if names[name] || ids[row.ID] {
				return errors.New("存在同名 MCP 服务，请修改名称后再导入")
			}
			names[name] = true
			ids[row.ID] = true
		}
		c.Servers = append(c.Servers, rows...)
		return nil
	})
}
