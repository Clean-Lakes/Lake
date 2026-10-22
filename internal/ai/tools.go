package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

func asset(c Config, ref string) (Asset, error) {
	for _, a := range c.Assets {
		if a.ID == ref || assetAlias(a.ID) == ref {
			return a, nil
		}
	}
	return Asset{}, errors.New("asset not available in this session; call list_assets")
}

// ToolRisk is the conservative built-in policy. Shell needs the trusted bridge
// classifier to establish readonly; arbitrary MCP calls remain writes.
func ToolRisk(name string, a map[string]any) string {
	risk := "readonly"
	switch name {
	case "call_mcp_tool", "kill_shell", "import_resources", "stage_attachment":
		risk = "write"
	case "shell", "terminal_execute_command":
		risk = "write"
	case "ssh_terminal_send", "terminal_send_input", "ssh_terminal_key", "terminal_send_key", "delete":
		risk = "dangerous"
	case "close_ssh_terminal", "open_ssh_tunnel", "close_ssh_tunnel", "scp_transfer", "docker_container_action", "write", "edit", "multi_edit", "append":
		risk = "write"
	case "open_ssh_terminal", "ssh_terminal_expect", "terminal_expect":
		if str(a["initial_input"])+str(a["input"]) != "" {
			risk = "dangerous"
		}
	case "execute_sql":
		if !readonlySQL(str(a["sql"])) {
			risk = "write"
		}
	case "redis_command":
		if !redisReadOnly(str(a["command"])) {
			risk = "write"
		}
	}
	return risk
}

