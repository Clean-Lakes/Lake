package web

// Resource terminals need an event/history owner, but opening a shell must not
// create a user-facing chat. Reuse one private runtime scope per resource.
func (s *Store) ResourceTerminalSession(ref string) Object {
	return s.update(func() any {
		resource := s.resource(ref)
		if resource["kind"] != "local" && resource["kind"] != "ssh" {
			fail(400, "此资源不支持交互终端")
		}
		project := stringOf(resource["projectId"])
		scope := s.row("SELECT sessionId FROM aiScopes WHERE scope='resource-terminal' AND projectId=? AND resourceKind=? AND resourceId=?", project, resource["kind"], ref)
		if scope != nil {
			return s.session(stringOf(scope["sessionId"]))
		}
		id, time := ident(), now()
		s.exec("INSERT INTO sessions(id,projectId,title,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", id, project, stringOf(resource["name"])+" · 资源终端", "idle", time, time)
		s.exec("INSERT INTO aiScopes(scope,projectId,resourceKind,resourceId,sessionId) VALUES('resource-terminal',?,?,?,?)", project, resource["kind"], ref, id)
		return s.session(id)
	}).(Object)
}

// ResolveTerminalAISession is transactional: concurrent first use returns one session.
func (s *Store) ResolveTerminalAISession(id, tid string) Object {
	term := s.projectTerminal(id, tid)
	return s.update(func() any {
		session := s.session(id)
		resource := s.resource(stringOf(term["resourceId"]))
		project := stringOf(session["projectId"])
		scope := s.row("SELECT sessionId FROM aiScopes WHERE scope='enhanced-terminal' AND projectId=? AND resourceKind=? AND resourceId=?", project, resource["kind"], resource["id"])
		if scope != nil {
			return s.session(stringOf(scope["sessionId"]))
		}
		sid, time := ident(), now()
		s.exec("INSERT INTO sessions(id,projectId,title,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", sid, project, stringOf(resource["name"])+" · 终端 AI", "idle", time, time)
		s.exec("INSERT INTO aiScopes(scope,projectId,resourceKind,resourceId,sessionId) VALUES('enhanced-terminal',?,?,?,?)", project, resource["kind"], resource["id"], sid)
		s.exec("INSERT INTO aiOptions(sessionId,value) VALUES(?,?)", sid, jsonText(Object{"profile": "terminal2", "asset_ref": resource["id"], "runtime": resource["kind"]}))
		s.event(sid, "session")
		return s.session(sid)
	}).(Object)
}

func (s *Store) AvailableTerminals(id string) []Object {
	return s.read(func() any {
		session := s.session(id)
		return s.rows("SELECT t.id,t.sessionId,t.resourceId,t.status,t.holder,t.contextVersion,t.createdAt,t.generation,t.outputCapturedAt,t.cwd,t.shell,s.title AS ownerTitle FROM terminals t JOIN sessions s ON s.id=t.sessionId WHERE s.projectId=? AND t.status!='disconnected' ORDER BY t.createdAt,t.rowid", session["projectId"])
	}).([]Object)
}

func (b *Server) sessionSnapshot(id string) Object {
	snap := b.Store.Snapshot(id)
	own := objects(snap["terminals"])
	seen := map[string]bool{}
	for _, term := range own {
		seen[stringOf(term["id"])] = true
	}
	// Access is rechecked for every candidate, so revoked grants do not expose history.
	for _, term := range b.Store.AvailableTerminals(id) {
		tid := stringOf(term["id"])
		if seen[tid] {
			continue
		}
		func() {
			defer func() { recover() }()
			b.ResolveTerminalAccess(id, tid, false)
			term["access"] = "adopted"
			own = append(own, term)
		}()
	}
	for _, term := range own {
		term["interactive"] = b.Terminals.UserInteractive(stringOf(term["id"]))
		b.accessMu.Lock()
		writer := b.terminalWriters[stringOf(term["id"])]
		b.accessMu.Unlock()
		if writer == "" {
			writer = stringOf(term["sessionId"])
		}
		term["writerSessionId"] = writer
	}
	opts := b.Store.Options(id)
	snap["conversationMode"] = b.conversationMode(id)
	snap["aiBinding"] = Object{"terminalId": opts["terminal_id"], "generation": opts["terminal_generation"]}
	snap["terminals"] = own
	snap["sre"] = b.sreSnapshot(id)
	return snap
}
