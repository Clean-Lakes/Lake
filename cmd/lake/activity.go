package main

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	"github.com/cloudwego/eino/lake/store"
)

var activityCredentialFlag = regexp.MustCompile(`(?i)(?:--?(?:password|passwd|token|secret|api[-_]?key)(?:\s|=)|\b(?:password|passwd|token|secret|api[-_]?key)\s+|\bsshpass\b|\bcurl\b.*\s(?:-u|--user)\s|\bmysql\b.*\s-p)`)

// Shared with desktop/Web so new tools cannot silently lose their action label.
//
//go:embed activity_tools.json
var activityCatalogJSON []byte

type activityAction struct {
	Kind   string `json:"kind"`
	Action string `json:"action"`
	Count  int    `json:"count,omitempty"`
}

var activityCatalog = func() map[string]activityAction {
	var catalog map[string]activityAction
	if err := json.Unmarshal(activityCatalogJSON, &catalog); err != nil {
		panic(err)
	}
	return catalog
}()

func toolActivityAction(name, arguments string) activityAction {
	action, ok := activityCatalog[name]
	if !ok {
		return activityAction{Kind: "tool", Action: "调用 " + name}
	}
	var input struct {
		ExpectedSHA256 string `json:"expected_sha256"`
		Files          []struct {
			Delete bool `json:"delete"`
		} `json:"files"`
		Check string `json:"check"`
	}
	if json.Unmarshal([]byte(arguments), &input) != nil {
		return action
	}
	if name == "lake_remote_code_write" {
		if input.ExpectedSHA256 == "absent" {
			return activityAction{Kind: "create", Action: "创建远程文件"}
		}
		return activityAction{Kind: "edit", Action: "编辑远程文件"}
	}
	if name == "lake_code_patch" {
		if len(input.Files) > 0 && len(input.Files) <= 8 {
			action.Count = len(input.Files)
		}
		deletes := 0
		for _, file := range input.Files {
			if file.Delete {
				deletes++
			}
		}
		if deletes > 0 {
			if deletes == len(input.Files) {
				return activityAction{Kind: "delete", Action: "删除文件", Count: action.Count}
			}
			return activityAction{Kind: "edit", Action: "修改和删除文件", Count: action.Count}
		}
	}
	if name == "lake_ssh" {
		checks := map[string]string{"hostname": "检查主机名", "uptime": "检查运行时间", "os": "检查操作系统", "cpu": "检查 CPU", "disk": "检查磁盘", "memory": "检查内存"}
		if check, ok := checks[input.Check]; ok {
			return activityAction{Kind: "query", Action: check}
		}
	}
	return action
}

