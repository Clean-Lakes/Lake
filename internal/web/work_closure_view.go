package web

import "github.com/Clean-Lakes/Lake/internal/ai"

// Current reply/AI status may refer to a continued goal from an earlier turn.
// The projection uses that goal alone: another goal's successful execution can
// neither finish it nor clear the original operation ledger's risk records.
func (b *Server) workClosureReplyStatus(sessionID string, view ai.View) (string, bool) {
	closure, err := b.Engine.CurrentWorkClosureView(sessionID)
	if err != nil || !closure.Managed {
		return "", false
	}
	switch closure.Status {
	case "completed":
		return "completed", true
	case "cancelled":
		return "cancelled", true
	default:
		return "failed", true
	}
}
