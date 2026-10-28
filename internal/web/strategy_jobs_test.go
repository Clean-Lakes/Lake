package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func queueStrategyFixture(t *testing.T, s *Store, ctx StrategyContext, scope strategy.Scope, key string) StrategyMutationResult {
	t.Helper()
	asset := createStrategyFixture(t, s, ctx, scope, "source-"+key, "Manual source "+key)
	job := seedLegacyJob(t, s, ctx, scope, "proposal", "", []string{asset.SourceID})

	return job
}
