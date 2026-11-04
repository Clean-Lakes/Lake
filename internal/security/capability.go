package security

import "slices"

const RegistryVersion = "lake-tools/1"

type ToolCapability struct {
	Name                  string
	TargetKind            TargetKind
	Capabilities          []string
	Proof                 ProofLevel
	CommandProfileAllowed bool
}

// LookupTool is closed: a tool absent from this registry never inherits a
// readonly default. Opaque entries intentionally cannot obtain task grants.
func LookupTool(name string) (ToolCapability, bool) {
	entry, ok := toolCapabilities[name]
	entry.Capabilities = slices.Clone(entry.Capabilities)
	return entry, ok
}

func RegisteredTools() []string {
	names := make([]string, 0, len(toolCapabilities))
	for name := range toolCapabilities {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func KnownCapability(name string) bool { return slices.Contains(knownCapabilities, name) }

// For the authenticated policy editor; this registry does not grant authority.
func KnownCapabilities() []string { return slices.Clone(knownCapabilities) }

// TaskGrantable is an additional fixed ceiling, independent of a policy rule.
// Policy cannot turn arbitrary Shell, file/SQL writes or MCP into task wildcards.
func TaskGrantable(name string, proof ProofLevel) bool {
	if name == "local.execute" && proof == ProofStructured {
		return true
	}
	if proof == ProofOpaque {
		return false
	}
	switch name {
	case "resource.list", "resource.resolve", "file.read", "db.read", "cluster.read", "cluster.logs", "memory.read", "artifact.read", "network.fetch", "mcp.discover", "terminal.open":
		return proof == ProofStructured || proof == ProofCommandProfile
	case "command.diagnostics", "service.restart", "local.execute", "terminal.execute":
		return proof == ProofCommandProfile
	}
	return false
}

var knownCapabilities = []string{
	"resource.list", "resource.resolve", "resource.manage", "file.read", "file.write", "file.delete",
	"db.read", "db.write", "cluster.read", "cluster.logs", "cluster.write",
	"terminal.open", "terminal.adopt", "terminal.execute", "terminal.input", "terminal.interrupt", "terminal.close", "terminal.read",
	"command.diagnostics", "service.restart", "local.execute", "network.fetch", "network.search", "network.tunnel", "transfer.copy",
	"mcp.discover", "mcp.call", "memory.read", "memory.write", "workflow.read", "workflow.manage", "workflow.run", "schedule.read", "schedule.manage", "task.control", "task.read", "artifact.read", "artifact.write", "session.read", "session.write",
}

func tool(name string, target TargetKind, proof ProofLevel, caps ...string) ToolCapability {
	return ToolCapability{Name: name, TargetKind: target, Proof: proof, Capabilities: caps}
}

var toolCapabilities = map[string]ToolCapability{
	"append":                        tool("append", TargetResource, ProofStructured, "file.write"),
	"edit":                          tool("edit", TargetResource, ProofStructured, "file.write"),
	"multi_edit":                    tool("multi_edit", TargetResource, ProofStructured, "file.write"),
	"write":                         tool("write", TargetResource, ProofStructured, "file.write"),
	"delete":                        tool("delete", TargetResource, ProofStructured, "file.delete"),
	"glob":                          tool("glob", TargetResource, ProofStructured, "file.read"),
	"grep":                          tool("grep", TargetResource, ProofStructured, "file.read"),
	"ls":                            tool("ls", TargetResource, ProofStructured, "file.read"),
	"read":                          tool("read", TargetResource, ProofStructured, "file.read"),
	"ask_user_question":             tool("ask_user_question", TargetSession, ProofStructured, "task.control"),
	"call_mcp_tool":                 tool("call_mcp_tool", TargetProject, ProofOpaque, "mcp.call"),
	"list_mcp_servers":              tool("list_mcp_servers", TargetProject, ProofStructured, "mcp.discover"),
	"list_mcp_tools":                tool("list_mcp_tools", TargetProject, ProofStructured, "mcp.discover"),
	"close_ssh_terminal":            tool("close_ssh_terminal", TargetResource, ProofOpaque, "terminal.close"),
	"open_ssh_terminal":             tool("open_ssh_terminal", TargetResource, ProofOpaque, "terminal.open"),
	"list_ssh_terminals":            tool("list_ssh_terminals", TargetProject, ProofStructured, "resource.list"),
	"read_terminal_screen":          tool("read_terminal_screen", TargetResource, ProofStructured, "terminal.read"),
	"shell_output":                  tool("shell_output", TargetSession, ProofStructured, "task.read"),
	"wait_shell":                    tool("wait_shell", TargetSession, ProofStructured, "task.read"),
	"kill_shell":                    tool("kill_shell", TargetResource, ProofOpaque, "terminal.interrupt"),
	"shell":                         {Name: "shell", TargetKind: TargetResource, Proof: ProofOpaque, Capabilities: []string{"terminal.execute"}, CommandProfileAllowed: true},
	"terminal_execute_command":      {Name: "terminal_execute_command", TargetKind: TargetResource, Proof: ProofOpaque, Capabilities: []string{"terminal.execute"}, CommandProfileAllowed: true},
	"ssh_terminal_expect":           tool("ssh_terminal_expect", TargetResource, ProofOpaque, "terminal.input"),
	"ssh_terminal_key":              tool("ssh_terminal_key", TargetResource, ProofOpaque, "terminal.input"),
	"ssh_terminal_read":             tool("ssh_terminal_read", TargetResource, ProofStructured, "terminal.read"),
	"ssh_terminal_send":             tool("ssh_terminal_send", TargetResource, ProofOpaque, "terminal.input"),
	"terminal_expect":               tool("terminal_expect", TargetResource, ProofOpaque, "terminal.input"),
	"terminal_send_input":           tool("terminal_send_input", TargetResource, ProofOpaque, "terminal.input"),
	"terminal_send_key":             tool("terminal_send_key", TargetResource, ProofOpaque, "terminal.input"),
	"close_ssh_tunnel":              tool("close_ssh_tunnel", TargetResourceSet, ProofOpaque, "network.tunnel"),
	"open_ssh_tunnel":               tool("open_ssh_tunnel", TargetResourceSet, ProofOpaque, "network.tunnel"),
	"scp_transfer":                  tool("scp_transfer", TargetResourceSet, ProofOpaque, "transfer.copy"),
	"stage_attachment":              tool("stage_attachment", TargetResource, ProofOpaque, "file.write"),
	"db_table_ddl":                  tool("db_table_ddl", TargetResource, ProofStructured, "db.read"),
	"execute_sql":                   tool("execute_sql", TargetResource, ProofOpaque, "db.write"),
	"redis_command":                 tool("redis_command", TargetResource, ProofOpaque, "db.write"),
	"list_db_objects":               tool("list_db_objects", TargetResource, ProofStructured, "db.read"),
	"docker_container_action":       tool("docker_container_action", TargetResource, ProofOpaque, "cluster.write"),
	"docker_container_logs":         tool("docker_container_logs", TargetResource, ProofStructured, "cluster.logs"),
	"list_docker_containers":        tool("list_docker_containers", TargetResource, ProofStructured, "cluster.read"),
	"kubernetes_action":             tool("kubernetes_action", TargetResource, ProofOpaque, "cluster.write"),
	"kubernetes_capabilities":       tool("kubernetes_capabilities", TargetResource, ProofStructured, "cluster.read"),
	"query_kubernetes":              tool("query_kubernetes", TargetResource, ProofStructured, "cluster.read"),
	"observe_cluster":               tool("observe_cluster", TargetResource, ProofStructured, "cluster.read"),
	"observe_cluster_logs":          tool("observe_cluster_logs", TargetResource, ProofStructured, "cluster.logs"),
	"observe_data":                  tool("observe_data", TargetResource, ProofStructured, "db.read"),
	"observe_host":                  {Name: "observe_host", TargetKind: TargetResource, Proof: ProofStructured, Capabilities: []string{"command.diagnostics"}, CommandProfileAllowed: true},
	"observe_journal":               tool("observe_journal", TargetResource, ProofStructured, "cluster.logs"),
	"observe_logs":                  tool("observe_logs", TargetResource, ProofStructured, "file.read"),
	"inspect_host":                  {Name: "inspect_host", TargetKind: TargetResource, Proof: ProofStructured, Capabilities: []string{"command.diagnostics"}, CommandProfileAllowed: true},
	"list_assets":                   tool("list_assets", TargetProject, ProofStructured, "resource.list"),
	"list_resource_groups":          tool("list_resource_groups", TargetProject, ProofStructured, "resource.list"),
	"preview_resource_import":       tool("preview_resource_import", TargetProject, ProofStructured, "resource.resolve"),
	"import_resources":              tool("import_resources", TargetProject, ProofOpaque, "resource.manage"),
	"forget_project_memory":         tool("forget_project_memory", TargetProject, ProofStructured, "memory.write"),
	"save_project_memory":           tool("save_project_memory", TargetProject, ProofStructured, "memory.write"),
	"list_memory_preferences":       tool("list_memory_preferences", TargetProject, ProofStructured, "memory.read"),
	"list_project_memories":         tool("list_project_memories", TargetProject, ProofStructured, "memory.read"),
	"read_memory_preference":        tool("read_memory_preference", TargetProject, ProofStructured, "memory.read"),
	"read_project_memory":           tool("read_project_memory", TargetProject, ProofStructured, "memory.read"),
	"inspect_attachment":            tool("inspect_attachment", TargetSession, ProofStructured, "artifact.read"),
	"load_skill":                    tool("load_skill", TargetProject, ProofStructured, "artifact.read"),
	"read_session_context":          tool("read_session_context", TargetSession, ProofStructured, "session.read"),
	"read_tool_result":              tool("read_tool_result", TargetSession, ProofStructured, "artifact.read"),
	"read_referenced_task_evidence": tool("read_referenced_task_evidence", TargetSession, ProofStructured, "task.read"),
	"render_chart":                  tool("render_chart", TargetSession, ProofStructured, "artifact.write"),
	"todo_read":                     tool("todo_read", TargetSession, ProofStructured, "task.read"),
	"todo_write":                    tool("todo_write", TargetSession, ProofStructured, "task.control"),
	"get_workflow_run":              tool("get_workflow_run", TargetProject, ProofStructured, "workflow.read"),
	"list_workflows":                tool("list_workflows", TargetProject, ProofStructured, "workflow.read"),
	"run_workflow":                  tool("run_workflow", TargetProject, ProofOpaque, "workflow.run"),
	"save_workflow":                 tool("save_workflow", TargetProject, ProofStructured, "workflow.manage"),
	"schedule_create":               tool("schedule_create", TargetProject, ProofStructured, "schedule.manage"),
	"schedule_delete":               tool("schedule_delete", TargetProject, ProofStructured, "schedule.manage"),
	"schedule_list":                 tool("schedule_list", TargetProject, ProofStructured, "schedule.read"),
	"schedule_update":               tool("schedule_update", TargetProject, ProofStructured, "schedule.manage"),
	"delegate_investigation":        tool("delegate_investigation", TargetSession, ProofStructured, "task.control"),
	"read_evidence":                 tool("read_evidence", TargetSession, ProofStructured, "task.read"),
	"read_investigation":            tool("read_investigation", TargetSession, ProofStructured, "task.read"),
	"pilot_offer_directions":        tool("pilot_offer_directions", TargetSession, ProofStructured, "task.control"),
	"pilot_read_recovery":           tool("pilot_read_recovery", TargetSession, ProofStructured, "task.read"),
	"sre_collaborate":               tool("sre_collaborate", TargetSession, ProofStructured, "task.control"),
	"sre_reply":                     tool("sre_reply", TargetSession, ProofStructured, "task.control"),
	"sre_team_read":                 tool("sre_team_read", TargetSession, ProofStructured, "task.read"),
	"sre_team_update":               tool("sre_team_update", TargetSession, ProofStructured, "task.control"),
	"task_output":                   tool("task_output", TargetSession, ProofStructured, "task.read"),
	"task_stop":                     tool("task_stop", TargetSession, ProofStructured, "task.control"),
	"web_fetch":                     tool("web_fetch", TargetNone, ProofStructured, "network.fetch"),
	"web_search":                    tool("web_search", TargetNone, ProofStructured, "network.search"),
	"work_begin":                    tool("work_begin", TargetSession, ProofStructured, "task.control"),
	"work_finish":                   tool("work_finish", TargetSession, ProofStructured, "task.control"),
	"work_read":                     tool("work_read", TargetSession, ProofStructured, "task.read"),
	"work_update":                   tool("work_update", TargetSession, ProofStructured, "task.control"),
	"work_wait":                     tool("work_wait", TargetSession, ProofStructured, "task.control"),
}