func (e *Engine) policy(ctx context.Context, id string, c Config, name string, a map[string]any) (string, string, error) {
	risk := ToolRisk(name, a)
	if e.Bridge != nil {
		v, err := e.bridgeCall(ctx, id, "policy", map[string]any{"name": name, "arguments": a, "terminal_id": c.TerminalID}, false)
		if err != nil {
			return "", "", err
		}
		p := obj(v)
		if str(p["fingerprint"]) == "" {
			return "", "", errors.New("policy returned no target fingerprint")
		}
		if r := str(p["risk"]); r != "" {
			if name == "shell" || name == "terminal_execute_command" || r == "dangerous" {
				risk = r
			}
		}
		return risk, str(p["fingerprint"]), nil
	}
	return risk, hash(js(c.Assets) + js(a)), nil
}
func (e *Engine) invoke(ctx context.Context, s *session, c Config, call Call) (result any, err error) {
	if err := checkPlanOperation(c, call.Name, "readonly"); err != nil {
		return nil, err
	}
	if e.experiment != nil {
		return e.experiment.invoke(ctx, call)
	}
	// Approval recovery can enter invoke directly. It must obey the same frozen
	// correction gate as ordinary ADK calls, including opaque session tools.
	if err := e.onlineBeforeCall(ctx, s, c, call); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if call.Name == onlineRevisionTool {
		return e.onlinePropose(ctx, s, c, call)
	}
	if c.Model.Key != "" && (strings.Contains(call.Arguments, c.Model.Key) || strings.Contains(call.Arguments, strings.Trim(js(c.Model.Key), "\""))) {
		return nil, errors.New("tool arguments cannot contain model credentials")
	}
	a, err := args(call)
	if err != nil {
		return nil, err
	}
	if e.worker != nil {
		c, err = e.scopedChildConfig(c, a)
		if err != nil {
			return nil, err
		}
	}
	for k := range a {
		if strings.HasPrefix(k, "__") {
			return nil, errors.New("reserved tool argument")
		}
	}
	if ref := str(a["asset_ref"]); ref != "" {
		as, err := asset(c, ref)
		if err != nil {
			return nil, err
		}
		if ref != assetAlias(as.ID) {
			return nil, errors.New("use asset_ref returned by list_assets, not the Lake resource id")
		}
		if c.targetScope != nil && as.ID != c.AssetRef {
			// A directory can contain several hosts. Do not borrow the previous
			// host's terminal when the model explicitly chooses another member.
			c.TerminalID = ""
			if as.Kind == "local" || as.Kind == "ssh" {
				c.Runtime = as.Kind
			}
		}
	}
	s.mu.Lock()
	c.ReferencedAssets = validRemembered(c, append(c.ReferencedAssets, s.state.ReferencedAssetIDs...))
	sessionForTools := s.state.View.Session
	s.mu.Unlock()
	found := false
	for _, t := range e.sessionCatalog(ctx, sessionForTools, c) {
		if t.Name == call.Name {
			found = true
			if err = validateTool(t, a); err != nil {
				return nil, err
			}
			break
		}
	}
	if !found {
		return nil, errors.New("tool unavailable in selected profile")
	}
	if err = e.checkSRECall(c, call, a); err != nil {
		return nil, err
	}
	if sessionTool(call.Name) {
		if err = e.PrepareSREOperation(c, call, "write"); err != nil {
			return nil, err
		}
	}
	defer func() { e.finishSREPreparation(c, call, err) }()
	defer func() { result, err = e.recordSREToolResult(c, call, a, result, err) }()
	if call.Name == "sre_collaborate" {
		return e.prepareSREHandoff(s, c, call)
	}
	if call.Name == "sre_reply" {
		return e.prepareSREReply(s, c, call)
	}
	if call.Name == "sre_team_update" || call.Name == "sre_team_read" {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return e.invokeSRETeam(c, call.Name, a)
	}
	if e.worker != nil {
		e.worker.mu.Lock()
		e.worker.calls++
		calls := e.worker.calls
		e.worker.mu.Unlock()
		if !fullSREAgent(c) && calls > agentCallLimit(c) {
			return nil, errors.New("子 Agent 工具调用预算已达到上限")
		}
		if err := e.worker.parent.updateAgent(e.worker, func(r *AgentRun) { r.ToolCount = calls }); err != nil {
			return nil, err
		}
	}
	if sessionTool(call.Name) {
		return e.invokeSessionTool(ctx, s, c, call, a)
	}
	if memoryTool(call.Name) {
		if !c.MemoryEnabled || c.MemoryProjectID == "" || e.worker != nil && (c.sre == nil || !c.sre.FullTools) || e.Bridge == nil {
			return nil, errors.New("project memory unavailable")
		}
		return e.bridgeCall(ctx, sessionForTools, call.Name, a, false)
	}
	if c.targetScope != nil && (str(a["terminal_id"]) == "" || str(a["asset_ref"]) != "" || c.targetScope.NeedsClarification || len(c.targetScope.ResourceIDs) == 0 || call.Name == "delegate_investigation") {
		if err := enforceTargetScope(c, call.Name, a, nil); err != nil {
			return nil, err
		}
	}
	if call.Name == "delegate_investigation" {
		var input struct {
			Tasks []investigationSpec `json:"tasks"`
		}
		if json.Unmarshal([]byte(call.Arguments), &input) != nil {
			return nil, errors.New("invalid investigation tasks")
		}
		_, err := e.runInvestigations(ctx, s, c, input.Tasks)
		if err != nil {
			return nil, err
		}
		return e.investigationReports(s, false), nil
	}
	if call.Name == "read_investigation" {
		if len(a) == 0 {
			return e.investigationReports(s, true), nil
		}
		value, _, err := e.readAgentEvidence(s, a)
		return value, err
	}
	if call.Name == "read_evidence" && e.worker != nil {
		return e.observation(ctx, c, call.Name, a)
	}
	s.mu.Lock()
	sessionID := s.state.View.Session
	s.mu.Unlock()
	if strings.Contains(" write edit multi_edit append delete ", " "+call.Name+" ") {
		s.mu.Lock()
		readHash := s.state.FileReads[fileReadKey(c, a)]
		s.mu.Unlock()
		if str(a["expected_hash"]) == "" && readHash != "" {
			if !validFileHash(readHash) {
				return nil, &ToolNotExecutedError{Err: errors.New("saved file fingerprint is invalid; read the file again before writing")}
			}
			a["expected_hash"] = readHash
		}
	}
	discovery := call.Name == "list_assets" || call.Name == "list_resource_groups"
	risk, fingerprint := "readonly", ""
	if !discovery {
		risk, fingerprint, err = e.policy(ctx, sessionID, c, call.Name, a)
		if err != nil {
			return nil, err
		}
	}
	target := "本机"
	if discovery {
		target = "项目资源目录"
	}
	policyContext := map[string]any{}
	if e.Bridge != nil && !discovery {
		p, pe := e.bridgeCall(ctx, sessionID, "policy", map[string]any{"name": call.Name, "arguments": a, "terminal_id": c.TerminalID}, false)
		if pe != nil {
			return nil, pe
		}
		if name := str(obj(p)["target"]); name != "" {
			target = name
		}
		policyContext = obj(p)
	}
	ref := str(a["asset_ref"])
	if ref == "" && !discovery && call.Name != "preview_resource_import" && call.Name != "import_resources" && call.Name != "inspect_attachment" {
		ref = str(policyContext["asset_ref"])
		if ref == "" {
			ref = c.AssetRef
		}
	}
	if ref != "" && !discovery {
		as, e := asset(c, ref)
		if e != nil {
			return nil, e
		}
		target = as.Name
		if c.targetScope != nil && str(a["terminal_id"]) != "" && str(a["asset_ref"]) == "" {
			c.AssetRef = as.ID
			if as.Kind == "local" || as.Kind == "ssh" {
				c.Runtime = as.Kind
			}
		}
		if str(policyContext["asset_ref"]) == "" {
			policyContext["asset_ref"] = as.ID
			policyContext["runtime"] = as.Kind
		}
	}
	if err := enforceTargetScope(c, call.Name, a, policyContext); err != nil {
		return nil, err
	}

	if str(policyContext["runtime"]) == "" {
		policyContext["runtime"] = hostArguments(c, a)["runtime"]
	}
	// Always compute this from validated tool arguments, never a model flag.
	for _, key := range []string{"command", "input", "initial_input"} {
		if CatastrophicCommand(str(a[key])) {
			policyContext["catastrophic"] = true
			risk = "dangerous"
		}
	}
	if call.Name == "delete" && CatastrophicDelete(str(a["path"])) {
		policyContext["catastrophic"] = true
		risk = "dangerous"
	}
	if err = e.PrepareSREOperation(c, call, risk); err != nil {
		return nil, err
	}
	kind := ""
	kind, err = approvalKind(c, call.Name, risk, policyContext)
	if err != nil {
		return nil, err
	}
	if err = e.onlinePolicy(ctx, s, c, call, a, policyContext, risk, kind); err != nil {
		return nil, err
	}
	var preview map[string]any
	if call.Name == "import_resources" {
		preview = obj(policyContext["importPreview"])
	}
	if strings.Contains(" write edit multi_edit append delete ", " "+call.Name+" ") {
		preview, err = e.filePreview(ctx, c, call.Name, a)
		if err != nil {
			return nil, err
		}
	}
	cardID := uid()
	s.mu.Lock()
	foundCard := false
	for i := range s.state.View.Cards {
		card := &s.state.View.Cards[i]
		if card.Type == "operation" && str(obj(card.Data)["call_id"]) == call.ID && card.Status == "pending" {
			cardID = card.ID
			card.Status = "running"
			foundCard = true
			break
		}
	}
	if !foundCard {
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: cardID, Type: "operation", Title: call.Name, Data: map[string]any{"arguments": a, "target": target, "risk": risk, "call_id": call.ID}, Status: "running", At: timestamp()})
	}
	e.notify(s, "toolCall", map[string]any{"name": call.Name})
	s.mu.Unlock()
	connectionPrepared := false
	defer func() {
		if connectionPrepared || errors.Is(err, errADKApprovalPending) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		for i := range s.state.View.Cards {
			card := &s.state.View.Cards[i]
			if card.ID == cardID {
				card.Status = "completed"
				if err != nil {
					card.Status = "failed"
					var notExecuted *ToolNotExecutedError
					var blocked *nativeOperationBlockedError
					if errors.As(err, &notExecuted) || errors.As(err, &blocked) {
						card.Status = "not_executed"
					}
					card.Content = redact(err.Error(), c)
				} else {
					card.Content = redact(js(result), c)
					if len(card.Content) > 32000 {
						card.Content = card.Content[:32000] + " [TRUNCATED]"
					}
				}
			}
		}
		e.notify(s, "operation", map[string]any{"card_id": cardID})
	}()
	approved := kind == "" && (risk != "readonly" || policyContext["needsTerminal"] == true)
	if kind != "" || resumingNativeApproval(ctx) {
		approval := &Approval{ID: uid(), Call: call, Target: target, Risk: risk, Kind: kind, NeedsTerminal: policyContext["needsTerminal"] == true, Fingerprint: fingerprint, Preview: preview, ResourceID: str(policyContext["asset_ref"]), TerminalID: str(policyContext["terminal_id"]), TerminalGeneration: str(policyContext["generation"]), TerminalVersion: num(policyContext["terminalVersion"], 0)}
		if risk == "dangerous" {
			approval.Confirmation = "执行 " + target
		}
		approved, err = e.waitNativeApproval(ctx, s, c, approval)
		if err != nil {
			return nil, err
		}

		if !approved {
			return nil, errors.New("user rejected this tool call")
		}
		_, current, err := e.policy(ctx, sessionID, c, call.Name, a)
		if err != nil {
			return nil, err
		}
		if current != fingerprint {
			return nil, errors.New("target or terminal context changed; approval expired")
		}
		if kind == "adopt_terminal" {
			if _, err = e.bridgeCall(ctx, sessionID, "adopt_terminal", map[string]any{"terminal_id": policyContext["terminal_id"], "generation": policyContext["generation"]}, true); err != nil {
				return nil, err
			}
		}
		if err = e.rememberApproved(s, c, str(policyContext["asset_ref"])); err != nil {
			return nil, err
		}
		if kind == "terminal_open" && call.Name == "shell" && e.Bridge != nil {
			// A connection decision authorizes setup only. Re-evaluate the requested
			// command against the newly established terminal and its permissions.
			setupCall := Call{ID: call.ID + "_connect", Name: "open_ssh_terminal", Arguments: call.Arguments}
			setupOperation, setupErr := e.dispatchNativeOperation(context.WithValue(ctx, adkApprovalCallKey{}, call.ID), s, c, setupCall, "write", target, fingerprint)
			if setupErr != nil {
				return nil, setupErr
			}
			prepared, prepareErr := e.bridgeCall(ctx, sessionID, "prepare_host", map[string]any{"asset_ref": policyContext["asset_ref"], "terminal_id": a["terminal_id"]}, true)
			err = prepareErr
			if persistErr := e.finishNativeOperation(setupOperation, c, prepared, err); persistErr != nil {
				err = persistErr
			}
			if err != nil {
				return nil, err
			}
			connectionPrepared = true
			s.mu.Lock()
			for i := range s.state.View.Cards {
				if s.state.View.Cards[i].ID == cardID {
					s.state.View.Cards[i].Title = "open_ssh_terminal"
					s.state.View.Cards[i].Content = redact(js(prepared), c)
					s.state.View.Cards[i].Status = "completed"
				}
			}
			e.notify(s, "operation", map[string]any{"card_id": cardID})
			s.mu.Unlock()
			return e.invoke(context.WithValue(ctx, adkFreshConfirmationKey{}, true), s, c, call)
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if e.worker != nil {
		c, err = e.scopedChildConfig(c, a)
		if err != nil {
			return nil, err
		}
	}
	if err = e.DispatchSREOperation(ctx, c, call); err != nil {
		return nil, err
	}
	defer func() { e.finishSREOperation(c, call, result, err) }()
	operation, operationErr := e.dispatchNativeOperation(ctx, s, c, call, risk, target, fingerprint)
	if operationErr != nil {
		return nil, &ToolNotExecutedError{Err: operationErr}
	}
	if trace, _ := ctx.Value(onlinePolicyKey{}).(*onlinePolicyTrace); trace != nil {
		trace.Dispatched = true
	}
	defer func() {
		if persistErr := e.finishNativeOperation(operation, c, result, err); persistErr != nil {
			err = persistErr
		}
	}()
	switch call.Name {
	case "stage_attachment":
		return e.stageAttachment(ctx, sessionForTools, c, a)
	case "inspect_attachment":
		if e.Bridge == nil {
			return nil, errors.New("附件需要 Lake 工作台")
		}
		return e.bridgeCall(ctx, sessionForTools, call.Name, a, false)
	case "observe_host", "observe_cluster", "observe_cluster_logs", "observe_journal", "observe_logs", "observe_data", "read_evidence":
		return e.observation(ctx, c, call.Name, a)
	case "preview_resource_import", "import_resources":
		if e.Bridge == nil {
			return nil, errors.New("资源导入需要 Lake 工作台")
		}
		return e.bridgeCall(ctx, sessionID, call.Name, a, approved)
	case "list_assets":
		return listDirectoryAssets(c, a)
	case "list_resource_groups":
		return directoryDiscovery(c), nil
	case "render_chart":
		labels := arr(a["labels"])
		if len(labels) == 0 || len(labels) > 1000 {
			return nil, errors.New("chart labels must contain 1..1000 items")
		}
		series := arr(a["series"])
		if len(series) == 0 {
			series = []any{map[string]any{"values": a["values"]}}
		}
		for _, x := range series {
			if len(arr(obj(x)["values"])) != len(labels) {
				return nil, errors.New("chart values must match labels")
			}
		}
		s.mu.Lock()
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "chart", Title: str(a["title"]), Data: a, Status: "completed", At: timestamp()})
		s.mu.Unlock()
		return map[string]any{"rendered": true}, nil
	case "list_db_objects", "db_table_ddl", "execute_sql":
		return e.database(ctx, c, call.Name, a)
	case "redis_command":
		return e.redis(ctx, c, a)
	case "list_docker_containers", "docker_container_logs", "docker_container_action":
		return e.docker(ctx, c, call.Name, a)
	case "open_ssh_tunnel", "close_ssh_tunnel", "scp_transfer":
		return e.transfer(ctx, sessionID, c, call.Name, a)
	case "shell":
		command := str(a["command"])
		bridgeArgs := hostArguments(c, a)
		targetRuntime := str(bridgeArgs["runtime"])
		if e.Bridge != nil && targetRuntime != "container" {
			return e.bridgeCall(ctx, sessionID, "runtimeCommandExec", bridgeArgs, approved)
		}
		if risk == "readonly" && e.Bridge != nil {
			value, err := e.bridgeCall(ctx, sessionID, "policy", map[string]any{"name": call.Name, "arguments": a, "terminal_id": c.TerminalID}, false)
			if err != nil {
				return nil, err
			}
			safe := str(obj(value)["safeCommand"])
			if safe == "" {
				return nil, errors.New("read-only execution requires a validated command")
			}
			command = safe
		}
		executionArgs := map[string]any{}
		for k, v := range bridgeArgs {
			executionArgs[k] = v
		}
		executionArgs["__session"] = sessionID
		return e.command(ctx, c, executionArgs, command)
	case "inspect_host":
		if e.Bridge == nil {
			return nil, errors.New("host session bridge unavailable")
		}
		value, err := e.bridgeCall(ctx, sessionID, "inspectHost", hostArguments(c, a), approved)
		if err != nil {
			return nil, err
		}
		data := obj(value)
		if as, err := asset(c, str(data["asset_ref"])); err == nil {
			data["asset_ref"] = assetAlias(as.ID)
		}
		return data, nil
	case "wait_shell", "shell_output", "kill_shell":
		return e.shellJob(ctx, sessionID, call.Name, a)
	case "ls", "glob", "grep", "read", "edit", "multi_edit", "append", "write", "delete":
		executionArgs := map[string]any{}
		for k, v := range a {
			executionArgs[k] = v
		}
		if preview != nil {
			executionArgs["__expected_hash"] = hash(str(preview["before"]))
			executionArgs["__expected_exists"] = preview["existed"]
		}
		return e.file(ctx, s, c, call.Name, executionArgs)
	case "web_fetch", "web_search":
		return e.web(ctx, call.Name, a)
	default:
		if e.Bridge == nil {
			return nil, errors.New("terminal bridge unavailable")
		}
		if str(a["terminal_id"]) == "" && c.TerminalID != "" {
			a["terminal_id"] = c.TerminalID
		}
		return e.terminal(ctx, sessionID, call.Name, a, approved)
	}
}
func hostArguments(c Config, a map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	if str(out["asset_ref"]) == "" {
		out["asset_ref"] = c.AssetRef
	}
	if str(out["runtime"]) == "" {
		out["runtime"] = c.Runtime
		if as, err := asset(c, str(out["asset_ref"])); err == nil {
			out["runtime"] = as.Kind
			if as.Kind == "docker" {
				out["runtime"] = "container"
			}
		}
	}
	return out
}

