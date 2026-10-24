package web

import "time"

// InterruptCommand is deliberately separate from the manual terminal's Ctrl-C.
// A delayed click must never interrupt the next job or another session's job.
func (t *Terminals) InterruptCommand(origin, tid, generation, eid string) {
	owner := origin
	if t.ResolveAccess != nil {
		owner = t.ResolveAccess(origin, tid, true)
	}
	l := t.get(owner, tid)
	l.mu.Lock()
	defer l.mu.Unlock()
	term := t.store.Terminal(owner, tid)
	job := l.job
	if generation == "" || eid == "" || l.closed || job == nil || term["generation"] != generation || term["holder"] != "agent" || term["status"] != "busy" || job.entry["id"] != eid || job.entry["generation"] != generation || job.entry["actor"] != "agent" || job.entry["originSessionId"] != origin {
		fail(409, "命令已结束或终端已变化；未终止其他命令")
	}
	entry := t.store.Entry(owner, tid, eid)
	if stringOf(entry["stopRequestedAt"]) != "" {
		return
	}
	t.store.update(func() any {
		t.store.exec("UPDATE terminalEntries SET stopRequestedAt=? WHERE id=? AND terminalId=?", now(), eid, tid)
		t.store.event(origin, "terminal")
		return nil
	})
	t.interruptLocked(l)
}

func stoppedCommandObservation(entry Object) Object {
	if stringOf(entry["stopRequestedAt"]) != "" {
		entry["userStopped"] = true
		entry["notice"] = "用户已请求终止这条终端命令；不代表执行成功，不要自动重试该命令。其他资源的操作继续按原计划进行。"
	}
	return entry
}

// This guard lasts until the next user message. An automatic tool retry cannot
// silently undo the human's stop decision; unrelated commands remain available.
func (s *Store) assertCommandNotStopped(origin, resource, command string) {
	s.read(func() any {
		user := s.row("SELECT createdAt FROM messages WHERE sessionId=? AND role='user' ORDER BY rowid DESC LIMIT 1", origin)
		latest, _ := time.Parse(time.RFC3339Nano, stringOf(user["createdAt"]))
		for _, entry := range s.rows("SELECT e.stopRequestedAt FROM terminalEntries e JOIN terminals t ON t.id=e.terminalId WHERE e.originSessionId=? AND t.resourceId=? AND e.command=? AND e.stopRequestedAt IS NOT NULL", origin, resource, command) {
			stopped, err := time.Parse(time.RFC3339Nano, stringOf(entry["stopRequestedAt"]))
			if err == nil && !stopped.Before(latest) {
				fail(409, "该资源的这条命令已被用户终止；请等待新的用户指示，不要自动重试。其他资源不受影响。")
			}
		}
		return nil
	})
}

func (s *Store) commandStopNotices(origin string) []Object {
	return s.read(func() any {
		return s.rows("SELECT e.id AS entryId,e.terminalId,t.resourceId,r.name AS resourceName,e.stopRequestedAt AS requestedAt,e.status,e.exitCode,e.finishedAt FROM terminalEntries e JOIN terminals t ON t.id=e.terminalId JOIN resources r ON r.id=t.resourceId WHERE e.originSessionId=? AND e.stopRequestedAt IS NOT NULL ORDER BY e.rowid DESC LIMIT 100", origin)
	}).([]Object)
}
