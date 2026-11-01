package security

import (
	"net/netip"
	"path"
	"slices"
	"strings"
	"time"
)

// Evaluate performs no I/O and never consumes authority. AcquirePermit must
// call it again using a transactionally current snapshot before dispatch.
func Evaluate(in EvaluationInput) Decision {
	o, err := CanonicalOperation(in.Operation)
	d := Decision{Effect: EffectDeny, ReasonCode: ReasonInvalidOperation, OperationID: in.Operation.ID}
	if err != nil || in.Now.IsZero() {
		return d
	}
	d.DescriptorDigest, _ = OperationDigest(o)
	deny := func(reason ReasonCode) Decision {
		d.Effect, d.ReasonCode = EffectDeny, reason
		d.Authorities = nil
		return d
	}
	ask := func(reason ReasonCode) Decision {
		d.Effect, d.ReasonCode = EffectApprovalRequired, reason
		d.Authorities = nil
		d.RequiredCapabilities = slices.Clone(o.Capabilities)
		return d
	}
	spec, registered := LookupTool(o.Tool)
	if !registered {
		return deny(ReasonUnregisteredTool)
	}
	if spec.TargetKind != o.TargetKind || !containsAll(o.Capabilities, spec.Capabilities) {
		return deny(ReasonInvalidOperation)
	}
	if o.Proof != spec.Proof && o.Proof != ProofOpaque && !(spec.CommandProfileAllowed && o.Proof == ProofCommandProfile) {
		return deny(ReasonUnverifiableEffect)
	}
	if o.Proof == ProofCommandProfile {
		capability := "command.diagnostics"
		if o.CommandProfileID == "service_restart" {
			capability = "service.restart"
		}
		if !knownProfile(o.CommandProfileID, o.CommandProfileVersion) || !slices.Contains(o.Capabilities, capability) {
			return deny(ReasonUnverifiableEffect)
		}
	}
	if !in.GateOpen || o.StoreID != in.StoreID || o.RecoveryEpoch != in.RecoveryEpoch {
		return deny(ReasonRecoveryRequired)
	}
	t := in.Task
	if t.Validate(in.Now) != nil || t.State.Terminal() {
		return deny(ReasonTaskEnded)
	}
	if t.State != TaskActive {
		return deny(ReasonTaskNotActive)
	}
	if t.ID != o.TaskID || t.GoalID != o.GoalID || t.SessionID != o.SessionID || t.ProjectID != o.ProjectID || t.StoreID != o.StoreID || t.RecoveryEpoch != o.RecoveryEpoch || t.ExecutionRevision != o.ExecutionRevision {
		return deny(ReasonOperationStale)
	}
	if !in.GoalReady {
		return deny(ReasonStepNotReady)
	}
	if !in.RootTurnCurrent || o.ChildScopeID != "" && !in.ChildScopeCurrent || in.Cancelled {
		return deny(ReasonOperationStale)
	}
	if in.Owner.ID != o.OwnerID || in.Owner.Generation != o.OwnerGeneration || !in.Now.Before(in.Owner.LeaseUntil) {
		return deny(ReasonOrphanedExecution)
	}
	if in.UnresolvedEffects {
		return deny(ReasonSideEffectUnresolved)
	}
	p := in.Policy
	if !validPolicy(p) || !p.Confirmed || p.ProjectID != o.ProjectID || p.StoreID != o.StoreID || p.RecoveryEpoch != o.RecoveryEpoch {
		return deny(ReasonRecoveryRequired)
	}
	if o.CommandTargetRevision != in.CommandTargetRevision || p.Revision != o.PolicyRevision || o.LegacyPolicyRevision != in.LegacyPolicyRevision || in.TargetRevision != o.TargetRevision {
		return deny(ReasonOperationStale)
	}
	if o.LocalExecution != in.LocalExecution {
		return deny(ReasonOperationStale)
	}
	if o.LocalExecution && (p.DenyLocal || !slices.Contains(o.Capabilities, "local.execute")) {
		return deny(ReasonLocalExecutionDenied)
	}
	if !sameResources(o.Resources, in.Resources) {
		return deny(ReasonOperationStale)
	}
	if o.TerminalGeneration != in.TerminalGeneration || o.TerminalContextRevision != in.TerminalContextRevision || o.MCPServerID != in.MCPServerID || o.MCPToolName != in.MCPToolName || o.MCPBindingRevision != in.MCPBindingRevision || o.MCPConfigRevision != in.MCPConfigRevision || o.MCPCatalogRevision != in.MCPCatalogRevision || !sameCredentials(o.Credentials, in.CredentialRevisions) {
		return deny(ReasonOperationStale)
	}
	if !sameBoundaryRevisions(o.BoundaryRevisions, in.Boundaries) {
		return deny(ReasonOperationStale)
	}
	for _, r := range o.Resources {
		if !slices.Contains(p.ResourceIDs, r.ID) {
			return deny(ReasonTargetOutsideBoundary)
		}
		if r.Local && (p.DenyLocal || !slices.Contains(o.Capabilities, "local.execute")) {
			return deny(ReasonLocalExecutionDenied)
		}
	}
	for _, b := range in.Boundaries {
		if !withinBoundary(o, b) {
			return deny(ReasonTargetOutsideBoundary)
		}
	}
	if in.RoleCapabilities != nil && !containsAll(in.RoleCapabilities, o.Capabilities) {
		return deny(ReasonCapabilityDenied)
	}
	if o.Actor == "child" && len(in.Parents) == 0 {
		return deny(ReasonGoalBindingRequired)
	}
	if !slices.Equal(o.Parents, FreezeParentBindings(in.Parents)) {
		return deny(ReasonOperationStale)
	}
	parentID := t.ParentTaskID
	for _, parent := range in.Parents {
		pt := parent.Task
		sharedScope := parent.SharedTaskScope && o.Actor == "child" && parent.ScopeID == o.ChildScopeID && parent.ScopeID != "" && pt.ID == t.ID && parent.OwnerBindingID != "" && parent.OwnerGeneration > 0
		if (!sharedScope && (parentID == "" || pt.ID != parentID)) || pt.Validate(in.Now) != nil || pt.State != TaskActive || pt.GoalID != o.GoalID || pt.ProjectID != o.ProjectID || pt.SessionID != o.SessionID || pt.StoreID != o.StoreID || pt.RecoveryEpoch != o.RecoveryEpoch || !parent.AuthorityValid || !containsAll(parent.RoleCapabilities, o.Capabilities) {
			return deny(ReasonCapabilityDenied)
		}
		if parent.Boundary != nil && !withinBoundary(o, *parent.Boundary) {
			return deny(ReasonTargetOutsideBoundary)
		}
		if !sharedScope {
			parentID = pt.ParentTaskID
		}
	}
	if parentID != "" {
		return deny(ReasonGoalBindingRequired)
	}
	if o.Proof == ProofOpaque && p.Mode == "restricted" {
		return deny(ReasonUnverifiableEffect)
	}
	resourceIDs := []string{""}
	if len(o.Resources) > 0 {
		resourceIDs = make([]string, 0, len(o.Resources))
		for _, r := range o.Resources {
			resourceIDs = append(resourceIDs, r.ID)
		}
	}
	// Project and proof ceilings are hard restrictions. Do not offer a task
	// scope exception for an operation that is forbidden by those ceilings.
	for _, capability := range o.Capabilities {
		for _, resourceID := range resourceIDs {
			rule, matched := resolveRule(p.Rules, capability, resourceID)
			if !matched || rule.Effect == EffectDeny {
				return deny(ReasonCapabilityDenied)
			}
			if !ruleLimitsAllow(o.Scope, rule, capability) {
				return deny(ReasonTargetOutsideBoundary)
			}
			if o.Proof == ProofOpaque && p.Mode == "compatible" && rule.Effect == EffectAsk && rule.Confirmation == ConfirmTask {
				return deny(ReasonUnverifiableEffect)
			}
		}
	}
	approval := matchingApproval(in, o, d.DescriptorDigest)
	if o.RequireSingleConfirmation {
		if approval == nil {
			return ask(ReasonApprovalRequired)
		}
		d.Authorities = append(d.Authorities, AuthoritySource{Kind: "single_approval", ID: approval.ID})
	}
	if in.Envelope == nil && o.EnvelopeRevision != 0 || in.Envelope != nil && in.Envelope.Revision != o.EnvelopeRevision {
		return deny(ReasonOperationStale)
	}
	if in.Envelope != nil && !withinEnvelope(o, *in.Envelope) {
		if approval == nil || !approval.EnvelopeException {
			return ask(ReasonTaskScopeExtensionRequired)
		}
		d.Authorities = append(d.Authorities, AuthoritySource{Kind: "single_approval", ID: approval.ID})
	}
	missing := false
	for _, capability := range o.Capabilities {
		for _, resourceID := range resourceIDs {
			rule, matched := resolveRule(p.Rules, capability, resourceID)
			if !matched || rule.Effect == EffectDeny {
				return deny(ReasonCapabilityDenied)
			}
			if !ruleLimitsAllow(o.Scope, rule, capability) {
				return deny(ReasonTargetOutsideBoundary)
			}
			if o.Proof == ProofOpaque && p.Mode == "compatible" {
				if rule.Effect == EffectAsk && rule.Confirmation == ConfirmTask {
					return deny(ReasonUnverifiableEffect)
				}
				rule.Effect, rule.Grantable, rule.Confirmation = EffectAsk, false, ConfirmSingle
			}
			if rule.Effect == EffectAllow {
				d.Authorities = append(d.Authorities, AuthoritySource{Capability: capability, ResourceID: resourceID, Kind: "project", ID: p.ProjectID, Revision: p.Revision})
				continue
			}
			if rule.Effect != EffectAsk {
				return deny(ReasonCapabilityDenied)
			}
			if rule.Grantable && (rule.Confirmation == ConfirmTask || rule.Confirmation == ConfirmEither) && TaskGrantable(capability, o.Proof) {
				if grant := matchingGrant(in, o, capability, resourceID); grant != nil {
					d.Authorities = append(d.Authorities, AuthoritySource{Capability: capability, ResourceID: resourceID, Kind: "task_grant", ID: grant.ID, Revision: grant.Revision})
					continue
				}
			}
			if approval != nil && (rule.Confirmation == ConfirmSingle || rule.Confirmation == ConfirmEither) {
				d.Authorities = append(d.Authorities, AuthoritySource{Capability: capability, ResourceID: resourceID, Kind: "single_approval", ID: approval.ID})
				continue
			}
			missing = true
		}
	}
	if missing {
		return ask(ReasonApprovalRequired)
	}
	// A confirmed task budget is independent of capability authority. Project
	// allow and exact approvals cannot silently bypass an explicit use limit.
	if in.Envelope != nil && withinEnvelope(o, *in.Envelope) && len(in.Envelope.BudgetGrantIDs) > 0 && !pureTaskControl(o) {
		budgetInput := in
		budgetInput.Grants = nil
		for _, grant := range in.Grants {
			if slices.Contains(in.Envelope.BudgetGrantIDs, grant.ID) {
				budgetInput.Grants = append(budgetInput.Grants, grant)
			}
		}
		for _, capability := range o.Capabilities {
			for _, resourceID := range resourceIDs {
				grant := matchingGrant(budgetInput, o, capability, resourceID)
				if grant == nil {
					return ask(ReasonTaskScopeExtensionRequired)
				}
				d.Authorities = append(d.Authorities, AuthoritySource{Capability: capability, ResourceID: resourceID, Kind: "task_budget", ID: grant.ID, Revision: grant.Revision})
			}
		}
	}
	d.Effect, d.ReasonCode = EffectAllow, ReasonAllowed
	return d
}

