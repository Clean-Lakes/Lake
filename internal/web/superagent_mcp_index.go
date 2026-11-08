package web

import (
	"context"
	"slices"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// The planning index reads local public labels only. Listing tools can connect
// to a remote service or start a stdio process and stays on the execution path.
func (b *Server) projectMCPIndex(ctx context.Context, project string, permissions *ai.Permissions) []ai.ProjectMCPServer {
	if b.Extensions == nil || permissions == nil || permissions.BlockUnreferencedAssets {
		return nil
	}
	ids, err := b.Engine.SecurityProjectMCPServerIDs(ctx, project)
	if err != nil || len(ids) == 0 {
		return nil
	}
	config, err := b.Extensions.Store.Read()
	if err != nil {
		return nil
	}
	storage, err := securityFileMetadata(b.Extensions.Store.Path())
	if err != nil {
		return nil
	}
	out := make([]ai.ProjectMCPServer, 0, len(ids))
	for _, s := range config.Servers {
		if !s.Enabled || !slices.Contains(ids, s.ID) || s.Transport == "stdio" && permissions.DenyLocalExecution {
			continue
		}
		if _, err := b.Engine.SecurityMCPInspectionRevision(ctx, s.ID, securityMCPMetadata(s), storage); err == nil {
			out = append(out, ai.ProjectMCPServer{ID: s.ID, Name: s.Name})
		}
	}
	return out
}
