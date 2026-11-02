package ai

import (
	"errors"
	"slices"
)

// LegacyWorkAlias identifies the original ledger, not a new execution right.
type LegacyWorkAlias struct {
	Kind        string `json:"kind"`
	LegacyID    string `json:"legacyId"`
	SessionID   string `json:"sessionId"`
	ProjectID   string `json:"projectId,omitempty"`
	CanonicalID string `json:"canonicalId,omitempty"`
}

type LegacyWorkImport struct {
	Alias        LegacyWorkAlias `json:"alias"`
	ReadOnly     bool            `json:"readOnly"`
	CanAdopt     bool            `json:"canAdopt"`
	Reasons      []string        `json:"reasons"`
	RootTurnID   string          `json:"rootTurnId,omitempty"`
	Checkpoint   string          `json:"checkpoint,omitempty"`
	WaitCallID   string          `json:"waitCallId,omitempty"`
	OperationIDs []string        `json:"operationIds,omitempty"`
	ApprovalIDs  []string        `json:"approvalIds,omitempty"`
	EvidenceIDs  []string        `json:"evidenceIds,omitempty"`
}

// PlanLegacyWorkImport never writes, dispatches, or manufactures acceptance.
// SRE imports remain read-only until their goal and original operations have
// been reconciled by the host; "verified" in legacy text is not a closure pass.
func PlanLegacyWorkImport(goal *WorkGoal, sre *SRETask, closure GoalClosureView) (LegacyWorkImport, error) {
	out := LegacyWorkImport{ReadOnly: true, Reasons: []string{}}
	if (goal == nil) == (sre == nil) {
		return out, errors.New("superagent: exactly one legacy source required")
	}
	if goal != nil {
		if goal.ID == "" || goal.SessionID == "" || closure.GoalID != goal.ID {
			return out, errSuperBinding
		}
		out.Alias = LegacyWorkAlias{Kind: "work", LegacyID: goal.ID, SessionID: goal.SessionID, CanonicalID: goal.ID}
		out.RootTurnID = goal.OriginRootTurnID
		if goal.closure != nil {
			out.Alias.ProjectID = goal.closure.ProjectID
		}
		if out.RootTurnID == "" {
			out.Reasons = append(out.Reasons, "missing_origin_root")
		}
		if workTerminal(goal.Status) {
			out.Reasons = append(out.Reasons, "historical_terminal")
		}
		if closure.UnresolvedOperations > 0 {
			out.Reasons = append(out.Reasons, "unresolved_operations")
		}
		if closure.UncoveredAttempts > 0 {
			out.Reasons = append(out.Reasons, "uncovered_attempts")
		}
		if !closure.Managed {
			out.Reasons = append(out.Reasons, "unmanaged_legacy_work")
		}
		out.CanAdopt = len(out.Reasons) == 0
	} else {
		if sre.ID == "" || sre.SessionID == "" || sre.ProjectID == "" {
			return out, errSuperBinding
		}
		out.Alias = LegacyWorkAlias{Kind: "sre", LegacyID: sre.ID, SessionID: sre.SessionID, ProjectID: sre.ProjectID}
		out.RootTurnID = sre.RequestID
		out.Reasons = append(out.Reasons, "canonical_goal_mapping_required", "acceptance_reconciliation_required")
		for _, attempt := range sre.Attempts {
			for _, op := range attempt.Operations {
				if op.ID != "" {
					out.OperationIDs = append(out.OperationIDs, op.ID)
				}
				if op.ApprovalID != "" {
					out.ApprovalIDs = append(out.ApprovalIDs, op.ApprovalID)
				}
				out.EvidenceIDs = append(out.EvidenceIDs, op.EvidenceIDs...)
				switch op.Status {
				case "succeeded", "failed", "not_executed", "cancelled":
				default:
					out.Reasons = append(out.Reasons, "unresolved_operations")
				}
			}
			for _, evidence := range attempt.Evidence {
				out.EvidenceIDs = append(out.EvidenceIDs, evidence.ID)
			}
		}
	}
	for _, values := range []*[]string{&out.Reasons, &out.OperationIDs, &out.ApprovalIDs, &out.EvidenceIDs} {
		slices.Sort(*values)
		*values = slices.Compact(*values)
	}
	return out, nil
}
