package web

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"path/filepath"
	"strings"
	"time"
)

var defaults = Object{"multiAgentMode": "auto", "reasoningEffort": "", "reasoningModelId": "", "profile": "core", "runtime": "local", "asset_ref": "", "container_id": "", "terminal_id": "", "terminal_generation": "", "userPrompt": "", "contextWindow": 64000, "maxOutput": 8192, "maxSteps": 500, "silentReadFiles": true, "silentWriteFiles": false, "silentReadSQL": true, "silentCommands": false, "silentTerminalCreation": false, "blockUnreferencedAssets": false, "denyLocalExecution": false}

func (b *Server) sessionOptions(id string) Object {
	options := Object{}
	for k, v := range defaults {
		options[k] = v
	}
	for k, v := range b.Store.Options(id) {
		options[k] = v
	}
	return options
}

func (b *Server) configure(id string, updates Object) Object {
	options := b.sessionOptions(id)
	previousPermissions := permissionVersion(options)
	previousTerminal := stringOf(options["terminal_id"])
	for k, v := range updates {
		if _, ok := defaults[k]; !ok {
			fail(400, "Unsupported AI option")
		}
		options[k] = v
	}
	if !set("core terminal2 db-query-editor")[stringOf(options["profile"])] || !set("local ssh container")[stringOf(options["runtime"])] {
		fail(400, "Invalid AI profile/runtime")
	}
	if !set("off auto")[stringOf(options["multiAgentMode"])] {
		fail(400, "Invalid multi-agent mode")
	}
	for _, k := range []string{"asset_ref", "container_id", "terminal_id", "terminal_generation", "userPrompt", "reasoningEffort", "reasoningModelId"} {
		if _, ok := options[k].(string); !ok {
			fail(400, "Invalid AI options")
		}
	}
	if len(stringOf(options["userPrompt"])) > 30000 {
		fail(400, "Invalid AI options")
	}
	permissions := ai.DefaultPermissions()
	for _, k := range []string{"silentReadFiles", "silentWriteFiles", "silentReadSQL", "silentCommands", "silentTerminalCreation", "blockUnreferencedAssets", "denyLocalExecution"} {
		if _, ok := options[k].(bool); !ok {
			fail(400, "Invalid permission option")
		}
	}
	must(json.Unmarshal([]byte(jsonText(options)), &permissions))
	for k, bounds := range map[string][2]int{"contextWindow": {2048, 2000000}, "maxOutput": {1, 1000000}, "maxSteps": {1, 500}} {
		n := integer(options[k])
		if float64(n) != number(options[k]) || n < bounds[0] || n > bounds[1] {
			fail(400, "Invalid AI options")
		}
	}
	if ref := stringOf(options["asset_ref"]); ref != "" {
		b.Store.AssertResource(id, ref)
	}
	if tid := stringOf(options["terminal_id"]); tid != "" {
		term := b.Store.projectTerminal(id, tid)
		if tid != previousTerminal {
			b.ResolveTerminalAccess(id, tid, false)
		}
		if ref := stringOf(options["asset_ref"]); ref != "" && ref != term["resourceId"] {
			fail(400, "Selected terminal and resource must match")
		}
		options["asset_ref"] = term["resourceId"]
		options["runtime"] = b.Store.Resource(stringOf(term["resourceId"]))["kind"]
		options["terminal_generation"] = term["generation"]
	}
	model := b.Models.CachedCapacity(b.Models.Active())
	if model == nil {
		b.Store.SaveOptions(id, options)
		if previousPermissions != permissionVersion(options) {
			b.revokeSessionTerminals(id)
		}
		return options
	}
	modelID := ai.ModelIdentity(*model)
	if options["reasoningModelId"] != modelID {
		if _, explicit := updates["reasoningEffort"]; explicit && stringOf(options["reasoningEffort"]) != "" {
			fail(409, "模型已切换，请重新选择思考级别")
		}
		options["reasoningEffort"] = ""
		options["reasoningModelId"] = modelID
	}
	effort := stringOf(options["reasoningEffort"])
	if !ai.ValidReasoningEffort(*model, effort) {
		if _, explicit := updates["reasoningEffort"]; explicit {
			fail(400, "当前模型不支持此思考级别")
		}
		effort = ""
		options["reasoningEffort"] = ""
	}
	model.ReasoningEffort = effort
	model.ContextWindow = integer(options["contextWindow"])
	model.MaxOutput = integer(options["maxOutput"])
	assets := b.sessionAssets(id)
	// Approvals belong to individual operations; earlier pending actions must not
	// disable this turn's tools. invoke enforces per-operation permissions.
	aiFailure(b.Engine.Configure(id, ai.Config{MultiAgentMode: stringOf(options["multiAgentMode"]), Permissions: &permissions, CredentialDir: filepath.Join(b.Models.Home, "secrets"), Model: *model, Profile: stringOf(options["profile"]), UserPrompt: stringOf(options["userPrompt"]), Runtime: stringOf(options["runtime"]), AssetRef: stringOf(options["asset_ref"]), Container: stringOf(options["container_id"]), TerminalID: stringOf(options["terminal_id"]), Assets: assets, MaxSteps: integer(options["maxSteps"])}))
	b.Store.SaveOptions(id, options)
	if previousPermissions != permissionVersion(options) {
		b.revokeSessionTerminals(id)
	}
	return options
}
func (b *Server) sessionAssets(id string) []ai.Asset {
	assets := []ai.Asset{}
	for _, r := range objects(b.sessionSnapshot(id)["resources"]) {
		var ssh *ai.SSH
		if v := r["ssh"]; v != nil {
			var c ai.SSH
			must(json.Unmarshal([]byte(jsonText(v)), &c))
			ssh = &c
			ssh.KnownHosts = b.Terminals.hostKeyPath(object(r["ssh"]))
		}
		assets = append(assets, ai.Asset{ID: stringOf(r["id"]), Name: stringOf(r["name"]), Kind: stringOf(r["kind"]), SSH: ssh, Settings: object(r["settings"])})
	}
	return assets
}
func (b *Server) handleAI(ctx context.Context, method, id string, data any) (any, error) {
	return b.Engine.Handle(ctx, method, id, json.RawMessage(jsonText(data)))
}
func (b *Server) event(event ai.Event) {
	defer func() { recover() }()
	b.Store.Session(event.Session)
	switch event.Type {
	case "approval":
		b.Store.Status(event.Session, "waiting_approval")
	case "done":
		status := stringOf(object(event.Data)["status"])
		if status == "completed" || status == "cancelled" {
			b.Store.Status(event.Session, "completed")
		} else {
			b.Store.Status(event.Session, "failed")
		}
	default:
		b.Store.Touch(event.Session)
	}
}
func (b *Server) runTurn(id, message string, images []ai.ImageAttachment, refs, files []Object) {
	defer b.workers.Done()
	defer b.finishMessageQueue(id)
	defer b.releaseManualTerminals(id)
	retryMessage := message
	for _, reference := range refs {
		if name := stringOf(reference["name"]); name != "" {
			retryMessage = strings.TrimSpace(strings.TrimPrefix(retryMessage, "@"+name+" "))
		}
	}
	turnContext := b.Context
	if connectionRetryRequested(retryMessage) {
		b.resetConnectionFailures(id)
		turnContext = context.WithValue(turnContext, connectionRetryContextKey{}, true)
	}
	defer func() {
		if p := recover(); p != nil {
			if b.Context.Err() == nil {
				func() {
					defer func() { recover() }()
					msg := "Go AI 未完成本轮请求"
					if f, ok := p.(*Failure); ok {
						msg = f.Message
					}
					b.Store.AddMessage(id, "system", msg, nil)
					b.Store.Status(id, "failed")
				}()
			}
		}
	}()
	if b.Models.Active() == nil {
		fail(400, "尚未配置模型")
	}
	options := b.configure(id, nil)
	simpleConversation := ai.IsBriefConversation(message) && len(refs) == 0 && len(images) == 0 && len(files) == 0
	var prelude []ai.Call
	importRequest := len(files) > 0 || len(refs) == 0 && (strings.Contains(message, "导入") || strings.Contains(strings.ToLower(message), "import"))
	if !simpleConversation && !importRequest {
		prelude = b.hostPrelude(id, refs, options)
	}
	snap := b.sessionSnapshot(id)
	messages := objects(snap["messages"])
	if len(messages) > 12 {
		messages = messages[len(messages)-12:]
	}
	conversation := []Object{}
	for _, m := range messages {
		conversation = append(conversation, Object{"role": m["role"], "text": tail(stringOf(m["text"]), 2000)})
	}
	pending := []Object{}
	for _, a := range objects(snap["actions"]) {
		if a["status"] == "pending" {
			pending = append(pending, Object{"terminal_id": a["terminalId"], "resource": b.Store.Resource(stringOf(a["resourceId"]))["name"], "command": a["command"], "risk": a["risk"], "reason": a["reason"], "impact": a["impact"], "verification": a["verification"]})
		}
	}
	recent := []Object{}
	for _, e := range b.Store.Recent(id) {
		recent = append(recent, Object{"terminal_id": e["terminalId"], "resource": b.Store.Resource(stringOf(e["resourceId"]))["name"], "command": e["command"], "output": tail(stringOf(e["output"]), 2000), "exitCode": e["exitCode"]})
	}
	terminalContext := []Object{}
	for _, terminal := range objects(snap["terminals"]) {
		terminalContext = append(terminalContext, Object{"terminal_id": terminal["id"], "resource": b.Store.Resource(stringOf(terminal["resourceId"]))["name"], "status": terminal["status"], "holder": terminal["holder"], "contextVersion": terminal["contextVersion"]})
	}
	binding := b.Store.Options(id)
	bound := Object{"terminal_id": binding["terminal_id"], "runtime": binding["runtime"]}
	if tid := stringOf(binding["terminal_id"]); tid != "" {
		bound["terminal_status"] = b.terminalForSession(id, tid)["status"]
	}
	if ref := stringOf(binding["asset_ref"]); ref != "" {
		bound["resource"] = b.Store.Resource(ref)["name"]
	}
	before, e := b.Engine.Snapshot(id)
	must(e)
	modelContext := "[LAKE_SESSION_CONTEXT]\n" + jsonText(Object{"boundTarget": bound, "terminals": terminalContext, "conversation": conversation, "pendingOperations": pending, "recentCommands": recent})
	if options["profile"] == "terminal2" && stringOf(options["terminal_id"]) != "" {
		modelContext = b.terminalContext(id, stringOf(options["terminal_id"]))
	}
	if len(files) > 0 {
		modelContext += "\n[LAKE_TEXT_FILES]\n" + jsonText(files) + "\nThese are user-selected text attachments. Use preview_resource_import with source_id to inspect connection candidates. Do not read private credential storage or echo credentials."
	}
	e = b.Engine.ChatTurn(turnContext, id, ai.TurnInput{UserText: message, Context: modelContext, References: refs, Images: images, Prelude: prelude})
	if e != nil {
		if b.Context.Err() != nil {
			return
		}
		view, _ := b.Engine.Snapshot(id)
		if view.Status == "cancelled" {
			b.Store.Status(id, "completed")
			return
		}
		hasErrorCard := false
		for i, card := range view.Cards {
			if view.CardsOffset+i >= before.TotalCards && card.Type == "error" {
				hasErrorCard = true
				break
			}
		}
		if !hasErrorCard {
			b.Store.AddMessage(id, "system", e.Error(), nil)
		}
		b.Store.Status(id, "failed")
		return
	}
	view, e := b.Engine.Snapshot(id)
	must(e)
	for i := len(view.Cards) - 1; i >= 0; i-- {
		if view.CardsOffset+i < before.TotalCards {
			break
		}
		card := view.Cards[i]
		if card.Type == "message" && card.Content != "" {
			b.Store.AddMessage(id, "assistant", card.Content, nil)
			break
		}
	}
}
func (b *Server) bridge(ctx context.Context, id, name string, args Object, approved bool) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			if f, ok := p.(*Failure); ok {
				err = f
			} else {
				err = fmt.Errorf("Terminal operation failed")
			}
		}
	}()
	snap := b.sessionSnapshot(id)
	if name == "policy" && set("preview_resource_import import_resources")[stringOf(args["name"])] {
		return b.importBridgePolicy(id, stringOf(args["name"]), object(args["arguments"])), nil
	}
	project := stringOf(b.Store.Session(id)["projectId"])
	if name == "preview_resource_import" {
		return b.previewResourceImport(ctx, project, id, args), nil
	}
	if name == "import_resources" {
		if !approved {
			fail(403, "导入资源需要本次授权")
		}
		return b.commitResourceImport(project, id, stringOf(args["plan_id"]), args["indexes"]), nil
	}
	if name == "resource_import_assets" {
		return b.sessionAssets(id), nil
	}
	tid := stringOf(args["terminal_id"])
	var target Object
	if tid != "" {
		if name == "policy" || name == "adopt_terminal" {
			target = b.Store.projectTerminal(id, tid)
		} else {
			target = b.terminalForSession(id, tid)
		}
	}
	if name == "policy" {
		params := object(args["arguments"])
		selected := stringOf(params["terminal_id"])
		if selected == "" {
			selected = tid
		}
		var terminal Object
		targetName := ""
		if selected != "" {
			terminal = b.Store.projectTerminal(id, selected)
			targetName = stringOf(b.Store.Resource(stringOf(terminal["resourceId"]))["name"])
		}
		command := ""
		for _, k := range []string{"command", "input", "initial_input"} {
			if stringOf(params[k]) != "" {
				command = stringOf(params[k])
				break
			}
		}
		callName := stringOf(args["name"])
		ref := stringOf(params["asset_ref"])
		if ref == "" && terminal != nil {
			ref = stringOf(terminal["resourceId"])
		}
		if ref == "" {
			ref = stringOf(b.Store.Options(id)["asset_ref"])
		}
		if ref == "" {
			for _, r := range objects(snap["resources"]) {
				if r["kind"] == "local" {
					ref = stringOf(r["id"])
					break
				}
			}
		}
		var resource Object
		hostRuntime := stringOf(params["runtime"])
		if hostRuntime == "" {
			hostRuntime = stringOf(b.Store.Options(id)["runtime"])
		}
		fileCall := set("ls glob grep read write edit multi_edit append delete")[callName]
		if (set("shell inspect_host open_ssh_terminal")[callName] || fileCall) && hostRuntime != "container" {
			// Only an explicit argument or current stored binding can select a
			// host shell. A stale model-profile terminal is not a fallback.
			ref = stringOf(params["asset_ref"])
			explicitTerminal := stringOf(params["terminal_id"])
			if explicitTerminal != "" && ref == "" {
				ref = stringOf(b.terminalForSession(id, explicitTerminal)["resourceId"])
			}
			resource = b.hostResource(id, ref)
			ref = stringOf(resource["id"])
			if callName == "open_ssh_terminal" || fileCall {
				terminal = nil
			} else {
				terminal = b.reusableHostTerminal(id, ref, explicitTerminal)
			}
			targetName = stringOf(resource["name"])
		} else if ref != "" {
			b.Store.AssertResource(id, ref)
			resource = b.Store.Resource(ref)
			if targetName == "" {
				targetName = stringOf(resource["name"])
			}
		}
		if resource != nil && resource["kind"] == "ssh" && (fileCall || callName == "open_ssh_terminal" || set("shell inspect_host terminal_execute_command ssh_terminal_send terminal_send_input ssh_terminal_key terminal_send_key")[callName] && (terminal == nil || terminal["status"] == "disconnected")) {
			b.checkHostConnectionFailure(ctx, id, stringOf(resource["id"]))
		}
		p := CommandPolicy(command)
		frozenTerminal := Object{}
		for _, k := range []string{"id", "sessionId", "resourceId", "status", "holder", "contextVersion", "generation", "cwd", "shell"} {
			frozenTerminal[k] = terminal[k]
		}
		hashData := Object{"params": params, "terminal": frozenTerminal, "resources": snap["resources"], "permissions": b.Store.Options(id)}
		if set("shell inspect_host open_ssh_terminal")[callName] {
			frozenList := []Object{}
			for _, term := range objects(snap["terminals"]) {
				entry := Object{}
				for _, key := range []string{"id", "sessionId", "resourceId", "status", "holder", "contextVersion", "generation"} {
					entry[key] = term[key]
				}
				frozenList = append(frozenList, entry)
			}
			hashData["terminals"] = frozenList
		}
		hash := sha256.Sum256([]byte(jsonText(hashData)))
		v := Object{"fingerprint": fmt.Sprintf("%x", hash), "target": targetName}
		if terminal != nil {
			v["terminal_id"] = terminal["id"]
			v["terminalVersion"] = terminal["contextVersion"]
			v["generation"] = terminal["generation"]
			v["ownerSessionId"] = terminal["sessionId"]
			if terminal["sessionId"] != id {
				func() {
					defer func() {
						if recover() != nil {
							v["needsAdoption"] = true
						}
					}()
					b.ResolveTerminalAccess(id, stringOf(terminal["id"]), false)
				}()
			}
		}
		if p.Destructive {
			v["destructive"] = true
		}
		if p.DestructiveOnly {
			v["destructiveOnly"] = true
		}
		if resource != nil && set("local ssh")[stringOf(resource["kind"])] && (set("shell inspect_host open_ssh_terminal")[callName] || fileCall) && stringOf(b.Store.Options(id)["asset_ref"]) == "" {
			hosts := 0
			for _, r := range objects(snap["resources"]) {
				if set("local ssh")[stringOf(r["kind"])] {
					hosts++
				}
			}
			if hosts > 1 {
				v["needsTarget"] = true
			}
		}
		if resource != nil {
			v["asset_ref"] = resource["id"]
			v["runtime"] = resource["kind"]
			if set("shell inspect_host open_ssh_terminal")[callName] && set("local ssh")[stringOf(resource["kind"])] {
				v["needsTerminal"] = callName == "open_ssh_terminal" || terminal == nil
				if v["needsTerminal"] == true && b.needsHostKeyPrompt(resource) {
					v["hostKeyCreation"] = true
				}
			}
		}
		if terminal != nil && set("terminal_execute_command ssh_terminal_send terminal_send_input ssh_terminal_key terminal_send_key")[callName] {
			b.verifyTerminalBinding(id, stringOf(terminal["resourceId"]), stringOf(terminal["id"]))
		}
		if callName == "shell" || callName == "terminal_execute_command" || command != "" && p.Risk == "dangerous" {
			v["risk"] = p.Risk
			v["safeCommand"] = p.Safe
		}
		return v, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if name == "inspectHost" && approved && stringOf(b.Store.Options(id)["asset_ref"]) == "" {
		ref := stringOf(args["asset_ref"])
		r := b.hostResource(id, ref)
		options := b.Store.Options(id)
		options["asset_ref"] = ref
		options["runtime"] = r["kind"]
		b.Store.SaveOptions(id, options)
	}
	if name == "inspectHost" {
		return b.inspectHost(ctx, id, args, approved), nil
	}
	if name == "runtimeCommandExec" {
		explicitTerminal := stringOf(args["terminal_id"])
		ref := stringOf(args["asset_ref"])
		if ref == "" && explicitTerminal != "" {
			ref = stringOf(b.terminalForSession(id, explicitTerminal)["resourceId"])
		}
		resource := b.hostResource(id, ref)
		ref = stringOf(resource["id"])
		runtime := stringOf(args["runtime"])
		if runtime == "" {
			runtime = stringOf(resource["kind"])
		}
		if resource["kind"] != runtime || !set("local ssh")[runtime] {
			fail(400, "Shell runtime and asset do not match")
		}
		term := b.hostTerminal(ctx, id, ref, approved, explicitTerminal)
		options := b.Store.Options(id)
		if options["asset_ref"] == ref || approved && stringOf(options["asset_ref"]) == "" {
			options["asset_ref"] = ref
			options["runtime"] = resource["kind"]
			options["terminal_id"] = term["id"]
			b.Store.SaveOptions(id, options)
		}
		copy := Object{}
		for k, v := range args {
			copy[k] = v
		}
		copy["terminal_id"] = term["id"]
		copy["intent"] = "Go Agent Shell 操作"
		return b.bridge(ctx, id, "terminal_execute_command", copy, approved)
	}
	if name == "list_ssh_terminals" {
		out := []Object{}
		remembered, _ := b.Engine.ReferencedAssets(id)
		for _, t := range b.Store.AvailableTerminals(id) {
			if b.Store.Options(id)["blockUnreferencedAssets"] == true {
				allowed := false
				for _, ref := range remembered {
					allowed = allowed || ref == t["resourceId"]
				}
				if !allowed {
					continue
				}
			}
			if args["asset_ref"] == nil || args["asset_ref"] == "" || t["resourceId"] == args["asset_ref"] {
				t["terminal_id"] = t["id"]
				out = append(out, t)
			}
		}
		return out, nil
	}
	if name == "open_ssh_terminal" {
		ref := stringOf(args["asset_ref"])
		b.Store.AssertResource(id, ref)
		b.checkHostConnectionFailure(ctx, id, ref)
		if !approved && b.Store.Options(id)["silentTerminalCreation"] != true {
			fail(403, "新建终端会话需要本次授权")
		}
		term := b.openAgentTerminal(ctx, id, ref)
		term = b.Terminals.Control(id, stringOf(term["id"]), "agent")
		if input := stringOf(args["initial_input"]); input != "" {
			_, e := b.bridge(ctx, id, "ssh_terminal_send", Object{"input": input, "append_enter": args["append_enter"], "terminal_id": term["id"]}, approved)
			if e != nil {
				return nil, e
			}
		}
		options := b.Store.Options(id)
		resource := b.Store.Resource(ref)
		options["asset_ref"] = ref
		options["runtime"] = resource["kind"]
		options["terminal_id"] = term["id"]
		b.Store.SaveOptions(id, options)
		term["terminal_id"] = term["id"]
		return term, nil
	}
	if name == "adopt_terminal" {
		if !approved {
			fail(403, "Terminal adoption requires approval")
		}
		return b.adoptTerminal(id, tid, stringOf(args["generation"])), nil
	}
	if target == nil {
		fail(400, "Select a terminal for this AI profile")
	}
	if target != nil && set("terminal_execute_command ssh_terminal_send terminal_send_input ssh_terminal_key terminal_send_key")[name] {
		b.verifyTerminalBinding(id, stringOf(target["resourceId"]), tid)
		if b.manualTerminalBound(id, target) && target["holder"] == "user" {
			target = b.borrowManualTerminal(id, target)
		}
	}
	if name == "terminal_capabilities" {
		return b.Terminals.Capabilities(id, tid), nil
	}
	if name == "terminal_wait_command" {
		return b.waitTerminal(ctx, id, tid, stringOf(args["entry_id"]))
	}
	if name == "terminal_kill_command" {
		entry := b.Store.Entry(b.terminalOwner(id, tid, false), tid, stringOf(args["entry_id"]))
		if !approved {
			fail(403, "Command termination requires approval")
		}
		if entry["status"] == "running" {
			b.Terminals.Close(id, tid)
		}
		return Object{"stopped": true}, nil
	}
	if name == "terminal_command_status" {
		entry := b.Store.Entry(b.terminalOwner(id, tid, false), tid, stringOf(args["entry_id"]))
		entry["output"] = tail(stringOf(entry["output"]), 16000)
		entry["partial"] = entry["status"] == "running"
		return entry, nil
	}
	observed := Object{}
	read := func() string {
		observed = b.Terminals.ScreenResult(id, tid, defaultText(args["mode"], "tail"), defaultInt(args["lines"], 80), defaultInt(args["max_chars"], 20000))
		if observed["source"] == "historical" {
			fail(409, "terminal_disconnected: historical output cannot satisfy expect")
		}
		return stringOf(observed["text"])
	}
	expectResult := func(matched any, timedOut bool) Object {
		observed["matched"] = matched
		observed["timed_out"] = timedOut
		return observed
	}
	switch name {
	case "read_terminal_screen", "ssh_terminal_read":
		return b.Terminals.ScreenResult(id, tid, defaultText(args["mode"], "tail"), defaultInt(args["lines"], 80), defaultInt(args["max_chars"], 20000)), nil
	case "close_ssh_terminal":
		if !approved {
			fail(403, "Closing terminal needs approval")
		}
		b.Terminals.Close(id, tid)
		return Object{"closed": true}, nil
	case "terminal_execute_command":
		if b.Terminals.Capabilities(id, tid)["commandBlocks"] != true {
			fail(409, "Terminal command-block integration unavailable")
		}
		command := stringOf(args["command"])
		if !validCommand(command) {
			fail(400, "Invalid command")
		}
		if target["holder"] != "agent" || target["status"] != "ready" {
			fail(409, "请先将空闲终端交给 Agent")
		}
		actionID := ""
		if CommandPolicy(command).Risk != "readonly" {
			if !approved {
				fail(403, "Command requires approval")
			}
			a := b.Store.AddAction(id, stringOf(target["resourceId"]), tid, command, defaultText(args["intent"], "Go Agent 操作"), stringOf(target["sessionId"]))
			b.Store.Decide(stringOf(a["id"]), "approve", "执行 "+stringOf(b.Store.Resource(stringOf(target["resourceId"]))["name"]), true)
			actionID = stringOf(a["id"])
		}
		var entry Object
		func() {
			defer func() {
				if p := recover(); p != nil {
					if actionID != "" {
						b.Store.UnknownAction(actionID)
					}
					panic(p)
				}
			}()
			entry = b.Terminals.Execute(id, tid, "agent", command, actionID)
		}()
		if args["run_in_background"] == true {
			return Object{"shell_id": entry["id"], "entry_id": entry["id"], "terminal_id": tid, "status": "running"}, nil
		}
		timeout := defaultInt(args["timeout_ms"], defaultInt(args["timeout"], 30000))
		if timeout < 1 {
			timeout = 1
		}
		if timeout > 300000 {
			timeout = 300000
		}
		commandContext, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
		defer cancel()
		defer func() {
			if p := recover(); p != nil {
				if commandContext.Err() == context.DeadlineExceeded {
					err = fmt.Errorf("等待命令超时；命令仍在终端执行，可读取状态: %w", context.DeadlineExceeded)
					return
				}
				panic(p)
			}
		}()
		return b.waitTerminal(commandContext, id, tid, stringOf(entry["id"]))
	}
	send := func(input string, enter bool) {
		if !approved {
			fail(403, "Terminal input requires explicit approval")
		}
		if enter && !strings.HasSuffix(input, "\n") && !strings.HasSuffix(input, "\r") {
			input += "\n"
		}
		b.Terminals.Input(id, tid, input, true)
	}
	switch name {
	case "ssh_terminal_send", "terminal_send_input":
		send(stringOf(args["input"]), args["append_enter"] == true)
		return Object{"sent": true}, nil
	case "ssh_terminal_key", "terminal_send_key":
		keys := map[string]string{"enter": "\r", "tab": "\t", "esc": "\x1b", "backspace": "\x7f", "delete": "\x1b[3~", "ctrl_c": "\x03", "ctrl_d": "\x04", "ctrl_z": "\x1a", "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D", "home": "\x1b[H", "end": "\x1b[F", "page_up": "\x1b[5~", "page_down": "\x1b[6~", "space": " "}
		key := keys[stringOf(args["key"])]
		if key == "" {
			fail(400, "Unknown terminal key")
		}
		count := defaultInt(args["count"], 1)
		if count < 1 {
			count = 1
		}
		if count > 100 {
			count = 100
		}
		send(strings.Repeat(key, count), false)
		return Object{"sent": true}, nil
	case "ssh_terminal_expect", "terminal_expect":
		if input := stringOf(args["input"]); input != "" {
			send(input, args["append_enter"] == true)
		}
		patterns := stringsOf(args["wait_for"])
		timeout := defaultInt(args["timeout_ms"], 30000)
		if timeout < 1 {
			timeout = 1
		}
		if timeout > 300000 {
			timeout = 300000
		}
		started := time.Now()
		changed := started
		previous := read()
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for time.Since(started) < time.Duration(timeout)*time.Millisecond {
			current := read()
			if current != previous {
				previous = current
				changed = time.Now()
			}
			for _, p := range patterns {
				if strings.Contains(current, p) {
					return expectResult(p, false), nil
				}
			}
			if len(patterns) == 0 && time.Since(changed) >= time.Duration(defaultInt(args["idle_ms"], 1000))*time.Millisecond && time.Since(started) >= time.Duration(defaultInt(args["min_wait_ms"], 100))*time.Millisecond {
				return expectResult(nil, false), nil
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-tick.C:
			}
		}
		read()
		return expectResult(nil, true), nil
	}
	fail(400, "Unknown terminal operation")
	return nil, nil
}
func defaultText(v any, fallback string) string {
	if s := stringOf(v); s != "" {
		return s
	}
	return fallback
}
func defaultInt(v any, fallback int) int {
	if n := integer(v); n != 0 {
		return n
	}
	return fallback
}
