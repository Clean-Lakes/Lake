package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/cloudwego/eino/lake/credential"
)

// mcpCredentialCommand reads one secret from the terminal or stdin. The value
// never appears in command arguments, settings.json, CLI output, or WebView.
func mcpCredentialCommand(args []string, root string, input io.Reader, out, errOut io.Writer) error {
	if len(args) == 0 || args[0] != "login" {
		return errors.New("用法：lake mcp login --name 服务名 (--env 变量名 | --header 请求头名)")
	}
	f := flags("lake mcp login", errOut)
	name := f.String("name", "", "MCP 服务名")
	envName := f.String("env", "", "环境变量名")
	headerName := f.String("header", "", "HTTP 请求头名")
	if err := f.Parse(args[1:]); err != nil {
		return err
	}
	if f.NArg() != 0 || !validProviderName(*name) || (*envName == "") == (*headerName == "") || !validMCPCredentialName(*envName, *headerName) {
		return errors.New("用法：lake mcp login --name 服务名 (--env 变量名 | --header 请求头名)")
	}
	servers, err := configuredMCPServers(root)
	if err != nil {
		return err
	}
	found := false
	for _, server := range servers {
		if server.Name != *name {
			continue
		}
		found = true
		if (*envName != "" && server.Transport != "stdio") || (*headerName != "" && server.Transport != "http") {
			return errors.New("凭据类型与 MCP 传输方式不匹配")
		}
		break
	}
	if !found {
		return errors.New("MCP 服务不存在")
	}
	if _, err := io.WriteString(errOut, "凭据值: "); err != nil {
		return err
	}
	value, err := readSecret(input)
	if err != nil {
		return err
	}
	defer clearBytes(value)
	if len(value) == 0 || len(value) > 65536 {
		return errors.New("凭据值为空或过长")
	}
	vault := credential.FileVault{Root: root}
	previous, err := vault.LoadMCPSecrets(*name)
	if err != nil {
		return err
	}
	var saved mcpSecrets
	if len(previous) != 0 {
		if err := json.Unmarshal(previous, &saved); err != nil {
			return errors.New("MCP 凭据文件格式无效")
		}
	}
	if *envName != "" {
		if saved.Env == nil {
			saved.Env = map[string]string{}
		}
		saved.Env[*envName] = string(value)
	} else {
		if saved.Headers == nil {
			saved.Headers = map[string]string{}
		}
		saved.Headers[*headerName] = string(value)
	}
	data, err := json.Marshal(saved)
	if err != nil {
		return err
	}
	if err := vault.PutMCPSecrets(*name, data); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "已保存 MCP 服务 %s 的凭据\n", *name)
	return err
}

func validMCPCredentialName(envName, headerName string) bool {
	if envName != "" {
		if len(envName) > 128 || !((envName[0] >= 'A' && envName[0] <= 'Z') || (envName[0] >= 'a' && envName[0] <= 'z') || envName[0] == '_') {
			return false
		}
		for _, c := range envName[1:] {
			if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
				return false
			}
		}
		return true
	}
	if headerName == "" || len(headerName) > 128 {
		return false
	}
	for _, c := range headerName {
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || strings.ContainsRune("!#$%&'*+-.^_`|~", c)) {
			return false
		}
	}
	return true
}
