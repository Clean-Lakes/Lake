package web

import "context"

// ScreenResult separates persisted output from the screen of a connected process.
func (t *Terminals) ScreenResult(id, tid, mode string, lines, maxChars int) Object {
	if t.ResolveAccess != nil {
		id = t.ResolveAccess(id, tid, false)
	}
	if maxChars < 1 || maxChars > 100000 {
		maxChars = 20000
	}
	term := t.store.Terminal(id, tid)
	t.mu.Lock()
	l := t.live[tid]
	t.mu.Unlock()
	if l != nil {
		l.mu.Lock()
		defer l.mu.Unlock()
		if !l.closed {
			term = t.store.Terminal(id, tid)
			return Object{"terminal_id": tid, "terminalId": tid, "generation": term["generation"], "text": t.screenLocked(l, mode, lines, maxChars), "source": "live", "capturedAt": now(), "outputUpdatedAt": l.capturedAt, "status": term["status"], "mode": mode}
		}
	}
	history := t.store.History(id, tid)
	term = object(history["terminal"])
	return Object{"terminal_id": tid, "terminalId": tid, "generation": term["generation"], "text": tail(stringOf(history["output"]), maxChars), "source": "historical", "capturedAt": term["outputCapturedAt"], "status": term["status"], "mode": mode}
}

func (b *Server) waitTerminal(ctx context.Context, id, tid, eid string) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
				return
			}
			panic(p)
		}
	}()
	return b.Terminals.Wait(ctx, id, tid, eid), nil
}