func validPolicy(p ProjectPolicy) bool {
	if p.SchemaVersion != 1 || p.Revision < 1 || p.StoreID == "" || p.RecoveryEpoch == "" {
		return false
	}
	if p.Mode != "restricted" && p.Mode != "compatible" && p.Mode != "legacy" {
		return false
	}
	for _, r := range p.Rules {
		if !KnownCapability(r.Capability) || r.Effect != EffectAllow && r.Effect != EffectAsk && r.Effect != EffectDeny {
			return false
		}
		if r.Effect == EffectAsk && r.Confirmation != ConfirmSingle && r.Confirmation != ConfirmTask && r.Confirmation != ConfirmEither {
			return false
		}
	}
	return true
}

func resolveRule(rules []Rule, capability, resourceID string) (Rule, bool) {
	var selected Rule
	found, width := false, 0
	for _, r := range rules {
		if r.Capability != capability || len(r.ResourceIDs) > 0 && !slices.Contains(r.ResourceIDs, resourceID) {
			continue
		}
		if r.Effect == EffectDeny {
			return r, true
		}
		w := len(r.ResourceIDs)
		if w == 0 {
			w = int(^uint(0) >> 1)
		}
		if !found || w < width || w == width && r.Effect == EffectAsk && selected.Effect == EffectAllow {
			selected, found, width = r, true, w
		} else if w == width && r.Effect == EffectAsk && selected.Effect == EffectAsk {
			// Equally specific asks must satisfy both restrictions.
			selected.Grantable = selected.Grantable && r.Grantable
			if selected.Confirmation == ConfirmEither {
				selected.Confirmation = r.Confirmation
			} else if r.Confirmation != ConfirmEither && r.Confirmation != selected.Confirmation {
				return Rule{Effect: EffectDeny}, true
			}
		}
	}
	if found {
		selected.matchingLimits = nil
		for _, r := range rules {
			if r.Capability != capability || len(r.ResourceIDs) > 0 && !slices.Contains(r.ResourceIDs, resourceID) {
				continue
			}
			w := len(r.ResourceIDs)
			if w == 0 {
				w = int(^uint(0) >> 1)
			}
			if w == width {
				selected.matchingLimits = append(selected.matchingLimits, r.Limits)
			}
		}
	}
	return selected, found
}