// Only known display fields leave the tool arguments. File contents, SQL,
// arbitrary MCP parameters and credential fields are never progress details.
func toolActivityPreview(name, arguments string) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(arguments), &fields) != nil {
		return ""
	}
	get := func(key string) string {
		var value string
		_ = json.Unmarshal(fields[key], &value)
		return value
	}
	first := func(keys ...string) string {
		for _, key := range keys {
			if value := get(key); value != "" {
				return value
			}
		}
		return ""
	}
	join := func(values ...string) string {
		var nonempty []string
		for _, value := range values {
			if value != "" {
				nonempty = append(nonempty, value)
			}
		}
		return strings.Join(nonempty, " · ")
	}
	var detail string
	switch name {
	case "lake_code_read", "lake_code_edit", "lake_code_create", "lake_remote_code_read", "lake_remote_code_write", "lake_pdf_read":
		detail = get("path")
	case "lake_code_list":
		detail = get("filter")
	case "lake_code_patch":
		var files []struct {
			Path   string `json:"path"`
			Delete bool   `json:"delete"`
		}
		if json.Unmarshal(fields["files"], &files) == nil {
			var paths []string
			for _, file := range files {
				if len(paths) == 8 {
					break
				}
				label := file.Path
				if file.Delete {
					label += "（删除）"
				}
				paths = append(paths, label)
			}
			detail = strings.Join(paths, "、")
		}
	case "lake_code_checkpoint":
		var paths []string
		if json.Unmarshal(fields["paths"], &paths) == nil {
			if len(paths) > 8 {
				paths = paths[:8]
			}
			detail = strings.Join(paths, "、")
		}
	case "lake_code_restore", "lake_script_read", "lake_browser_snapshot", "lake_browser_close":
		detail = first("id", "session_id")
	case "lake_code_search":
		detail = get("pattern")
	case "lake_web_search":
		detail = get("query")
	case "lake_resources":
		detail = get("lake")
	case "lake_code_run", "lake_remote_code_run":
		detail = get("command")
	case "lake_ssh":
		detail = get("resource")
		if command := get("command"); command != "" {
			detail += " · " + command
		} else if check := get("check"); check != "" {
			detail += " · " + check
		}
	case "lake_ssh_session_open", "lake_ssh_session_close", "lake_script_list", "lake_script_jobs", "lake_link_list":
		detail = get("resource")
	case "lake_database_inspect":
		check := get("check")
		if check != "version" && check != "databases" && check != "tables" {
			check = ""
		}
		detail = join(get("resource"), check)
	case "lake_k8s_get":
		detail = join(get("resource"), get("kind"), get("namespace"), get("name"))
	case "lake_script_start", "lake_script_run", "lake_script_status", "lake_script_wait", "lake_script_cancel":
		detail = join(get("resource"), first("id", "job_id"))
	case "lake_workflow_run", "lake_workflow_create", "lake_workflow_update":
		detail = get("name")
	case "lake_workflow_status", "lake_workflow_v2_run", "lake_workflow_v2_status", "lake_workflow_v2_events", "lake_workflow_v2_resume":
		detail = first("name", "id", "run_id")
	case "lake_workflow_v2_validate", "lake_workflow_v2_dry_run", "lake_workflow_v2_save", "lake_workflow_v2_amend":
		// The definition may contain commands or secrets: extract only its name.
		var definition struct {
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(get("definition_json")), &definition) == nil {
			detail = definition.Name
		}
		if detail == "" {
			detail = get("id")
		}
	case "lake_web_fetch", "lake_browser_open", "lake_browser_navigate":
		if address, err := url.Parse(get("url")); err == nil && address.Hostname() != "" {
			detail = address.Hostname() + address.EscapedPath()
		}
	}
	if activityCredentialFlag.MatchString(detail) {
		detail = "[redacted]"
	}
	detail, _ = store.ExecutionPreview(detail, 240)
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, detail))
}

// A tool can return normally while reporting failure or an unknown remote
// outcome. Completion labels must reflect that result, not just a nil Go error.
func toolActivityStatus(content string) string {
	var output map[string]any
	if json.Unmarshal([]byte(content), &output) != nil {
		return "completed"
	}
	var inspect func(map[string]any, int) string
	inspect = func(value map[string]any, depth int) string {
		if value["unknown"] == true {
			return "unknown"
		}
		status, _ := value["status"].(string)
		switch status {
		case "unknown", "interrupted":
			return "unknown"
		case "cancelled":
			return "cancelled"
		case "failed", "denied", "error":
			return "failed"
		}
		if depth < 2 {
			for _, key := range []string{"text", "result", "task", "run"} {
				if nested, ok := value[key].(map[string]any); ok {
					if result := inspect(nested, depth+1); result != "completed" {
						return result
					}
				}
			}
		}
		if message, ok := value["error"].(string); ok && strings.TrimSpace(message) != "" {
			return "failed"
		}
		if exit, ok := value["exit_code"].(float64); ok && exit != 0 {
			return "failed"
		}
		return "completed"
	}
	return inspect(output, 0)
}

// Persist a controlled category, never rejected arguments or arbitrary error
// values. The UI can distinguish a corrected layout from an operation failure.
func presentationErrorCode(name, content string) string {
	if name != "lake_ui" && name != "lake_visual_report" {
		return ""
	}
	var result struct {
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(content), &result) != nil {
		return ""
	}
	switch result.Error {
	case "invalid_ui", "invalid_report", "presentation_unavailable":
		return result.Error
	}
	return ""
}
