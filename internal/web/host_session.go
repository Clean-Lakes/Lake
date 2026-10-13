package web

import (
	"context"
	"strings"
	"time"
)

// bindReferenceTargets records the user-selected resource/terminal metadata.
// It does not select an investigation strategy or execute any host operation.
func (b *Server) bindReferenceTargets(id string, refs []Object, options Object) {
	if options["profile"] != "core" {
		return
	}
	targets := []Object{}
	seen := map[string]bool{}
	add := func(ref string) {
		if ref == "" || seen[ref] {
			return
		}
		b.Store.AssertResource(id, ref)
		r := b.Store.Resource(ref)
		if !set("local ssh")[stringOf(r["kind"])] {
			return
		}
		seen[ref] = true
		targets = append(targets, r)
	}
	for _, ref := range refs {
		add(stringOf(ref["asset_ref"]))
	}
	if len(targets) == 0 {
		return
	}
	primary := targets[0]
	updates := Object{"asset_ref": primary["id"], "runtime": primary["kind"]}
	selectedTerminals := map[string]bool{}
	for _, reference := range refs {
		if tid := stringOf(reference["terminal_id"]); tid != "" {
			selectedTerminals[tid] = true
		}
	}
	if len(selectedTerminals) > 1 {
		fail(409, "本轮引用了多个终端，请一次选择一个操作终端。")
	}
	for tid := range selectedTerminals {
		t := b.terminalForSession(id, tid)
		if t["resourceId"] == primary["id"] {
			updates["terminal_id"] = tid
		}
	}
	if len(targets) > 1 {
		updates = Object{"asset_ref": "", "terminal_id": "", "runtime": "local"}
	} else if updates["terminal_id"] == nil {
		if tid := stringOf(options["terminal_id"]); tid != "" && b.terminalForSession(id, tid)["resourceId"] != primary["id"] {
			updates["terminal_id"] = ""
		}
	}
	b.configure(id, updates)
}

func (b *Server) reusableHostTerminal(id, ref string, selected ...string) Object {
	b.Store.AssertResource(id, ref)
	snap := b.sessionSnapshot(id)
	reserved := map[string]bool{}
	for _, action := range objects(snap["actions"]) {
		if action["status"] == "pending" {
			reserved[stringOf(action["terminalId"])] = true
		}
	}
	usable := func(t Object) bool {
		return t["resourceId"] == ref && t["status"] == "ready" && (t["holder"] == "agent" || b.manualTerminalBound(id, t)) && !reserved[stringOf(t["id"])]
	}
	preferred := stringOf(b.Store.Options(id)["terminal_id"])
	if len(selected) > 0 && selected[0] != "" {
		b.verifyTerminalBinding(id, ref, selected[0])
		preferred = selected[0]
		t := b.terminalForSession(id, preferred)
		if t["resourceId"] != ref {
			fail(409, "指定终端与目标资源不一致")
		}
	}
	for _, t := range objects(snap["terminals"]) {
		if t["id"] == preferred && t["resourceId"] == ref {
			if usable(t) {
				return t
			}
			// A retained binding never silently switches to a different shell.
			return nil
		}
	}
	var candidates []Object
	for _, t := range objects(snap["terminals"]) {
		if usable(t) {
			candidates = append(candidates, t)
		}
	}
	if len(candidates) > 1 {
		fail(409, "此资源有多个 Agent 终端，请在 Agent 设置中选择当前终端，或引用具体终端；不会自动选择第一个。")
	}
	if len(candidates) == 1 {
		return candidates[0]
	}
	return nil
}

func (b *Server) hostTerminal(ctx context.Context, id, ref string, approved bool, selected ...string) Object {
	if t := b.reusableHostTerminal(id, ref, selected...); t != nil {
		if b.manualTerminalBound(id, t) {
			return b.borrowManualTerminal(id, t)
		}
		return t
	}
	b.checkHostConnectionFailure(ctx, id, ref)
	if !approved && b.Store.Options(id)["silentTerminalCreation"] != true {
		fail(403, "新建终端会话需要本次授权")
	}
	// Open a separate Agent terminal rather than taking over a user's shell or
	// invalidating a pending operation's frozen context.
	t := b.openAgentTerminal(ctx, id, ref)
	return b.Terminals.Control(id, stringOf(t["id"]), "agent")
}

