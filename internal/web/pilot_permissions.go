package web

import (
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
)

var permissionOptionKeys = []string{"silentReadFiles", "silentWriteFiles", "silentReadSQL", "silentCommands", "silentTerminalCreation", "silentMCPCalls", "blockUnreferencedAssets", "denyLocalExecution"}

// Called with the Web store lock. Only host-owned role mappings can select
// the project's stable Pilot; caller/model options cannot choose an authority.
func (s *Store) permissionOwnerLocked(id string) string {
	mapping := s.row("SELECT projectId,kind FROM superagentSessions WHERE sessionId=?", id)
	if mapping == nil || mapping["kind"] != "role" && mapping["kind"] != "worker" {
		return id
	}
	pilot := s.row("SELECT sessionId FROM superagentSessions WHERE projectId=? AND kind='router'", mapping["projectId"])
	if pilot == nil {
		fail(409, "当前项目的 Pilot 权限来源不可用")
	}
	return stringOf(pilot["sessionId"])
}

func (s *Store) permissionOwner(id string) string {
	return s.read(func() any { return s.permissionOwnerLocked(id) }).(string)
}

func (b *Server) capturePilotPermissions(ctx context.Context, domain ai.SuperProject) error {
	options := b.sessionOptions(domain.RouterSessionID)
	p := ai.DefaultPermissions()
	if err := json.Unmarshal([]byte(jsonText(options)), &p); err != nil {
		return err
	}
	return b.Engine.CaptureSecurityLegacyPolicy(ctx, domain.ProjectID, domain.RouterSessionID, "web", ai.Config{Permissions: &p})
}
