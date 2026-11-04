package web

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Agent-only handoffs follow h.mu -> live.mu -> accessMu -> Store. Human
// control keeps its existing entry points and cannot be cancelled by closing
// an entire terminal from an Agent command.
func (b *Server) withSecurityTerminal(ctx context.Context, id, tid, kind, payload string, perform func(*liveTerminal, Object, ai.SecurityTerminalHandoff) error) error {
	project := stringOf(b.Store.Session(id)["projectId"])
	return b.Engine.WithSecurityTerminalHandoff(ctx, project, id, tid, kind, payload, func(h ai.SecurityTerminalHandoff) error {
		access := b.ResolveTerminalAccess(id, tid, true)
		l := b.Terminals.get(access.OwnerSessionID, tid)
		l.mu.Lock()
		defer l.mu.Unlock()
		b.accessMu.Lock()
		defer b.accessMu.Unlock()
		term := b.Store.Terminal(access.OwnerSessionID, tid)
		writer := b.terminalWriters[tid]
		if writer == "" {
			writer = access.OwnerSessionID
		}
		if l.closed || !l.ready || writer != id || term["holder"] != "agent" || stringOf(term["generation"]) != h.Generation() || int64(integer(term["contextVersion"])) != h.ContextRevision() || stringOf(term["resourceId"]) != h.ResourceID() {
			return errors.New("security: terminal ownership or frozen context changed")
		}
		// Recheck adopted access after acquiring the handoff lock; revocation and
		// writer transfer cannot race the actual local PTY write.
		if access.OwnerSessionID != id && b.terminalGrants[id+":"+tid] != access {
			return errors.New("security: terminal adoption revoked")
		}
		return perform(l, term, h)
	})
}

func (b *Server) executeSecurityTerminal(ctx context.Context, id, tid, command string) (entry Object, err error) {
	if !validCommand(command) || b.Terminals.containsCredential(command) || strings.Contains(command, "-----BEGIN") {
		return nil, &ai.ToolNotExecutedError{Err: errors.New("invalid terminal command")}
	}
	attempted := false
	err = b.withSecurityTerminal(ctx, id, tid, "command", command, func(l *liveTerminal, term Object, h ai.SecurityTerminalHandoff) error {
		if term["status"] != "ready" || l.job != nil {
			return errors.New("security: terminal already has a command")
		}
		entry = b.Store.beginSecurityTerminalCommand(l.session, tid, id, command, h.Generation(), h.ContextRevision())
		if err := h.BindEntry(stringOf(entry["id"]), ""); err != nil {
			b.Store.Finish(l.session, tid, stringOf(entry["id"]), "No command was submitted", nil, false, "")
			return err
		}
		job := &terminalJob{entry: entry, marker: ident(), done: make(chan struct{}), securityOperationID: h.OperationID(), securityDescriptorDigest: h.DescriptorDigest(), securityOwnerID: h.OwnerID(), securityOwnerGeneration: h.OwnerGeneration()}
		l.job = job
		l.inputSeen = true
		if l.interactive {
			l.hiddenAgentOutput = true
			job.startMarker = "\x1eLAKE_START_" + job.marker + "\x1f"
		} else {
			l.hiddenAgentOutput = false
			l.output = tail(l.output+"\r\nagent > "+command+"\r\n", outputLimit)
		}
		b.Terminals.mu.Lock()
		b.Terminals.jobs[stringOf(entry["id"])] = job
		if b.Terminals.securityJobs == nil {
			b.Terminals.securityJobs = map[string]*terminalJob{}
		}
		if len(b.Terminals.securityJobs) >= 1024 {
			for key, old := range b.Terminals.securityJobs {
				select {
				case <-old.done:
					delete(b.Terminals.securityJobs, key)
				default:
				}
				if len(b.Terminals.securityJobs) < 1024 {
					break
				}
			}
		}
		b.Terminals.securityJobs[h.OperationID()] = job
		b.Terminals.mu.Unlock()
		attempted = true
		// Execute exactly the reviewed command. Legacy prefix rewriting is not an
		// authority or a substitute for the frozen single-command descriptor.
		n, writeErr := l.pty.WriteString(commandFrame(l, command, job.marker))
		b.Terminals.flush(l)
		if writeErr != nil || n != len(commandFrame(l, command, job.marker)) {
			entry["status"] = "unknown"
			return fmt.Errorf("terminal handoff failed; original entry outcome unknown")
		}
		return nil
	})
	if err != nil && !attempted {
		return entry, &ai.ToolNotExecutedError{Err: err}
	}
	return entry, err
}

