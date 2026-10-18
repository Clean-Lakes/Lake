package ai

import (
	"errors"
	"strings"
)

func sameSREArguments(arguments string, expected map[string]any) bool {
	var actual map[string]any
	return decodeSREJSON(arguments, &actual) == nil && js(actual) == js(expected)
}

// Specialists use the normal catalog and policy. Scheduling belongs to the parent.
func (e *Engine) sreFullCatalog(c Config) []Tool {
	out := []Tool{}
	seen := map[string]bool{}
	for _, tool := range Catalog("core") {
		if tool.Name == "delegate_investigation" || tool.Name == "read_investigation" || tool.Name == "run_workflow" || strings.HasPrefix(tool.Name, "schedule_") {
			continue
		}
		out = append(out, tool)
		seen[tool.Name] = true
	}
	// Preserve support for saved plans and typed runtime verification.
	for _, domain := range []string{"host", "application", "data"} {
		for _, tool := range childObservationTools(domain, c.Assets) {
			if !seen[tool.Name] {
				out = append(out, tool)
				seen[tool.Name] = true
			}
		}
	}
	out = append(out, Tool{Name: "read_evidence", Description: "Page this specialist's own recorded tool results by evidence ID, without rerunning an operation.", Parameters: evidenceReadSchema()})
	if c.sre != nil && c.sre.AttemptID != "" {
		out = append(out, sreTeamTools()...)
	}
	if c.MemoryEnabled && e.Bridge != nil {
		out = append(out, projectMemoryTools()...)
	}
	return e.configuredExtensionTools(c, out)
}

func sreTrackedCall(c Config, call Call) bool {
	if c.sre == nil || c.sre.AttemptID == "" {
		return false
	}
	if !c.sre.FullTools {
		return c.sre.Role == SREExecutor
	}
	return strings.Contains(" stage_attachment shell terminal_execute_command ssh_terminal_send terminal_send_input ssh_terminal_key terminal_send_key write edit multi_edit append delete execute_sql redis_command docker_container_action scp_transfer call_mcp_tool ", " "+call.Name+" ")
}

func sreEvidenceCall(name string) bool {
	if strings.HasPrefix(name, "sre_team_") {
		return false
	}
	if strings.HasPrefix(name, "observe_") || name == "read_evidence" || name == "read_tool_result" || memoryTool(name) {
		return false
	}
	if sessionTool(name) {
		return name == "call_mcp_tool"
	}
	return name != "list_assets" && name != "list_resource_groups" && name != "render_chart"
}

func (e *Engine) recordSREToolResult(c Config, call Call, a map[string]any, result any, toolErr error) (any, error) {
	if errors.Is(toolErr, errADKApprovalPending) || e.worker == nil || c.sre == nil || !c.sre.FullTools || !sreEvidenceCall(call.Name) {
		return result, toolErr
	}
	ref := str(a["asset_ref"])
	if ref == "" {
		ref = c.AssetRef
	}
	if ref == "" && len(c.sre.Step.ResourceIDs) > 0 {
		ref = c.sre.Step.ResourceIDs[0]
	}
	as, err := asset(c, ref)
	if err != nil {
		return result, toolErr
	}
	observationErr := toolErr
	if observationErr == nil && obj(result)["exitCode"] != nil && num(obj(result)["exitCode"], 0) != 0 {
		observationErr = errors.New("工具退出码非零，不能作为成功证据")
	}
	if observationErr == nil && (obj(result)["status"] == "running" || obj(result)["status"] == "unknown" || obj(result)["running"] == true) {
		observationErr = errors.New("工具仍在运行，尚无完成结果")
	}
	value, recordErr := e.recordObservation(c, as.ID, call.Name, result, observationErr)
	if recordErr != nil && observationErr == nil {
		return result, recordErr
	}
	if result == nil {
		return value, toolErr
	}
	merged := map[string]any{}
	if original, ok := result.(map[string]any); ok {
		for k, v := range original {
			merged[k] = v
		}
	} else {
		merged["result"] = result
	}
	for _, key := range []string{"evidence_id", "collected_at", "success", "source_bytes", "source_truncated", "read_hint"} {
		if obj(value)[key] != nil {
			merged[key] = obj(value)[key]
		}
	}
	return merged, toolErr
}