func ResolveCapabilityRule(rules []Rule, capability, resourceID string) (Rule, bool) {
	return resolveRule(rules, capability, resourceID)
}

func ruleLimitsAllow(scope OperationScope, rule Rule, capability string) bool {
	if !withinLimits(scope, rule.Limits, capability) {
		return false
	}
	for _, limits := range rule.matchingLimits {
		if !withinLimits(scope, limits, capability) {
			return false
		}
	}
	return true
}

func GrantLimitsFitRule(proposed ScopeLimits, rule Rule, capability string) bool {
	if !LimitsSubset(proposed, rule.Limits, capability) {
		return false
	}
	for _, limits := range rule.matchingLimits {
		if !LimitsSubset(proposed, limits, capability) {
			return false
		}
	}
	return true
}

func matchingApproval(in EvaluationInput, o PreparedOperation, digest string) *SingleApproval {
	for i := range in.Approvals {
		a := &in.Approvals[i]
		if a.ID != "" && a.Authorized && !a.Consumed && !a.CreatedAt.IsZero() && !a.CreatedAt.After(in.Now) && a.ExpiresAt.After(a.CreatedAt) && a.ExpiresAt.Sub(a.CreatedAt) <= 15*time.Minute && in.Now.Before(a.ExpiresAt) && !a.ExpiresAt.After(in.Task.ExpiresAt) && a.StoreID == o.StoreID && a.RecoveryEpoch == o.RecoveryEpoch && a.TaskID == o.TaskID && a.ExecutionRevision == o.ExecutionRevision && a.SessionID == o.SessionID && a.RootTurnID == o.RootTurnID && a.ChildScopeID == o.ChildScopeID && a.DescriptorDigest == digest {
			return a
		}
	}
	return nil
}

