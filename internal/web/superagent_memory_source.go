package web

import "context"

// Add a read-time host sidecar, preserving the stored Memory source, revision
// and snapshot hash. Deleted/forgotten sources do not become available again.
func (b *Server) superMemorySources(ctx context.Context, project string, entry Object) Object {
	for _, source := range objects(entry["sources"]) {
		session, message := stringOf(source["sessionId"]), stringOf(source["messageId"])
		if session == "" || message == "" {
			continue
		}
		valid := b.Store.read(func() any {
			return b.Store.row("SELECT m.id FROM messages m JOIN sessions s ON s.id=m.sessionId WHERE m.sessionId=? AND m.id=? AND s.projectId=? AND m.role='user'", session, message, project) != nil
		}).(bool)
		if !valid {
			continue
		}
		if metadata, err := b.Engine.SuperMemorySourceContext(ctx, project, session, message); err == nil && metadata != nil {
			source["taskContext"] = metadata
		}
	}
	return entry
}