func (b *Server) inputSecurityTerminal(ctx context.Context, id, tid, input string) error {
	if input == "" || len(input) > 4096 || strings.ContainsRune(input, 0) || b.Terminals.containsCredential(input) {
		return &ai.ToolNotExecutedError{Err: errors.New("invalid terminal input")}
	}
	attempted := false
	err := b.withSecurityTerminal(ctx, id, tid, "input", input, func(l *liveTerminal, term Object, h ai.SecurityTerminalHandoff) error {
		job := l.job
		if term["status"] != "busy" || job == nil || job.changed || job.securityOperationID == "" || job.entry["actor"] != "agent" || job.entry["originSessionId"] != id || job.entry["generation"] != h.Generation() {
			return errors.New("security: input requires this task's exact live Agent command")
		}
		if err := h.BindEntry(stringOf(job.entry["id"]), job.securityOperationID); err != nil {
			return err
		}
		attempted = true
		n, err := l.pty.WriteString(input)
		l.inputSeen = true
		if err != nil || n != len(input) {
			return errors.New("terminal input outcome unknown")
		}
		return nil
	})
	if err != nil && !attempted {
		return &ai.ToolNotExecutedError{Err: err}
	}
	return err
}

// This is a projection row, not an approval ledger. Only the host-only permit
// callback may invoke it; original authority/consumption stays in the ADK DB.
func (s *Store) beginSecurityTerminalCommand(owner, tid, origin, command, generation string, revision int64) Object {
	return s.update(func() any {
		term := s.terminal(owner, tid)
		if term["status"] != "ready" || term["holder"] != "agent" || term["generation"] != generation || int64(integer(term["contextVersion"])) != revision {
			fail(409, "Terminal changed before handoff")
		}
		eid := ident()
		s.exec("INSERT INTO terminalEntries(id,terminalId,actor,command,output,exitCode,createdAt,status,generation,cwd,startedAt,originSessionId) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", eid, tid, "agent", command, "", nil, now(), "running", generation, term["cwd"], now(), origin)
		s.exec("UPDATE terminals SET status='busy',contextVersion=contextVersion+1 WHERE id=?", tid)
		s.event(owner, "terminal")
		return s.row("SELECT id,terminalId,actor,command,output,exitCode,createdAt,status,generation,cwd,startedAt,finishedAt,originSessionId,stopRequestedAt FROM terminalEntries WHERE id=?", eid)
	}).(Object)
}

type securityTerminalCleanup struct{ server *Server }