func matchingGrant(in EvaluationInput, o PreparedOperation, capability, resourceID string) *TaskGrant {
	for i := range in.Grants {
		g := &in.Grants[i]
		if g.ID == "" || g.Revision < 1 || g.Revoked || g.RemainingUses < 1 || g.RemainingUses > 10000 || g.CreatedAt.IsZero() || g.CreatedAt.After(in.Now) || !g.ExpiresAt.After(g.CreatedAt) || g.ExpiresAt.Sub(g.CreatedAt) > 4*time.Hour || !in.Now.Before(g.ExpiresAt) || g.StoreID != o.StoreID || g.RecoveryEpoch != o.RecoveryEpoch || g.GoalID != o.GoalID || g.ProjectID != o.ProjectID || g.SessionID != o.SessionID || !slices.Contains(g.Capabilities, capability) || !revisionMatches(o.GrantRevisions, g.ID, g.Revision) {
			continue
		}
		if o.Actor == "child" && !slices.Contains(g.AllowedChildScopes, o.ChildScopeID) {
			continue
		}
		if g.TaskID != o.TaskID && (!slices.Contains(g.AllowedChildScopes, o.ChildScopeID) || o.ChildScopeID == "" || !parentContains(in.Parents, g.TaskID)) {
			continue
		}
		issuerDeadline := in.Task.ExpiresAt
		for _, p := range in.Parents {
			if p.Task.ID == g.TaskID {
				issuerDeadline = p.Task.ExpiresAt
			}
		}
		if g.ExpiresAt.After(issuerDeadline) {
			continue
		}
		if g.ParentAuthorityID != "" && !g.ParentAuthorityValid {
			continue
		}
		if resourceID != "" {
			found := false
			for _, r := range o.Resources {
				if r.ID == resourceID {
					for _, allowed := range g.Resources {
						if r == allowed {
							found = true
						}
					}
				}
			}
			if !found {
				continue
			}
		}
		if o.Proof == ProofCommandProfile && (!profileMatches(g.CommandProfiles, o) || !revisionMatches(g.CommandTargetRevisions, resourceID, o.CommandTargetRevision)) {
			continue
		}
		if o.ServiceID != "" && !slices.Contains(g.ServiceIDs, o.ServiceID) {
			continue
		}
		if !withinLimits(o.Scope, g.Limits, capability) {
			continue
		}
		return g
	}
	return nil
}

