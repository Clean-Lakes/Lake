package ai

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type SecurityOperationPreparation struct {
	Operation        security.PreparedOperation
	Owner            ExecutionOwner
	expectedMetadata map[string]string
	frozenResources  []security.ResourceRevision
}

// SecurityPreparedOperation freezes authoritative identities/revisions in the
// host. It cannot be unmarshaled from a model tool argument or UI payload.
type SecurityPreparedOperation struct {
	descriptor      security.PreparedOperation
	owner           ExecutionOwner
	digest          string
	engine          *Engine
	executionArgs   map[string]any
	executionConfig Config
	command         *security.FrozenCommand
	read            *securityReadProbe
	mcpFactory      SecurityMCPFactory
}

func (p *SecurityPreparedOperation) Descriptor() (security.PreparedOperation, error) {
	if p == nil || p.digest == "" {
		return security.PreparedOperation{}, errors.New("security: prepared operation required")
	}
	return security.CanonicalOperation(p.descriptor)
}

func (e *Engine) PrepareSecurityOperation(ctx context.Context, request SecurityOperationPreparation) (prepared *SecurityPreparedOperation, decision security.Decision, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, decision, err
	}
	op, owner := request.Operation, request.Owner
	if op.StoreID != "" && op.StoreID != storeID || op.RecoveryEpoch != "" && op.RecoveryEpoch != epoch {
		return nil, decision, security.ErrConflict
	}
	op.StoreID, op.RecoveryEpoch = storeID, epoch
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			now := time.Now().UTC()
			bound, bindErr := e.bindCurrentCatalogSnapshot(ctx, tx, op)
			if bindErr != nil {
				return fmt.Errorf("catalog snapshot: %w", bindErr)
			}
			if request.expectedMetadata != nil {
				value, _ := bound.Get("lake_security_catalog")
				view, ok := value.(SecurityCatalogView)
				if !ok {
					return ErrSecurityCatalogUnavailable
				}
				for _, resource := range view.Resources {
					if request.expectedMetadata[resource.ID] == "" || request.expectedMetadata[resource.ID] != resource.MetadataDigest {
						return errors.New("security: execution configuration changed while preparing operation")
					}
				}
			}
			snapshot, loadErr := loadSecurityEvaluation(bound, op, owner, now)
			if loadErr != nil {
				return fmt.Errorf("evaluation snapshot: %w", loadErr)
			}
			op.FormatVersion, op.RegistryVersion = security.DescriptorVersion, security.RegistryVersion
			op.PolicyRevision, op.TargetRevision = snapshot.Policy.Revision, snapshot.TargetRevision
			op.LegacyPolicyRevision = snapshot.LegacyPolicyRevision
			op.Resources = snapshot.Resources
			if len(request.frozenResources) > 0 {
				for _, resource := range op.Resources {
					matched := false
					for _, frozen := range request.frozenResources {
						if frozen.ID == resource.ID && frozen.ConnectionRevision == resource.ConnectionRevision && frozen.ConnectionDigest == resource.ConnectionDigest {
							matched = true
						}
					}
					if !matched {
						return errors.New("security: workflow resource no longer matches frozen execution target")
					}
				}
			}
			op.LocalExecution = snapshot.LocalExecution
			if op.LocalExecution && !slices.Contains(op.Capabilities, "local.execute") {
				op.Capabilities = append(op.Capabilities, "local.execute")
			}
			op.Credentials = snapshot.CredentialRevisions
			op.TerminalGeneration, op.TerminalContextRevision = snapshot.TerminalGeneration, snapshot.TerminalContextRevision
			op.MCPServerID, op.MCPToolName, op.MCPConfigRevision, op.MCPCatalogRevision = snapshot.MCPServerID, snapshot.MCPToolName, snapshot.MCPConfigRevision, snapshot.MCPCatalogRevision
			op.MCPBindingRevision = snapshot.MCPBindingRevision
			if op.MCPServerID != "" && (op.Tool == "call_mcp_tool" || snapshot.LocalExecution) {
				op.Proof = security.ProofOpaque
			}
			op.Parents = security.FreezeParentBindings(snapshot.Parents)
			op.BoundaryRevisions = nil
			for _, b := range snapshot.Boundaries {
				op.BoundaryRevisions = append(op.BoundaryRevisions, security.RevisionRef{ID: b.ID, Revision: b.Revision})
			}
			op.GrantRevisions = nil
			for _, g := range snapshot.Grants {
				if !g.Revoked && g.RemainingUses > 0 && now.Before(g.ExpiresAt) {
					op.GrantRevisions = append(op.GrantRevisions, security.RevisionRef{ID: g.ID, Revision: g.Revision})
				}
			}
			op.EnvelopeRevision = 0
			if snapshot.Envelope != nil {
				op.EnvelopeRevision = snapshot.Envelope.Revision
			}
			canonical, canonicalErr := security.CanonicalOperation(op)
			if canonicalErr != nil {
				return canonicalErr
			}
			digest, digestErr := security.OperationDigest(canonical)
			if digestErr != nil {
				return digestErr
			}
			snapshot.Operation = canonical
			decision = security.Evaluate(snapshot)
			prepared = &SecurityPreparedOperation{descriptor: canonical, owner: owner, digest: digest, engine: e}
			if value, ok := bound.Get("lake_security_catalog"); ok {
				if view, ok := value.(SecurityCatalogView); ok {
					prepared.mcpFactory = view.MCPFactory
				}
			}
			return nil
		})
	})
	return prepared, decision, err
}

type securityPreparedContextKey struct{}

// SecurityOperationContext is called by the host after Prepare. Setting an
// approved boolean or a similarly named model parameter has no effect.
func SecurityOperationContext(ctx context.Context, prepared *SecurityPreparedOperation) context.Context {
	return context.WithValue(ctx, securityPreparedContextKey{}, prepared)
}

func preparedSecurityOperation(ctx context.Context) *SecurityPreparedOperation {
	p, _ := ctx.Value(securityPreparedContextKey{}).(*SecurityPreparedOperation)
	return p
}

func acquirePreparedSecurityPermitTx(ctx context.Context, tx *gorm.DB, operationID string, now time.Time) (*SecurityPermit, error) {
	p := preparedSecurityOperation(ctx)
	if p == nil || p.descriptor.ID != operationID {
		return nil, errors.New("security: prepared operation identity required")
	}
	if p.engine == nil {
		return nil, ErrSecurityCatalogUnavailable
	}
	bound, err := p.engine.bindCurrentCatalogSnapshot(ctx, tx, p.descriptor)
	if err != nil {
		return nil, err
	}
	permit, err := AcquireSecurityPermitTx(bound, p.descriptor, p.owner, now)
	if err == nil {
		permit.prepared = p
	}
	return permit, err
}

// compareSecurityShadow returns only safe decision facts. It does not consume
// grants/approvals, mutate legacy permissions or open the enforced gate.
func compareSecurityShadow(in security.EvaluationInput, legacyAllowed bool) map[string]any {
	decision := security.Evaluate(in)
	return map[string]any{"operation_id": in.Operation.ID, "descriptor_hash": decision.DescriptorDigest, "effect": decision.Effect, "reason_code": decision.ReasonCode, "differs": legacyAllowed != (decision.Effect == security.EffectAllow)}
}