func readonlySQL(sql string) bool {
	s := strings.TrimSpace(strings.ToUpper(sql))
	if strings.HasSuffix(s, ";") {
		s = strings.TrimSuffix(s, ";")
	}
	if strings.ContainsAny(s, ";\\") || strings.Contains(s, "--") || strings.Contains(s, "/*") {
		return false
	}
	if !strings.HasPrefix(s, "SELECT ") {
		return false
	}
	for _, word := range []string{"INTO", "FOR UPDATE", "DBLINK", "LOAD_FILE", "SLEEP(", "BENCHMARK("} {
		if strings.Contains(s, word) {
			return false
		}
	}
	if !readonlyPostgresNames(s) {
		return false
	}
	return true
}
func redisReadOnly(command string) bool {
	parts, err := words(command)
	if err != nil || len(parts) == 0 {
		return false
	}
	switch strings.ToUpper(parts[0]) {
	case "PING", "INFO", "GET", "MGET", "HGET", "HMGET", "HGETALL", "LRANGE", "LLEN", "SMEMBERS", "SCARD", "SISMEMBER", "ZRANGE", "ZSCORE", "ZCARD", "EXISTS", "TYPE", "TTL", "PTTL", "SCAN", "HSCAN", "SSCAN", "ZSCAN", "DBSIZE":
		return true
	}
	return false
}
func words(s string) ([]string, error) {
	result := []string{}
	var b strings.Builder
	quote := rune(0)
	escape := false
	started := false
	for _, r := range s {
		if escape {
			b.WriteRune(r)
			escape = false
			started = true
			continue
		}
		if r == '\\' {
			escape = true
			continue
		}
		if quote != 0 {
			if r == quote {
				quote = 0
			} else {
				b.WriteRune(r)
			}
			continue
		}
		if r == '\'' || r == '"' {
			quote = r
			started = true
			continue
		}
		if r == ' ' || r == '\t' || r == '\n' {
			if started {
				result = append(result, b.String())
				b.Reset()
				started = false
			}
			continue
		}
		b.WriteRune(r)
		started = true
	}
	if quote != 0 || escape {
		return nil, fmt.Errorf("invalid quoted command")
	}
	if started {
		result = append(result, b.String())
	}
	return result, nil
}

