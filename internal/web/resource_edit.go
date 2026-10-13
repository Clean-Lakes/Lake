package web

import "net/http"

func terminalConnectionSignature(kind string, config Object) string {
	interactiveShell := shellName(config["shell"])
	if stringOf(config["shell"]) == "" {
		interactiveShell = "bash"
	}
	if kind == "local" {
		return jsonText(Object{"shell": shellName(config["shell"]), "interactive_shell": interactiveShell})
	}
	port := integer(config["port"])
	if port == 0 {
		port = 22
	}
	mode := stringOf(config["authMethod"])
	if mode == "" {
		mode = "key"
	}
	return jsonText(Object{"host": config["host"], "port": port, "username": config["username"], "shell": shellName(config["shell"]), "interactive_shell": interactiveShell, "authMethod": mode, "identityFile": stringOf(config["identityFile"]), "credentialRef": stringOf(config["credentialRef"])})
}

func mergeSSHResourceEdit(old, input Object) Object {
	allowed := set("host port username shell authMethod identityFile credentialRef password passphrase privateKey")
	merged := Object{}
	for _, key := range []string{"host", "port", "username", "shell", "authMethod", "identityFile", "credentialRef"} {
		if value, ok := old[key]; ok {
			merged[key] = value
		}
	}
	for key, value := range input {
		if !allowed[key] {
			fail(400, "不支持的 SSH 配置字段")
		}
		if key != "port" && value != nil {
			if _, ok := value.(string); !ok {
				fail(400, "SSH 配置字段须为文本")
			}
		}
		if (key == "credentialRef" || key == "identityFile") && value != nil && stringOf(value) != "" && value != old[key] {
			fail(400, "更换密钥请上传私钥文件，不接受其他资源的凭据引用")
		}
		if value != nil {
			merged[key] = value
		}
	}
	mode := stringOf(merged["authMethod"])
	if mode == "" {
		mode = "key"
	}
	oldMode := stringOf(old["authMethod"])
	if oldMode == "" {
		oldMode = "key"
	}
	if mode != oldMode || input["privateKey"] != nil {
		delete(merged, "credentialRef")
		delete(merged, "identityFile")
	}
	// Blank secret inputs explicitly mean keep existing credentials. A mode/key
	// change above removes incompatible references and requires new material.
	for _, key := range []string{"password", "passphrase"} {
		if stringOf(merged[key]) == "" {
			delete(merged, key)
		}
	}
	return merged
}

func (s *Store) EditTerminalResource(id, name string, config Object, changed bool) Object {
	return s.update(func() any {
		resource := s.resource(id)
		project := stringOf(resource["projectId"])
		if changed {
			s.projectIdleForDeletion(project)
			s.resourceIdleForChange(id, "修改连接配置")
		}
		description := stringOf(resource["description"])
		if resource["kind"] == "ssh" && changed {
			description = stringOf(config["username"]) + "@" + stringOf(config["host"]) + ":" + jsonText(integer(config["port"]))
		}
		s.exec("UPDATE resources SET name=?,description=? WHERE id=?", name, description, id)
		s.exec("INSERT INTO resourceConnections(resourceId,config) VALUES(?,?) ON CONFLICT(resourceId) DO UPDATE SET config=excluded.config", id, jsonText(config))
		for _, session := range s.rows("SELECT id FROM sessions WHERE projectId=?", project) {
			s.event(stringOf(session["id"]), "session")
		}
		return s.resource(id)
	}).(Object)
}

func (b *Server) editTerminalResourceRoute(w http.ResponseWriter, r *http.Request, id string) {
	b.messageMu.Lock()
	defer b.messageMu.Unlock()
	resource := b.Store.Resource(id)
	kind := stringOf(resource["kind"])
	if kind != "ssh" && kind != "local" {
		fail(400, "当前仅支持编辑本机与 SSH 终端配置")
	}
	data := body(w, r, 2<<20)
	for key := range data {
		if key != "name" && !(kind == "ssh" && key == "ssh") && !(kind == "local" && key == "settings") {
			fail(400, "不支持的终端配置字段")
		}
	}
	name := text(data["name"], "资源名称", 120)
	if b.Terminals.titleInput(name) != name {
		fail(400, "名称包含敏感凭据，请改用描述性名称")
	}
	field := "settings"
	if kind == "ssh" {
		field = "ssh"
	}
	old := object(resource[field])
	config := old
	cleanup := func() {}
	saved := false
	defer func() {
		if !saved {
			cleanup()
		}
	}()
	if value, present := data[field]; present {
		input, ok := value.(map[string]any)
		if !ok {
			fail(400, "连接配置须为对象")
		}
		if kind == "ssh" {
			config, cleanup = prepareSSH(b.Models.Home, mergeSSHResourceEdit(old, input))
		} else {
			for key := range input {
				if key != "shell" {
					fail(400, "本机终端仅支持修改 Shell")
				}
			}
			config = Object{}
			for key, value := range old {
				config[key] = value
			}
			if value, exists := input["shell"]; exists {
				if _, ok := value.(string); !ok {
					fail(400, "Shell 须为文本")
				}
				config["shell"] = shellName(value)
			}
		}
	}
	changed := terminalConnectionSignature(kind, old) != terminalConnectionSignature(kind, config)
	if changed {
		for sid, running := range b.runningMessages {
			if running && b.Store.Session(sid)["projectId"] == resource["projectId"] {
				fail(409, "请等待项目中本轮 AI 任务结束后修改连接配置")
			}
		}
	}
	// Serialize with terminal admission. No online terminal can appear between
	// the idle check and commit and retain the old target under the new label.
	result := func() Object {
		b.Terminals.mu.Lock()
		defer b.Terminals.mu.Unlock()
		return b.Store.EditTerminalResource(id, name, config, changed)
	}()
	saved = true
	if changed {
		for _, session := range objects(b.Store.Catalog()["sessions"]) {
			if session["projectId"] == resource["projectId"] {
				b.resetConnectionFailures(stringOf(session["id"]))
			}
		}
	}
	reply(w, 200, result)
}