func parentContains(parents []ParentRestriction, id string) bool {
	for _, p := range parents {
		if p.Task.ID == id {
			return true
		}
	}
	return false
}
func revisionMatches(refs []RevisionRef, id string, revision int64) bool {
	for _, r := range refs {
		if r.ID == id && r.Revision == revision {
			return true
		}
	}
	return false
}
func containsAll(have, need []string) bool {
	for _, x := range need {
		if !slices.Contains(have, x) {
			return false
		}
	}
	return true
}
func withinBoundary(o PreparedOperation, b ExecutionBoundary) bool {
	if o.LocalExecution && b.DenyLocal {
		return false
	}
	for _, r := range o.Resources {
		if !b.Contains(r.ID) || b.DenyLocal && r.Local {
			return false
		}
	}
	return true
}
func sameResources(a, b []ResourceRevision) bool {
	if len(a) != len(b) {
		return false
	}
	for _, r := range a {
		count := 0
		for _, current := range b {
			if r == current {
				count++
			}
		}
		if count != 1 {
			return false
		}
	}
	return true
}
func sameBoundaryRevisions(refs []RevisionRef, boundaries []ExecutionBoundary) bool {
	if len(refs) != len(boundaries) {
		return false
	}
	for _, b := range boundaries {
		if !revisionMatches(refs, b.ID, b.Revision) {
			return false
		}
	}
	return true
}

func sameCredentials(a, b []CredentialRevision) bool {
	if len(a) != len(b) {
		return false
	}
	for _, reference := range a {
		count := 0
		for _, current := range b {
			if current == reference {
				count++
			}
		}
		if count != 1 {
			return false
		}
	}
	return true
}
func profileMatches(profiles []CommandProfileScope, o PreparedOperation) bool {
	for _, p := range profiles {
		if p.ID == o.CommandProfileID && p.Version == o.CommandProfileVersion && p.ArgumentsDigest == o.CommandArgumentsDigest {
			return true
		}
	}
	return false
}

// PureTaskControl recognizes registered local controls without resource I/O.
func PureTaskControl(o PreparedOperation) bool { return pureTaskControl(o) }

func pureTaskControl(o PreparedOperation) bool {
	if o.Proof != ProofStructured || len(o.Resources) != 0 || o.MCPServerID != "" || o.TerminalID != "" || o.CommandProfileID != "" || o.LocalExecution || o.TargetKind != TargetSession && o.TargetKind != TargetNone && o.TargetKind != TargetProject {
		return false
	}
	spec, ok := LookupTool(o.Tool)
	if !ok || spec.Proof != ProofStructured || spec.TargetKind != o.TargetKind || !containsAll(o.Capabilities, spec.Capabilities) {
		return false
	}
	for _, capability := range o.Capabilities {
		switch capability {
		case "task.read", "task.control", "resource.list", "resource.resolve", "session.read":
		default:
			return false
		}
	}
	return len(o.Capabilities) > 0
}

