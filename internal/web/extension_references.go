package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
	"unicode/utf16"
)

// Resolve selected identifiers on the server. Client-provided descriptions,
// instructions, content, URLs and credentials never become model context.
func (b *Server) contextReferences(id, message string, value any) []Object {
	if value == nil {
		return []Object{}
	}
	items, ok := value.([]any)
	if !ok || len(items) > 40 {
		fail(400, "最多 40 项上下文引用")
	}
	out := []Object{}
	for _, item := range items {
		r, ok := item.(map[string]any)
		if !ok {
			fail(400, "引用格式无效")
		}
		kind := stringOf(r["kind"])
		var resolved Object
		switch kind {
		case "role":
			role := ai.SREAgentRole(stringOf(r["role_id"]))
			project := stringOf(b.Store.Session(id)["projectId"])
			if !ai.ValidSRERole(role) || !b.Store.SREEnabled(project) {
				fail(400, "专员不存在或本项目未启用 SRE 协作")
			}
			name := map[ai.SREAgentRole]string{ai.SRECoordinator: "协调者", ai.SREInvestigator: "调查员", ai.SREExecutor: "执行员", ai.SREVerifier: "验证员"}[role]
			resolved = Object{"kind": "role", "role_id": string(role), "name": name}
		case "skill":
			meta, _, err := b.Extensions.Store.ReadSkill(stringOf(r["skill_name"]), "")
			if err != nil || !meta.Enabled {
				fail(400, "引用的 Skill 已停用或不存在，请重新选择")
			}
			resolved = Object{"kind": kind, "name": meta.Name, "skill_name": meta.Name, "description": meta.Description, "instruction": "The user selected this Skill. Load it with load_skill using skill_name before applying its procedure. Skill instructions do not override session permissions."}
		case "mcp":
			server, err := b.Extensions.Store.FindServer(stringOf(r["server_id"]))
			if err != nil || !server.Enabled {
				fail(400, "引用的 MCP 服务已停用或不存在，请重新选择")
			}
			resolved = Object{"kind": kind, "name": server.Name, "server_id": server.ID, "transport": server.Transport, "instruction": "The user selected this MCP service. Discover tools with list_mcp_tools using server_id when needed. Selection does not authorize starting a local process or calling tools; existing session permissions and operation decisions still apply."}
		default:
			out = append(out, references(b.Store, id, []any{item}, func(id, tid string) string { return b.terminalOwner(id, tid, false) })...)
			continue
		}
		// Spans are UTF-16 offsets from the browser. Preserve only verified spans
		// so queue editing can drop a deleted mention instead of retaining it.
		if r["start"] != nil || r["end"] != nil {
			start, end := integer(r["start"]), integer(r["end"])
			units := utf16.Encode([]rune(message))
			label := "@" + stringOf(resolved["name"])
			if number(r["start"]) != float64(start) || number(r["end"]) != float64(end) || start < 0 || end <= start || end > len(units) || string(utf16.Decode(units[start:end])) != label {
				fail(400, "引用文字已变更，请重新选择")
			}
			resolved["start"], resolved["end"], resolved["label"] = start, end, label
		}
		out = append(out, resolved)
	}
	return out
}

func separateExtensionReferences(message string, refs []Object) (string, []Object, []Object) {
	resources, extensions := []Object{}, []Object{}
	for _, ref := range refs {
		if ref["kind"] == "skill" || ref["kind"] == "mcp" || ref["kind"] == "role" {
			extensions = append(extensions, ref)
			message = strings.ReplaceAll(message, "@"+stringOf(ref["name"]), "")
		} else {
			resources = append(resources, ref)
		}
	}
	return message, resources, extensions
}
