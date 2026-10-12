package web

import (
	"crypto/sha256"
	"fmt"
)

type TerminalAccess struct {
	RequestSessionID, OwnerSessionID, ResourceID, TerminalID, Generation, PermissionsVersion string
}

func (s *Store) projectTerminal(id, tid string) Object {
	return s.read(func() any {
		session := s.session(id)
		term := required(s.row("SELECT id,sessionId,resourceId,status,holder,contextVersion,createdAt,generation,outputCapturedAt,cwd,shell FROM terminals WHERE id=?", tid), "Terminal")
		if s.session(stringOf(term["sessionId"]))["projectId"] != session["projectId"] {
			fail(404, "Terminal not in session project")
		}
		s.assertResource(id, stringOf(term["resourceId"]))
		return term
	}).(Object)
}
func permissionVersion(options Object) string {
	p := Object{}
	for _, key := range []string{"silentCommands", "silentTerminalCreation", "silentReadFiles", "silentWriteFiles", "silentReadSQL", "denyLocalExecution", "blockUnreferencedAssets"} {
		p[key] = options[key]
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(jsonText(p))))
}
func (b *Server) ResolveTerminalAccess(id, tid string, write bool) TerminalAccess {
	term := b.Store.projectTerminal(id, tid)
	owner := stringOf(term["sessionId"])
	access := TerminalAccess{id, owner, stringOf(term["resourceId"]), tid, stringOf(term["generation"]), permissionVersion(b.sessionOptions(id))}
	b.accessMu.Lock()
	defer b.accessMu.Unlock()
	if owner != id {
		grant, ok := b.terminalGrants[id+":"+tid]
		if !ok || grant != access || term["status"] == "disconnected" {
			fail(403, "采用此终端需要明确授权，或授权已经失效")
		}
	}
	if write {
		writer := b.terminalWriters[tid]
		if writer == "" {
			writer = owner
		}
		if writer != id {
			fail(409, "此终端的 Agent 写入由另一会话持有，请明确交接")
		}
	}
	return access
}
func (b *Server) adoptTerminal(id, tid, generation string) Object {
	term := b.Store.projectTerminal(id, tid)
	if stringOf(term["generation"]) != generation || term["status"] == "disconnected" {
		fail(409, "Terminal generation changed or disconnected")
	}
	grant := TerminalAccess{id, stringOf(term["sessionId"]), stringOf(term["resourceId"]), tid, generation, permissionVersion(b.sessionOptions(id))}
	b.accessMu.Lock()
	if b.terminalGrants == nil {
		b.terminalGrants = map[string]TerminalAccess{}
	}
	b.terminalGrants[id+":"+tid] = grant
	b.accessMu.Unlock()
	term["access"] = "adopted"
	return term
}

// A failed bind restores the previous access record; it never leaves a new grant.
func (b *Server) adoptAndBindTerminal(id, tid, generation string, bind bool) (result Object) {
	b.bindingMu.Lock()
	defer b.bindingMu.Unlock()
	if bind {
		view, err := b.Engine.Snapshot(id)
		aiFailure(err)
		if view.Status == "running" || view.Status == "waiting_approval" {
			fail(409, "先处理审批或停止本轮，再切换绑定终端")
		}
	}
	key := id + ":" + tid
	b.accessMu.Lock()
	previous, existed := b.terminalGrants[key]
	b.accessMu.Unlock()
	committed := false
	defer func() {
		if !committed {
			b.accessMu.Lock()
			if existed {
				b.terminalGrants[key] = previous
			} else {
				delete(b.terminalGrants, key)
			}
			b.accessMu.Unlock()
		}
	}()
	result = b.adoptTerminal(id, tid, generation)
	if bind {
		b.configure(id, Object{"profile": "terminal2", "terminal_id": tid, "asset_ref": result["resourceId"], "runtime": b.Store.Resource(stringOf(result["resourceId"]))["kind"]})
	}
	aiFailure(b.Engine.RememberResource(id, stringOf(result["resourceId"])))
	committed = true
	return result
}
func (b *Server) revokeTerminal(tid string) {
	b.accessMu.Lock()
	defer b.accessMu.Unlock()
	for key, grant := range b.terminalGrants {
		if grant.TerminalID == tid {
			delete(b.terminalGrants, key)
		}
	}
	delete(b.terminalWriters, tid)
	delete(b.manualBorrowers, tid)
	for key, binding := range b.manualBindings {
		if binding.TerminalID == tid {
			delete(b.manualBindings, key)
		}
	}
}
func (b *Server) terminalOwner(id, tid string, write bool) string {
	return b.ResolveTerminalAccess(id, tid, write).OwnerSessionID
}
func (b *Server) closeTerminalByUser(id, tid string) {
	access := b.ResolveTerminalAccess(id, tid, false)
	b.Terminals.closeOwned(access.OwnerSessionID, tid)
}
func (b *Server) terminalForSession(id, tid string) Object {
	owner := b.terminalOwner(id, tid, false)
	return b.Store.Terminal(owner, tid)
}
func (b *Server) transferTerminal(id, tid string, holder any) Object {
	access := b.ResolveTerminalAccess(id, tid, false)
	term := b.Store.Terminal(access.OwnerSessionID, tid)
	if holder == "agent" && term["status"] != "ready" {
		fail(409, "Agent transfer requires idle terminal")
	}
	// Existing writers may only be replaced by this explicit user control action.
	result := b.Terminals.Control(access.OwnerSessionID, tid, holder)
	b.accessMu.Lock()
	if b.terminalWriters == nil {
		b.terminalWriters = map[string]string{}
	}
	if holder == "agent" {
		b.terminalWriters[tid] = id
	} else {
		delete(b.terminalWriters, tid)
		for key, grant := range b.terminalGrants {
			if grant.TerminalID == tid {
				delete(b.terminalGrants, key)
			}
		}
	}
	b.accessMu.Unlock()
	return result
}

func (b *Server) revokeSessionTerminals(id string) {
	b.releaseManualTerminals(id)
	b.accessMu.Lock()
	defer b.accessMu.Unlock()
	for key, grant := range b.terminalGrants {
		if grant.RequestSessionID == id || grant.OwnerSessionID == id {
			delete(b.terminalGrants, key)
		}
	}
	for tid, writer := range b.terminalWriters {
		if writer == id {
			delete(b.terminalWriters, tid)
		}
	}
	for key, binding := range b.manualBindings {
		if binding.RequestSessionID == id || binding.OwnerSessionID == id {
			delete(b.manualBindings, key)
		}
	}
}