func withinEnvelope(o PreparedOperation, e TaskEnvelope) bool {
	if pureTaskControl(o) {
		return e.Revision > 0
	}

	// An opaque call cannot prove that its secondary effects fit a confirmed
	// task scope, even when its legacy project rule permits raw Shell.
	if o.Proof == ProofOpaque {
		return false
	}
	if e.Revision < 1 || !containsAll(e.Capabilities, o.Capabilities) {
		return false
	}
	for _, r := range o.Resources {
		if !slices.Contains(e.ResourceIDs, r.ID) {
			return false
		}
		matched := false
		for _, frozen := range e.Resources {
			if frozen == r {
				matched = true
			}
		}
		if !matched {
			return false
		}
	}
	if o.Proof == ProofCommandProfile && (!profileMatches(e.CommandProfiles, o) || len(o.Resources) != 1 || !revisionMatches(e.CommandTargetRevisions, o.Resources[0].ID, o.CommandTargetRevision)) {
		return false
	}
	if o.Proof != ProofOpaque {
		for _, capability := range o.Capabilities {
			if !withinLimits(o.Scope, e.Limits, capability) {
				return false
			}
		}
	}
	return o.ServiceID == "" || slices.Contains(e.ServiceIDs, o.ServiceID)
}
func knownProfile(id string, version int64) bool {
	if version != CommandProfileVersion {
		return false
	}
	switch id {
	case "disk_usage", "process_snapshot", "service_status", "service_logs", "service_restart":
		return true
	}
	return false
}

func withinLimits(s OperationScope, limits ScopeLimits, capability string) bool {
	switch capability {
	case "file.read", "file.write", "file.delete":
		file, valid := normalizeScopePath(s.FilePath)
		if !valid {
			return false
		}
		inside := false
		for _, root := range limits.FileRoots {
			canonical, valid := normalizeScopePath(root)
			if !valid {
				continue
			}
			if file == canonical || strings.HasPrefix(file, strings.TrimSuffix(canonical, "/")+"/") {
				inside = true
			}
		}
		if !inside {
			return false
		}
		return capability == "file.read" || isDigest(s.ExpectedContentHash)
	case "db.read", "db.write":
		return s.DatabaseID != "" && s.DatabaseID == limits.DatabaseID && s.Schema != "" && slices.Contains(limits.Schemas, s.Schema) && s.MaxRows > 0 && limits.MaxRows > 0 && s.MaxRows <= limits.MaxRows && s.MaxDurationMS > 0 && limits.MaxDurationMS > 0 && s.MaxDurationMS <= limits.MaxDurationMS
	case "cluster.read", "cluster.write", "cluster.logs":
		if s.ClusterID == "" || s.ClusterID != limits.ClusterID || s.Namespace == "" || !slices.Contains(limits.Namespaces, s.Namespace) || s.ResourceKind == "" || !slices.Contains(limits.ResourceKinds, s.ResourceKind) || s.Verb == "" || !slices.Contains(limits.Verbs, s.Verb) {
			return false
		}
		if capability == "cluster.logs" {
			return s.LogLines > 0 && limits.MaxLogLines > 0 && s.LogLines <= limits.MaxLogLines && s.LogSeconds > 0 && limits.MaxLogSeconds > 0 && s.LogSeconds <= limits.MaxLogSeconds
		}
	case "network.fetch":
		if len(s.ResolvedAddresses) == 0 {
			return false
		}
		for _, target := range limits.NetworkTargets {
			if target.Scheme != s.NetworkScheme || target.Host != s.NetworkHost || target.Port != s.NetworkPort || target.Port < 1 || target.Port > 65535 || target.Scheme != "http" && target.Scheme != "https" {
				continue
			}
			all := true
			for _, address := range s.ResolvedAddresses {
				ip, err := netip.ParseAddr(address)
				if err != nil {
					all = false
					break
				}
				allowed := false
				for _, cidr := range target.AddressCIDRs {
					if prefix, err := netip.ParsePrefix(cidr); err == nil && prefix.Contains(ip) {
						allowed = true
					}
				}
				if !allowed {
					all = false
					break
				}
			}
			if all {
				return true
			}
		}
		return false
	}
	return true
}

// Resource paths use their own path syntax, not the operating system running
// Lake. This supports canonical POSIX and Windows drive paths; UNC/device paths
// require a dedicated adapter and are conservatively refused here. I/O adapters
// must still resolve symlinks/aliases and enforce secret exclusions themselves.
func normalizeScopePath(raw string) (string, bool) {
	if strings.ContainsRune(raw, '\x00') {
		return "", false
	}
	if strings.HasPrefix(raw, "/") && !strings.Contains(raw, "\\") && path.Clean(raw) == raw {
		return raw, true
	}
	if len(raw) < 3 || raw[1] != ':' || raw[0] < 'A' || raw[0] > 'Z' && raw[0] < 'a' || raw[0] > 'z' {
		return "", false
	}
	normalized := strings.ReplaceAll(raw, "\\", "/")
	if normalized[2] != '/' || path.Clean(normalized[2:]) != normalized[2:] {
		return "", false
	}
	return strings.ToLower(normalized[:1]) + normalized[1:], true
}