func (e *Engine) terminal(ctx context.Context, id, name string, a map[string]any, approved bool) (any, error) {
	if (name != "terminal_expect" && name != "ssh_terminal_expect") || str(a["match"]) != "regex" {
		return e.bridgeCall(ctx, id, name, a, approved)
	}
	if input := str(a["input"]); input != "" {
		send := "ssh_terminal_send"
		if name == "terminal_expect" {
			send = "terminal_send_input"
		}
		if _, err := e.bridgeCall(ctx, id, send, a, approved); err != nil {
			return nil, err
		}
	}
	if len(arr(a["wait_for"])) == 0 {
		a["match"] = "contains"
		return e.bridgeCall(ctx, id, name, a, approved)
	}
	patterns := []*regexp.Regexp{}
	for _, v := range arr(a["wait_for"]) {
		p, err := regexp.Compile(str(v))
		if err != nil {
			return nil, errors.New("invalid terminal regex")
		}
		patterns = append(patterns, p)
	}
	readName := "ssh_terminal_read"
	if name == "terminal_expect" {
		readName = "read_terminal_screen"
	}
	ctx, cancel := context.WithTimeout(ctx, duration(a))
	defer cancel()
	timer := time.NewTicker(100 * time.Millisecond)
	defer timer.Stop()
	for {
		value, err := e.bridgeCall(ctx, id, readName, a, false)
		if err != nil {
			return nil, err
		}
		if obj(value)["source"] == "historical" {
			return nil, errors.New("terminal_disconnected: historical output cannot satisfy expect")
		}
		text := str(obj(value)["text"])
		for _, p := range patterns {
			if p.MatchString(text) {
				snapshot := obj(value)
				snapshot["matched"] = p.String()
				snapshot["timed_out"] = false
				return snapshot, nil
			}
		}
		select {
		case <-ctx.Done():
			snapshot := obj(value)
			snapshot["timed_out"] = true
			return snapshot, ctx.Err()
		case <-timer.C:
		}
	}
}

