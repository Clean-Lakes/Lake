package ai

import (
	"github.com/Clean-Lakes/Lake/internal/security"
	"slices"
)

// A typed action can still partially mutate its target before failing. Only
// the implemented diagnostic/read adapters prove that no write was requested.
func securityOperationMayMutate(op security.PreparedOperation) bool {
	if op.Proof == security.ProofOpaque {
		return true
	}
	if op.Proof == security.ProofCommandProfile && op.CommandProfileVersion == security.CommandProfileVersion && slices.Contains([]string{"disk_usage", "process_snapshot", "service_status", "service_logs"}, op.CommandProfileID) {
		return false
	}
	if _, ok := SecurityReadVerifierProfile(op); ok {
		return false
	}
	if op.Proof == security.ProofStructured && slices.Contains([]string{"read", "ls", "observe_logs"}, op.Tool) && len(op.Resources) == 1 && op.Resources[0].Local && op.Scope.FileRoot != "" && op.Scope.FileRootIdentity != "" && op.Scope.FileIdentity != "" {
		return false
	}
	for _, capability := range op.Capabilities {
		if !securityReadOnlyCapability(capability) {
			return true
		}
	}
	return false
}
