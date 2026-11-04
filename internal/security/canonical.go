package security

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
)

const DescriptorVersion = 1

// CanonicalOperation copies all slices before sorting. An adapter must retain
// this frozen value rather than resolving targets again after authorization.
func CanonicalOperation(in PreparedOperation) (PreparedOperation, error) {
	o := in
	if o.FormatVersion != DescriptorVersion || o.CommandTargetRevision < 0 || o.LegacyPolicyRevision < 0 || o.EnvelopeRevision < 0 || o.TargetRevision < 0 || o.MCPBindingRevision < 0 || o.ID == "" || o.Tool == "" || o.StoreID == "" || o.RecoveryEpoch == "" || o.SessionID == "" || o.TaskID == "" || o.GoalID == "" || o.StepID == "" || o.AttemptID == "" || o.RootTurnID == "" || o.CallID == "" || o.OwnerID == "" || o.OwnerGeneration < 1 || o.ExecutionRevision < 1 || o.GoalRevision < 1 || o.PlanRevision < 1 || o.StepRevision < 1 || o.PolicyRevision < 1 || o.RegistryVersion != RegistryVersion || !isDigest(o.ArgumentsDigest) || !isDigest(o.PreviewDigest) {
		return PreparedOperation{}, errors.New("incomplete prepared operation")
	}
	switch o.Actor {
	case "agent", "child", "workflow", "schedule", "human_action":
	default:
		return PreparedOperation{}, errors.New("invalid operation actor")
	}
	if o.Actor == "child" && o.ChildScopeID == "" {
		return PreparedOperation{}, errors.New("child scope required")
	}
	switch o.TargetKind {
	case TargetResource:
		if len(o.Resources) != 1 {
			return PreparedOperation{}, errors.New("one resource required")
		}
	case TargetResourceSet:
		if len(o.Resources) == 0 {
			return PreparedOperation{}, errors.New("resource set required")
		}
	case TargetProject:
		if o.ProjectID == "" || len(o.Resources) != 0 {
			return PreparedOperation{}, errors.New("project target required")
		}
	case TargetSession, TargetNone:
		if len(o.Resources) != 0 {
			return PreparedOperation{}, errors.New("unexpected resource target")
		}
	default:
		return PreparedOperation{}, errors.New("unknown target kind")
	}
	if len(o.Capabilities) == 0 {
		return PreparedOperation{}, errors.New("capabilities required")
	}
	o.Capabilities = sortedUnique(o.Capabilities)
	o.Scope.ResolvedAddresses = sortedUnique(o.Scope.ResolvedAddresses)
	o.Parents = slices.Clone(o.Parents)
	slices.SortFunc(o.Parents, func(a, b ParentBinding) int { return strings.Compare(a.TaskID, b.TaskID) })
	for i, p := range o.Parents {
		if p.TaskID == "" || p.ScopeID != "" && (p.OwnerBindingID == "" || p.OwnerGeneration < 1) || p.ExecutionRevision < 1 || !isDigest(p.RoleDigest) || i > 0 && p.TaskID == o.Parents[i-1].TaskID || p.BoundaryID != "" && p.BoundaryRevision < 1 || p.AuthorityID != "" && p.AuthorityRevision < 1 {
			return PreparedOperation{}, errors.New("invalid parent binding")
		}
	}
	for _, c := range o.Capabilities {
		if !KnownCapability(c) {
			return PreparedOperation{}, errors.New("unknown capability")
		}
	}
	o.Resources = slices.Clone(o.Resources)
	slices.SortFunc(o.Resources, func(a, b ResourceRevision) int { return strings.Compare(a.ID, b.ID) })
	for i, r := range o.Resources {
		if r.ID == "" || r.ConnectionRevision < 1 || !isDigest(r.ConnectionDigest) || r.State != "ready" || i > 0 && r.ID == o.Resources[i-1].ID {
			return PreparedOperation{}, errors.New("invalid resource revision")
		}
	}
	var err error
	if o.BoundaryRevisions, err = canonicalRevisions(o.BoundaryRevisions); err != nil {
		return PreparedOperation{}, err
	}
	if o.GrantRevisions, err = canonicalRevisions(o.GrantRevisions); err != nil {
		return PreparedOperation{}, err
	}
	o.Credentials = slices.Clone(o.Credentials)
	slices.SortFunc(o.Credentials, func(a, b CredentialRevision) int { return strings.Compare(a.Reference, b.Reference) })
	for i, c := range o.Credentials {
		if c.Reference == "" || c.Revision < 1 || i > 0 && c.Reference == o.Credentials[i-1].Reference {
			return PreparedOperation{}, errors.New("invalid credential revision")
		}
	}
	if o.Proof != ProofStructured && o.Proof != ProofCommandProfile && o.Proof != ProofOpaque {
		return PreparedOperation{}, errors.New("unknown effect proof")
	}
	if o.Proof == ProofCommandProfile && (o.CommandProfileID == "" || o.CommandProfileVersion < 1 || !isDigest(o.CommandArgumentsDigest)) {
		return PreparedOperation{}, errors.New("command profile binding required")
	}
	if o.Proof == ProofCommandProfile && strings.HasPrefix(o.CommandProfileID, "service_") && o.ServiceID == "" {
		return PreparedOperation{}, errors.New("service identity required")
	}
	if o.MCPServerID != "" && (o.MCPConfigRevision < 1 || o.MCPBindingRevision < 1 || o.MCPCatalogRevision < 0) {
		return PreparedOperation{}, errors.New("MCP configuration and project binding revisions required")
	}
	if o.Tool == "call_mcp_tool" && (o.MCPServerID == "" || o.MCPToolName == "" || o.MCPConfigRevision < 1 || o.MCPCatalogRevision < 1) {
		return PreparedOperation{}, errors.New("MCP server/tool revisions required")
	}
	return o, nil
}