func assetAlias(id string) string { return "a_" + hash(id)[:16] }
func (e *Engine) bridgeCall(ctx context.Context, id, name string, a map[string]any, approved bool) (any, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	convert := func(input map[string]any) (map[string]any, error) {
		out := map[string]any{}
		for k, v := range input {
			out[k] = v
		}
		if ref := str(out["asset_ref"]); ref != "" {
			as, err := asset(c, ref)
			if err != nil {
				return nil, err
			}
			out["asset_ref"] = as.ID
		}
		return out, nil
	}
	out, err := convert(a)
	if err != nil {
		return nil, err
	}
	if nested, ok := a["arguments"].(map[string]any); ok {
		out["arguments"], err = convert(nested)
		if err != nil {
			return nil, err
		}
	}
	result, err := e.Bridge(ctx, id, name, out, approved)
	var waiting *ToolWaitTimeoutError
	if errors.As(err, &waiting) && ctx.Err() == nil && (name == "runtimeCommandExec" || name == "terminal_execute_command") && str(obj(result)["terminal_id"]) != "" && str(obj(result)["entry_id"]) != "" {
		// Keep the original command; expose wait/output handles instead of
		// aborting this specialist and cancelling all parallel peers.
		return e.trackBridgeShell(id, result, a)
	}
	continued := obj(result)["timed_out"] == true && str(obj(result)["status"]) == "running"
	if err == nil && (a["run_in_background"] == true || continued) && (name == "runtimeCommandExec" || name == "terminal_execute_command") {
		return e.trackBridgeShell(id, result, a)
	}
	return result, err
}