// LimitsSubset validates a proposed grant against the current policy ceiling.
// Unknown or absent required limits never mean unrestricted access.
func LimitsSubset(proposed, ceiling ScopeLimits, capability string) bool {
	switch capability {
	case "file.read", "file.write", "file.delete":
		if len(proposed.FileRoots) == 0 {
			return false
		}
		for _, root := range proposed.FileRoots {
			if !withinLimits(OperationScope{FilePath: root, ExpectedContentHash: ContentDigest(nil)}, ceiling, capability) {
				return false
			}
		}
	case "db.read", "db.write":
		if len(proposed.Schemas) == 0 {
			return false
		}
		for _, schema := range proposed.Schemas {
			if !withinLimits(OperationScope{DatabaseID: proposed.DatabaseID, Schema: schema, MaxRows: proposed.MaxRows, MaxDurationMS: proposed.MaxDurationMS}, ceiling, capability) {
				return false
			}
		}
	case "cluster.read", "cluster.write", "cluster.logs":
		if proposed.ClusterID == "" || proposed.ClusterID != ceiling.ClusterID || len(proposed.Namespaces) == 0 || len(proposed.ResourceKinds) == 0 || len(proposed.Verbs) == 0 || !containsAll(ceiling.Namespaces, proposed.Namespaces) || !containsAll(ceiling.ResourceKinds, proposed.ResourceKinds) || !containsAll(ceiling.Verbs, proposed.Verbs) {
			return false
		}
		if capability == "cluster.logs" && (proposed.MaxLogLines < 1 || proposed.MaxLogLines > ceiling.MaxLogLines || proposed.MaxLogSeconds < 1 || proposed.MaxLogSeconds > ceiling.MaxLogSeconds) {
			return false
		}
	case "network.fetch":
		if len(proposed.NetworkTargets) == 0 {
			return false
		}
		for _, target := range proposed.NetworkTargets {
			matched := false
			for _, outer := range ceiling.NetworkTargets {
				if target.Scheme != outer.Scheme || target.Host != outer.Host || target.Port != outer.Port || len(target.AddressCIDRs) == 0 {
					continue
				}
				all := true
				for _, cidr := range target.AddressCIDRs {
					p, err := netip.ParsePrefix(cidr)
					if err != nil {
						all = false
						break
					}
					contained := false
					for _, allowed := range outer.AddressCIDRs {
						q, err := netip.ParsePrefix(allowed)
						if err == nil && p.Bits() >= q.Bits() && q.Contains(p.Addr()) {
							contained = true
						}
					}
					if !contained {
						all = false
						break
					}
				}
				if all {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		}
	}
	return true
}

// GrantWithinEnvelope is used for issuing an additional grant without silently
// expanding the task's previously confirmed execution scope. A scope expansion
// requires a separate, explicit CAS action, not a new implicit grant.
func GrantWithinEnvelope(grant TaskGrant, envelope TaskEnvelope) bool {
	if !containsAll(envelope.Capabilities, grant.Capabilities) || !containsAll(envelope.ServiceIDs, grant.ServiceIDs) {
		return false
	}
	for _, r := range grant.Resources {
		if !slices.Contains(envelope.ResourceIDs, r.ID) {
			return false
		}
		matched := false
		for _, frozen := range envelope.Resources {
			if frozen == r {
				matched = true
			}
		}
		if !matched {
			return false
		}
	}
	for _, ref := range grant.CommandTargetRevisions {
		if !revisionMatches(envelope.CommandTargetRevisions, ref.ID, ref.Revision) {
			return false
		}
	}
	for _, p := range grant.CommandProfiles {
		if !slices.Contains(envelope.CommandProfiles, p) {
			return false
		}
	}
	for _, c := range grant.Capabilities {
		if !LimitsSubset(grant.Limits, envelope.Limits, c) {
			return false
		}
	}
	return true
}