func (b *Server) inspectHost(ctx context.Context, id string, args Object, approved bool) Object {
	ref := stringOf(args["asset_ref"])
	b.Store.AssertResource(id, ref)
	r := b.Store.Resource(ref)
	if !set("local ssh")[stringOf(r["kind"])] || args["runtime"] != r["kind"] {
		fail(400, "Host inspection requires a matching local or SSH target")
	}
	t := b.hostTerminal(ctx, id, ref, approved, stringOf(args["terminal_id"]))
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	tid := stringOf(t["id"])
	checks := []Object{}
	run := func(command string) Object {
		// These fixed commands pass the same read-only policy as model tools.
		entry := b.Terminals.Execute(id, tid, "agent", command, "")
		result := b.Terminals.Wait(ctx, id, tid, stringOf(entry["id"]))
		checks = append(checks, Object{"command": command, "output": tail(stringOf(result["output"]), 12000), "exitCode": result["exitCode"], "collectedAt": now()})
		return result
	}
	osResult := run("uname -s")
	platform := strings.TrimSpace(stringOf(osResult["output"]))
	commands := []string{"pwd", "uptime"}
	switch platform {
	case "Darwin":
		commands = append(commands, "sysctl -n hw.memsize", "vm_stat", "sysctl vm.swapusage", "top -l 2 -s 1 -o cpu -n 10", "top -l 1 -o mem -n 10")
	case "Linux":
		commands = append(commands, "free -m", "ps -eo pid,pcpu,pmem,rss,comm --sort=-pcpu | head -n 12", "ps -eo pid,pcpu,pmem,rss,comm --sort=-rss | head -n 12")
	default:
		commands = append(commands, "ps -eo pid,pcpu,pmem,rss,comm | head -n 12")
	}
	for _, command := range commands {
		run(command)
	}
	options := b.Store.Options(id)
	if options["asset_ref"] == ref {
		options["terminal_id"] = tid
		b.Store.SaveOptions(id, options)
	}
	return Object{"bound": options["asset_ref"] == ref, "asset_ref": ref, "name": r["name"], "runtime": r["kind"], "terminal_id": tid, "status": b.terminalForSession(id, tid)["status"], "platform": platform, "checks": checks, "collectedAt": now()}
}

// Resolve an operation target from exact IDs, a retained binding, or a unique
// session host. Resource order and model prose never choose among candidates.
func (b *Server) hostResource(id, requested string) Object {
	ref := requested
	if ref == "" {
		ref = stringOf(b.Store.Options(id)["asset_ref"])
	}
	if ref == "" {
		var hosts []Object
		for _, resource := range objects(b.sessionSnapshot(id)["resources"]) {
			if set("local ssh")[stringOf(resource["kind"])] {
				hosts = append(hosts, resource)
			}
		}
		if len(hosts) == 0 {
			fail(400, "当前会话未关联可操作的主机资源")
		}
		if len(hosts) != 1 {
			fail(409, "当前会话有多个主机资源，请 @ 引用目标资源或在 Agent 设置中选择目标；不会默认选本机。")
		}
		ref = stringOf(hosts[0]["id"])
	}
	b.Store.AssertResource(id, ref)
	return b.Store.Resource(ref)
}

func (b *Server) verifyTerminalBinding(id, ref, selected string) {
	current := stringOf(b.Store.Options(id)["terminal_id"])
	if current != "" && b.terminalForSession(id, current)["resourceId"] == ref {
		if current != selected {
			fail(409, "工具指定的终端与会话绑定不一致，请在 Agent 设置中选择或引用具体终端后再操作。")
		}
		return
	}
	count := 0
	for _, terminal := range objects(b.sessionSnapshot(id)["terminals"]) {
		if terminal["resourceId"] == ref && terminal["status"] == "ready" && terminal["holder"] == "agent" {
			count++
		}
	}
	if count > 1 {
		fail(409, "有多个终端且尚未绑定，请在 Agent 设置中选择或引用具体终端；模型不能自行切换。")
	}
}
