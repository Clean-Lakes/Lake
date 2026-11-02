package web

import (
	"context"
	"errors"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// The original registered release-v1 watch owns its exact external handle,
// configuration revision and read authority. A build number or MCP stdout alone
// is never sufficient to register another background observer.
func (b *Server) ObserveBuildRun(ctx context.Context, projectID, workerID, itemID string) (ai.SuperBuildObservation, error) {
	return b.Engine.ObserveTaskBuild(ctx, projectID, workerID, itemID)
}

// Called only after Security has committed the original occurrence/task/run.
// Registering it is metadata-only and cannot turn a timer into a human source.
func (b *Server) ReceiveScheduleOccurrence(ctx context.Context, binding ai.SecurityWorkflowRunBinding) (ai.SuperRouteResult, error) {
	if binding.SourceKind != "schedule_occurrence" || binding.SourceEventID == "" {
		return ai.SuperRouteResult{}, errors.New("superagent: actual authorized schedule occurrence required")
	}
	return b.Engine.RegisterSuperWorkflow(ctx, binding)
}
