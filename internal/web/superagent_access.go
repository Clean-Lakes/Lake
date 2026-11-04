package web

import (
	"errors"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"gorm.io/gorm"
)

// Only the authenticated settings route calls this adapter. Generic refreshes
// and Worker configuration cannot silently replace a captured permission set.
func (b *Server) syncSuperPermissionSettings(session string, permissions ai.Permissions) error {
	project := stringOf(b.Store.Session(session)["projectId"])
	_, active, err := b.Engine.SuperProject(b.Context, project)
	if err != nil || !active {
		return err
	}
	policy, err := b.Engine.SecurityProjectPolicy(b.Context, project)
	if err != nil || policy.Mode != "legacy" {
		return err
	}
	previous, err := b.Engine.SecurityLegacySessionPolicy(b.Context, project, session)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil // First Configure captures these actual host settings.
	}
	if err != nil || previous.Permissions == permissions {
		return err
	}
	_, err = b.Engine.UpdateSecurityLegacySessionPolicy(b.Context, ai.SecurityLegacyPolicyAction{SecurityPolicyAction: ai.SecurityPolicyAction{ActorID: "local-user", ActionID: "permission-settings:" + ident(), ProjectID: project, ExpectedRevision: previous.Revision}, SessionID: session, Permissions: permissions})
	return err
}