func canonicalRevisions(in []RevisionRef) ([]RevisionRef, error) {
	out := slices.Clone(in)
	slices.SortFunc(out, func(a, b RevisionRef) int { return strings.Compare(a.ID, b.ID) })
	for i, r := range out {
		if r.ID == "" || r.Revision < 1 || i > 0 && r.ID == out[i-1].ID {
			return nil, errors.New("invalid authority revision")
		}
	}
	return out, nil
}

func OperationDigest(in PreparedOperation) (string, error) {
	o, err := CanonicalOperation(in)
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte("lake-prepared-operation/v1\x00"), raw...))
	return hex.EncodeToString(sum[:]), nil
}

func ContentDigest(in []byte) string { sum := sha256.Sum256(in); return hex.EncodeToString(sum[:]) }

func isDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && s == strings.ToLower(s)
}

func FreezeParentBindings(parents []ParentRestriction) []ParentBinding {
	bindings := make([]ParentBinding, 0, len(parents))
	for _, parent := range parents {
		roles, _ := json.Marshal(sortedUnique(parent.RoleCapabilities))
		binding := ParentBinding{ScopeID: parent.ScopeID, OwnerBindingID: parent.OwnerBindingID, OwnerGeneration: parent.OwnerGeneration, TaskID: parent.Task.ID, ExecutionRevision: parent.Task.ExecutionRevision, AuthorityID: parent.AuthorityID, AuthorityRevision: parent.AuthorityRevision, RoleDigest: ContentDigest(roles)}
		if parent.Boundary != nil {
			binding.BoundaryID, binding.BoundaryRevision = parent.Boundary.ID, parent.Boundary.Revision
		}
		bindings = append(bindings, binding)
	}
	slices.SortFunc(bindings, func(a, b ParentBinding) int { return strings.Compare(a.TaskID, b.TaskID) })
	return bindings
}

func sortedUnique(in []string) []string {
	out := slices.Clone(in)
	slices.Sort(out)
	return slices.Compact(out)
}
