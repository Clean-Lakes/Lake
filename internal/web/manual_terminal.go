package web

import "context"

// Manual shells are reused only through an explicit human selection. Merely
// referencing a resource or having its console open does not select a shell.
func (b *Server) bindManualTerminalForHuman(id string, refs []Object, selection any) {
	if selection == nil {
		// Ordinary core chats run in their own managed shell. Drop old implicit
		// manual bindings, including stale grants left by service restarts.
		explicit := false
		for _, r := range refs {
			explicit = explicit || stringOf(r["terminal_id"]) != ""
		}
		options := b.sessionOptions(id)
		if !explicit && options["profile"] == "core" {
			if tid := stringOf(options["terminal_id"]); tid != "" {
				term := b.Store.projectTerminal(id, tid)
				if term["sessionId"] != id || b.Terminals.UserInteractive(tid) {
					b.configure(id, Object{"terminal_id": "", "terminal_generation": ""})
					b.revokeSessionTerminals(id)
				}
			}
		}
		return
	}
	hosts := map[string]bool{}
	for _, r := range refs {
		ref := stringOf(r["asset_ref"])
		if ref == "" {
			continue
		}
		b.Store.AssertResource(id, ref)
		kind := b.Store.Resource(ref)["kind"]
		if kind == "local" || kind == "ssh" {
			hosts[ref] = true
		}
	}
	if len(hosts) != 1 {
		return
	}
	var ref string
	for target := range hosts {
		ref = target
	}
	var chosen Object
	if selection != nil {
		v := object(selection)
		if len(v) != 2 {
			fail(400, "终端引用格式无效")
		}
		tid := text(v["terminalId"], "terminalId", 100)
		chosen = b.Store.projectTerminal(id, tid)
		if chosen["resourceId"] != ref || chosen["generation"] != v["generation"] {
			fail(409, "终端与引用资源不一致，或连接已经更新")
		}
		if !b.Terminals.ManualIdle(chosen) {
			fail(409, "手动终端正在使用，请等待空闲并完成当前输入")
		}
	}
	if chosen == nil {
		return
	}
	tid := stringOf(chosen["id"])
	if b.Store.read(func() any {
		return b.Store.row("SELECT 1 FROM actions WHERE terminalId=? AND status='pending'", tid) != nil
	}).(bool) {
		fail(409, "此终端有待确认的命令，请先处理审批")
	}
	b.bindingMu.Lock()
	defer b.bindingMu.Unlock()
	key := id + ":" + tid
	b.accessMu.Lock()
	previous, existed := b.terminalGrants[key]
	previousBinding, bound := b.manualBindings[key]
	b.accessMu.Unlock()
	committed := false
	defer func() {
		if committed {
			return
		}
		b.accessMu.Lock()
		defer b.accessMu.Unlock()
		if existed {
			b.terminalGrants[key] = previous
		} else {
			delete(b.terminalGrants, key)
		}
		if bound {
			b.manualBindings[key] = previousBinding
		} else {
			delete(b.manualBindings, key)
		}
	}()
	b.adoptTerminal(id, tid, stringOf(chosen["generation"]))
	b.configure(id, Object{"asset_ref": ref, "runtime": b.Store.Resource(ref)["kind"], "terminal_id": tid})
	b.accessMu.Lock()
	if b.manualBindings == nil {
		b.manualBindings = map[string]TerminalAccess{}
	}
	b.manualBindings[key] = b.terminalGrants[key]
	b.accessMu.Unlock()
	committed = true
}

func (t *Terminals) ManualIdle(term Object) bool {
	t.mu.Lock()
	l := t.live[stringOf(term["id"])]
	t.mu.Unlock()
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	fresh := t.store.Terminal(l.session, l.id)
	return l.interactive && !l.closed && l.ready && l.job == nil && !l.userInputPending && fresh["status"] == "ready" && fresh["holder"] == "user" && fresh["generation"] == term["generation"]
}

func (b *Server) manualTerminalBound(id string, term Object) bool {
	b.accessMu.Lock()
	binding, ok := b.manualBindings[id+":"+stringOf(term["id"])]
	b.accessMu.Unlock()
	return ok && binding.Generation == term["generation"] && b.Terminals.UserInteractive(stringOf(term["id"]))
}

func (b *Server) borrowManualTerminal(id string, term Object) Object {
	access := b.ResolveTerminalAccess(id, stringOf(term["id"]), false)
	l := b.Terminals.get(access.OwnerSessionID, access.TerminalID)
	l.mu.Lock()
	defer l.mu.Unlock()
	fresh := b.Store.Terminal(access.OwnerSessionID, access.TerminalID)
	b.accessMu.Lock()
	defer b.accessMu.Unlock()
	if l.closed || !l.interactive || l.job != nil || l.userInputPending || fresh["status"] != "ready" {
		fail(409, "手动终端正在使用，请等待空闲")
	}
	if fresh["holder"] == "agent" {
		if b.terminalWriters[access.TerminalID] != id {
			fail(409, "终端输入由其他会话持有")
		}
		return fresh
	}
	if fresh["holder"] != "user" {
		fail(409, "请先接管手动终端")
	}
	if b.terminalWriters == nil {
		b.terminalWriters = map[string]string{}
	}
	if b.manualBorrowers == nil {
		b.manualBorrowers = map[string]string{}
	}
	b.terminalWriters[access.TerminalID] = id
	b.manualBorrowers[access.TerminalID] = id
	return b.Store.Control(access.OwnerSessionID, access.TerminalID, "agent")
}

// Return input after the turn. A cancelled waiter never replays a command or
// interrupts its Shell; a still-running job returns input only after completion.
func (b *Server) releaseManualTerminals(id string) {
	b.accessMu.Lock()
	bindings := []TerminalAccess{}
	for _, binding := range b.manualBindings {
		if binding.RequestSessionID == id && b.manualBorrowers[binding.TerminalID] == id {
			bindings = append(bindings, binding)
		}
	}
	b.accessMu.Unlock()
	for _, binding := range bindings {
		func() {
			defer func() { recover() }()
			l := b.Terminals.get(binding.OwnerSessionID, binding.TerminalID)
			release := func() {
				defer func() { recover() }()
				l.mu.Lock()
				defer l.mu.Unlock()
				if l.closed || l.job != nil {
					return
				}
				b.accessMu.Lock()
				defer b.accessMu.Unlock()
				if b.manualBorrowers[l.id] != id || (b.terminalWriters[l.id] != "" && b.terminalWriters[l.id] != id) {
					return
				}
				term := b.Store.Terminal(l.session, l.id)
				if term["holder"] == "agent" && term["status"] == "ready" {
					b.Store.Control(l.session, l.id, "user")
				}
				delete(b.manualBorrowers, l.id)
				delete(b.terminalWriters, l.id)
			}
			l.mu.Lock()
			job := l.job
			l.mu.Unlock()
			if job == nil {
				release()
				return
			}
			go func(ctx context.Context) {
				select {
				case <-job.done:
					release()
				case <-ctx.Done():
				}
			}(b.Context)
		}()
	}
}
