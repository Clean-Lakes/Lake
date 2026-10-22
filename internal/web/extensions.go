package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/extensions"
)

func extensionError(err error) {
	if err != nil {
		fail(400, err.Error())
	}
}
func (b *Server) extensionRoute(w http.ResponseWriter, r *http.Request, path string) bool {
	if !strings.HasPrefix(path, "/api/settings/mcp") && !strings.HasPrefix(path, "/api/settings/skills") {
		return false
	}
	store := b.Extensions.Store
	if path == "/api/settings/mcp/import" && r.Method == "POST" {
		data := body(w, r, 100000)
		raw, _ := json.Marshal(data)
		rows, err := extensions.ParseServerImport(raw)
		extensionError(err)
		for i := range rows {
			rows[i].ID = ident()
		}
		extensionError(store.ImportServers(rows))
		public := []Object{}
		for _, row := range rows {
			public = append(public, extensions.PublicServer(row))
		}
		reply(w, 200, Object{"servers": public})
		return true
	}
	if path == "/api/settings/mcp" && r.Method == "GET" {
		c, err := store.Read()
		extensionError(err)
		rows := []Object{}
		for _, v := range c.Servers {
			rows = append(rows, extensions.PublicServer(v))
		}
		reply(w, 200, Object{"servers": rows})
		return true
	}
	if path == "/api/settings/mcp" && r.Method == "POST" || strings.HasPrefix(path, "/api/settings/mcp/") && r.Method == "PUT" {
		data := body(w, r, 100000)
		var next extensions.Server
		raw, _ := json.Marshal(data)
		if json.Unmarshal(raw, &next) != nil {
			fail(400, "MCP 配置格式无效")
		}
		if r.Method == "POST" {
			next.ID = ident()
		} else {
			next.ID = strings.TrimPrefix(path, "/api/settings/mcp/")
			old, err := store.FindServer(next.ID)
			if err != nil {
				fail(404, "MCP 服务不存在")
			}
			if _, ok := data["timeoutMs"]; !ok {
				next.TimeoutMS = old.TimeoutMS
			}
			if _, ok := data["protocolVersion"]; !ok {
				next.ProtocolVersion = old.ProtocolVersion
			}
		}
		if clear, _ := data["clearHeaders"].(bool); clear {
			next.Headers = map[string]string{}
		}
		if clear, _ := data["clearEnv"].(bool); clear {
			next.Env = map[string]string{}
		}
		extensionError(store.SaveServer(next, next.Headers != nil, next.Env != nil))
		b.Extensions.Invalidate(next.ID)
		saved, err := store.FindServer(next.ID)
		extensionError(err)
		reply(w, 200, extensions.PublicServer(saved))
		return true
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) >= 4 && parts[2] == "mcp" {
		id := parts[3]
		if len(parts) == 4 && r.Method == "DELETE" {
			extensionError(store.DeleteServer(id))
			b.Extensions.Invalidate(id)
			reply(w, 200, Object{"ok": true})
			return true
		}
		if len(parts) == 5 && parts[4] == "test" && r.Method == "POST" {
			result, err := b.Extensions.Tools(r.Context(), id, true)
			extensionError(err)
			reply(w, 200, result)
			return true
		}
	}
	if path == "/api/settings/skills" && r.Method == "GET" {
		c, err := store.Read()
		extensionError(err)
		skills, err := store.ScanSkills("")
		extensionError(err)
		reply(w, 200, Object{"skills": skills, "roots": append([]string{}, c.SkillRoots...), "defaultRoot": store.Home + "/skills"})
		return true
	}
	if path == "/api/settings/skills/roots" {
		if r.Method == "POST" {
			data := body(w, r, 8000)
			extensionError(store.AddSkillRoot(stringOf(data["path"])))
			reply(w, 200, Object{"ok": true})
			return true
		}
		if r.Method == "DELETE" {
			data := body(w, r, 8000)
			extensionError(store.RemoveSkillRoot(stringOf(data["path"])))
			reply(w, 200, Object{"ok": true})
			return true
		}
	}
	if len(parts) == 4 && parts[2] == "skills" && extensions.Identifier.MatchString(parts[3]) {
		name := parts[3]
		if r.Method == "GET" {
			meta, content, err := store.ReadSkill(name, "")
			extensionError(err)
			reply(w, 200, Object{"skill": meta, "content": content})
			return true
		}
		if r.Method == "PUT" {
			data := body(w, r, 650000)
			if content, ok := data["content"].(string); ok {
				extensionError(store.SaveSkill(name, content, data["create"] == true))
			} else {
				if _, _, err := store.ReadSkill(name, ""); err != nil {
					fail(404, "Skill 不存在")
				}
			}
			if enabled, ok := data["enabled"].(bool); ok {
				extensionError(store.SetSkillEnabled(name, enabled))
			}
			reply(w, 200, Object{"ok": true})
			return true
		}
	}
	fail(404, "扩展配置接口不存在")
	return true
}
func (b *Server) extensionBridge(ctx context.Context, id, name string, args Object, approved bool) (any, error) {
	b.Store.Session(id)
	if name != "list_mcp_servers" {
		server, err := b.Extensions.Store.FindServer(stringOf(args["server_id"]))
		if err != nil {
			return nil, err
		}
		if !server.Enabled {
			return nil, errors.New("MCP 服务已停用")
		}
		if stringOf(args["configurationRevision"]) != extensions.ServerRevision(server) {
			return nil, errors.New("MCP 配置已变更，请重新发起调用")
		}
	}
	switch name {
	case "list_mcp_servers":
		c, err := b.Extensions.Store.Read()
		if err != nil {
			return nil, err
		}
		rows := []Object{}
		for _, s := range c.Servers {
			if s.Enabled {
				rows = append(rows, Object{"id": s.ID, "name": s.Name, "transport": s.Transport})
			}
		}
		return Object{"servers": rows}, nil
	case "list_mcp_tools":
		server, err := b.Extensions.Store.FindServer(stringOf(args["server_id"]))
		if err != nil {
			return nil, err
		}
		if server.Transport == "stdio" && !approved {
			return nil, errors.New("启动本机 MCP 需要本次授权")
		}
		return b.Extensions.Tools(ctx, server.ID, false)
	case "call_mcp_tool":
		if !approved {
			return nil, errors.New("调用 MCP 工具需要本次授权")
		}
		return b.Extensions.Call(ctx, stringOf(args["server_id"]), stringOf(args["tool"]), object(args["arguments"]))
	}
	return nil, errors.New("扩展工具不存在")
}
