package web

import (
	"context"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// The original registered release-v1 watch owns its exact external handle,
// configuration revision and read authority. A build number or MCP stdout alone
// is never sufficient to register another background observer.
func (b *Server) ObserveBuildRun(ctx context.Context, projectID, workerID, itemID string) (ai.SuperBuildObservation, error) {
	return b.Engine.ObserveTaskBuild(ctx, projectID, workerID, itemID)
}