func (b *Server) securityTerminalCleanupResolver(tool, resourceID string) ai.OrphanCleanupAdapter {
	if set("shell terminal_execute_command ssh_terminal_send terminal_send_input ssh_terminal_key terminal_send_key ssh_terminal_expect terminal_expect")[tool] {
		return &securityTerminalCleanup{server: b}
	}
	return nil
}
func (a *securityTerminalCleanup) liveOriginal(cleanup ai.ExecutionCleanup) (*liveTerminal, *terminalJob, error) {
	tid, eid, ok := strings.Cut(cleanup.Handle, ":")
	if !ok || tid == "" || eid == "" || cleanup.OperationID == "" || cleanup.DescriptorDigest == "" {
		return nil, nil, errors.New("security: no exact original terminal handle")
	}
	t := a.server.Terminals
	t.mu.Lock()
	l := t.live[tid]
	t.mu.Unlock()
	if l == nil {
		return nil, nil, errors.New("security: original terminal unavailable")
	}
	// Caller holds l.mu while inspecting the job and signalling. Never guess a
	// replacement job or process ID after reconnect or human takeover.
	return l, nil, nil
}
func (a *securityTerminalCleanup) Cancel(ctx context.Context, cleanup ai.ExecutionCleanup) (ai.CancellationObservation, error) {
	if err := ctx.Err(); err != nil {
		return ai.CancellationUnknown, err
	}
	l, _, err := a.liveOriginal(cleanup)
	if err != nil {
		return ai.CancellationUnsupported, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, eid, _ := strings.Cut(cleanup.Handle, ":")
	job := l.job
	if job == nil || l.closed || job.changed || job.securityOperationID != cleanup.OperationID || job.securityDescriptorDigest != cleanup.DescriptorDigest || job.securityOwnerID != cleanup.OwnerID || job.securityOwnerGeneration != cleanup.OwnerGeneration || stringOf(job.entry["id"]) != eid {
		return ai.CancellationUnsupported, errors.New("security: original Agent job unavailable or handed to human")
	}
	term := a.server.Store.Terminal(l.session, l.id)
	if term["holder"] != "agent" || term["status"] != "busy" || term["generation"] != job.entry["generation"] {
		return ai.CancellationUnsupported, errors.New("security: terminal ownership changed")
	}
	// A single Ctrl-C is a stop request, never proof of remote termination or
	// known effects. No delayed input, recovery Shell text, or whole-PTY close.
	if _, err = l.pty.WriteString("\x03"); err != nil {
		return ai.CancellationUnknown, err
	}
	return ai.CancellationRequested, nil
}
func (a *securityTerminalCleanup) Observe(ctx context.Context, cleanup ai.ExecutionCleanup) (ai.OrphanObservation, error) {
	if err := ctx.Err(); err != nil {
		return ai.OrphanObservation{}, err
	}
	l, _, err := a.liveOriginal(cleanup)
	if err != nil {
		return ai.OrphanObservation{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, eid, _ := strings.Cut(cleanup.Handle, ":")
	if l.job != nil {
		job := l.job
		if job.securityOperationID != cleanup.OperationID || job.securityDescriptorDigest != cleanup.DescriptorDigest || job.securityOwnerID != cleanup.OwnerID || job.securityOwnerGeneration != cleanup.OwnerGeneration || stringOf(job.entry["id"]) != eid {
			return ai.OrphanObservation{}, errors.New("security: terminal now belongs to a different job")
		}
		return ai.OrphanObservation{}, nil
	}
	// Finished rows are observations only. An arbitrary Shell exit, Ctrl-C or
	// transport disconnect never resolves its external effects automatically.

	a.server.Terminals.mu.Lock()
	registered := a.server.Terminals.securityJobs[cleanup.OperationID]
	a.server.Terminals.mu.Unlock()
	if registered == nil || registered.securityDescriptorDigest != cleanup.DescriptorDigest || registered.securityOwnerID != cleanup.OwnerID || registered.securityOwnerGeneration != cleanup.OwnerGeneration || registered.entry["id"] != eid || registered.entry["terminalId"] != l.id {
		return ai.OrphanObservation{}, errors.New("security: original terminal observation binding unavailable")
	}
	term := a.server.Store.Terminal(l.session, l.id)
	if term["generation"] != registered.entry["generation"] {
		return ai.OrphanObservation{}, errors.New("security: terminal generation changed")
	}
	entry := a.server.Store.Entry(l.session, l.id, eid)
	if entry["status"] == "running" || entry["status"] == "unknown" || entry["exitCode"] == nil {
		return ai.OrphanObservation{}, nil
	}
	return ai.OrphanObservation{Stopped: true, EffectsKnown: false, Status: "failed", Evidence: "terminal-entry:" + eid}, nil
}
