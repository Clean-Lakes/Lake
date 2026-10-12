package ai

import (
	"errors"
	"strings"
)

type Permissions struct {
	SilentReadFiles         bool `json:"silentReadFiles"`
	SilentWriteFiles        bool `json:"silentWriteFiles"`
	SilentReadSQL           bool `json:"silentReadSQL"`
	SilentCommands          bool `json:"silentCommands"`
	SilentTerminalCreation  bool `json:"silentTerminalCreation"`
	BlockUnreferencedAssets bool `json:"blockUnreferencedAssets"`
	DenyLocalExecution      bool `json:"denyLocalExecution"`
}

func DefaultPermissions() Permissions {
	return Permissions{SilentReadFiles: true, SilentReadSQL: true}
}

func approvalKind(c Config, name, risk string, context map[string]any) (string, error) {
	p := DefaultPermissions()
	if c.Permissions != nil {
		p = *c.Permissions
	} else {
		p.SilentTerminalCreation = true // Preserve standalone callers' behavior.
	}
	hostCommand := strings.Contains(" shell inspect_host open_ssh_terminal terminal_execute_command ssh_terminal_send terminal_send_input ssh_terminal_key terminal_send_key ssh_terminal_expect terminal_expect ", " "+name+" ")
	if p.DenyLocalExecution && hostCommand && str(context["runtime"]) == "local" {
		return "", errors.New("当前会话禁止本机执行；请引用 SSH 主机或修改权限设置")
	}
	ref := str(context["asset_ref"])
	if p.BlockUnreferencedAssets && name != "list_assets" && name != "render_chart" && !strings.HasPrefix(name, "web_") {
		allowed := false
		for _, r := range c.ReferencedAssets {
			if r == ref {
				allowed = true
			}
		}
		if !allowed {
			return "", errors.New("当前会话仅允许操作已引用或明确批准的资源；请先 @ 引用目标资源")
		}
	}
	if context["needsAdoption"] == true {
		return "adopt_terminal", nil
	}
	commandTool := hostCommand || name == "delete" || name == "kill_shell" || name == "close_ssh_terminal"
	silentCommand := p.SilentCommands && commandTool
	if context["catastrophic"] == true {
		return "delete", nil
	}
	if risk == "dangerous" && !silentCommand {
		if name == "delete" || context["destructive"] == true {
			return "delete", nil
		}
		return "operation", nil
	}
	if context["needsTarget"] == true {
		return "resource_select", nil
	}
	if context["needsTerminal"] == true && !p.SilentTerminalCreation && !silentCommand && context["hostKeyCreation"] != true {
		return "terminal_open", nil
	}
	if silentCommand {
		return "", nil
	}
	switch name {
	case "ls", "glob", "grep", "read":
		if !p.SilentReadFiles {
			return "file_read", nil
		}
	case "write", "edit", "multi_edit", "append":
		if !p.SilentWriteFiles {
			return "file_write", nil
		}
	case "execute_sql", "list_db_objects", "db_table_ddl":
		if risk != "readonly" {
			return "operation", nil
		}
		if !p.SilentReadSQL {
			return "readonly_sql", nil
		}
	case "shell", "terminal_execute_command", "ssh_terminal_send", "terminal_send_input", "ssh_terminal_key", "terminal_send_key":
		if !p.SilentCommands && risk != "readonly" {
			return "command", nil
		}
	case "inspect_host":
		// Authorized terminals allow fixed bounded context inspection; arbitrary
		// model commands continue through their separate command gate.
	default:
		if risk != "readonly" {
			return "operation", nil
		}
	}
	return "", nil
}
