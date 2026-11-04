package web

import (
	"net/http"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) securitySourceMessage(sessionID, messageID string) {
	if messageID == "" {
		fail(400, "sourceMessageId required")
	}
	found, project := false, ""
	b.Store.read(func() any {
		session := b.Store.session(sessionID)
		project = stringOf(session["projectId"])
		found = b.Store.row("SELECT id FROM messages WHERE id=? AND sessionId=? AND role='user'", messageID, sessionID) != nil
		return nil
	})
	if found {
		return
	}
	event, err := b.Engine.SuperWorkerSource(b.Context, project, sessionID, messageID)
	if err != nil {
		fail(409, "Original user message binding required")
	}
	b.Store.read(func() any {
		sourceSession := b.Store.session(event.ThreadRef)
		message := b.Store.row("SELECT text FROM messages WHERE id=? AND sessionId=? AND role='user'", messageID, event.ThreadRef)
		if sourceSession["projectId"] != project || message == nil || message["text"] != event.Payload {
			fail(409, "Original user message binding required")
		}
		return nil
	})
}

func (b *Server) securityScopeAction(sessionID string, data Object) (ai.SecurityScopeAction, []string) {
	session := b.Store.Session(sessionID)
	a := ai.SecurityScopeAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: stringOf(session["projectId"]), SessionID: sessionID, SourceMessageID: stringOf(data["sourceMessageId"]), ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}
	if a.ActionID == "" || len(a.ActionID) > 256 {
		fail(400, "actionId required")
	}
	b.securitySourceMessage(sessionID, a.SourceMessageID)
	return a, stringsOf(session["resourceIds"])
}

// securityBoundaryRoute adds management APIs only. It does not modify existing
// frontend contracts, synthesize an approval, or treat target selection as a
// grant. ServeHTTP must call it after the normal protection/authentication gate.
func (b *Server) securityBoundaryRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	target := len(parts) == 4 && parts[0] == "api" && parts[1] == "sessions" && parts[3] == "target"
	migration := len(parts) == 5 && parts[0] == "api" && parts[1] == "sessions" && parts[3] == "security-migration" && parts[4] == "resolve"
	boundary := len(parts) == 3 && parts[0] == "api" && parts[1] == "security-boundaries"
	if !target && !migration && !boundary {
		return false
	}
	b.protect(r)
	if !b.authorized(r) {
		fail(401, "Authentication required")
	}
	if b.Engine == nil {
		fail(503, "Security runtime unavailable")
	}
	if target {
		session := b.Store.Session(parts[2])
		if method == "GET" {
			result, err := b.Engine.SecurityTarget(r.Context(), stringOf(session["projectId"]), parts[2])
			aiFailure(err)
			boundaries, err := b.Engine.SecurityBoundaries(r.Context(), stringOf(session["projectId"]), parts[2])
			aiFailure(err)
			reply(w, 200, Object{"target": result, "boundaries": boundaries})
			return true
		}
		if method != "PUT" {
			fail(405, "Method not allowed")
		}
		data := body(w, r, 32*1024)
		memoryFields(data, "actionId", "sourceMessageId", "expectedRevision", "resourceIds")
		validateIDs(data["resourceIds"])
		a, visible := b.securityScopeAction(parts[2], data)
		result, err := b.Engine.UpdateSecurityTarget(r.Context(), ai.SecurityTargetUpdate{Action: a, ResourceIDs: stringsOf(data["resourceIds"]), Source: "explicit_selection"}, visible)
		aiFailure(err)
		reply(w, 200, result)
		return true
	}
	if migration {
		if method != "POST" {
			fail(405, "Method not allowed")
		}
		data := body(w, r, 32*1024)
		memoryFields(data, "actionId", "sourceMessageId", "expectedRevision", "targetIds", "boundaryDecision")
		validateIDs(data["targetIds"])
		a, visible := b.securityScopeAction(parts[2], data)
		result, err := b.Engine.ResolveLegacyScope(r.Context(), ai.SecurityMigrationResolution{Action: a, TargetIDs: stringsOf(data["targetIds"]), BoundaryDecision: stringOf(data["boundaryDecision"])}, visible)
		aiFailure(err)
		reply(w, 200, result)
		return true
	}
	if method != "PUT" {
		fail(405, "Method not allowed")
	}
	data := body(w, r, 32*1024)
	memoryFields(data, "sessionId", "actionId", "sourceMessageId", "expectedRevision", "resourceIds", "denyLocal")
	validateIDs(data["resourceIds"])
	a, visible := b.securityScopeAction(stringOf(data["sessionId"]), data)
	result, err := b.Engine.UpdateSecurityBoundary(r.Context(), ai.SecurityBoundaryUpdate{Action: a, BoundaryID: parts[2], ResourceIDs: stringsOf(data["resourceIds"]), DenyLocal: memoryBool(data["denyLocal"], "denyLocal")}, visible)
	aiFailure(err)
	reply(w, 200, result)
	return true
}
