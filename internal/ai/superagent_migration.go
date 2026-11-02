package ai

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"
)

// LegacyWorkAlias identifies the original ledger, not a new execution right.
type LegacyWorkAlias struct {
	Kind        string `json:"kind"`
	LegacyID    string `json:"legacyId"`
	SessionID   string `json:"sessionId"`
	ProjectID   string `json:"projectId,omitempty"`
	CanonicalID string `json:"canonicalId,omitempty"`
}

const superArchiveGoalPrefix = "legacy_sre_archive_"

func isSuperArchiveGoal(id string) bool { return strings.HasPrefix(id, superArchiveGoalPrefix) }

// ApplyLegacyWorkImport reads the actual repositories under the old observer
// barrier. It imports identity/references, never approvals or synthetic evidence.
// Missing source/handle authority leaves a read-only archive; a new user request
// cannot silently turn that archive into an executable task.
func (e *Engine) ApplyLegacyWorkImport(ctx context.Context, projectID, sessionID, kind, legacyID string) (LegacyWorkImport, error) {
	var out LegacyWorkImport
	if projectID == "" || sessionID == "" || legacyID == "" {
		return out, errSuperBinding
	}
	s, err := e.get(sessionID)
	if err != nil {
		return out, err
	}
	s.mu.Lock()
	busy := s.cancel != nil || s.finalizing
	c := s.state.Config
	s.mu.Unlock()
	if busy {
		return out, errors.New("superagent: legacy invocation has not drained")
	}
	var sre SRETask
	if kind == "sre" {
		if e.sreRepository == nil {
			return out, errors.New("superagent: legacy SRE repository unavailable")
		}
		sre, err = e.sreRepository.LoadSRETask(sessionID, legacyID)
		if err != nil {
			return out, err
		}
		if sre.ProjectID != projectID || sre.SessionID != sessionID || sre.ID != legacyID {
			return out, errSuperBinding
		}
		if sre.Status == "active" || sre.Status == "waiting_approval" {
			return out, errors.New("superagent: legacy SRE must drain first")
		}
	}
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	e.workTickMu.Lock()
	defer e.workTickMu.Unlock()
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var goal WorkGoal
		var row nativeWorkGoal
		requestHash := ""
		switch kind {
		case "work":
			if err := tx.First(&row, "id = ? AND session_id = ?", legacyID, sessionID).Error; err != nil {
				return err
			}
			if err := decodeWorkGoal(row, &goal); err != nil {
				return err
			}
			var closure GoalClosureView
			if err := readWorkClosureTx(tx, sessionID, legacyID, &closure); err != nil {
				return err
			}
			var err error
			out, err = PlanLegacyWorkImport(&goal, nil, closure)
			if err != nil {
				return err
			}
			if goal.closure != nil && goal.closure.ProjectID != projectID {
				return errSuperBinding
			}
			requestHash = hash(js([]any{row.ID, row.SessionID, row.RootTurnID, row.OriginMessageID}))
		case "sre":
			var err error
			out, err = PlanLegacyWorkImport(nil, &sre, GoalClosureView{})
			if err != nil {
				return err
			}
			requestHash = hash(js([]any{sre.ID, sre.SessionID, sre.ProjectID, sre.RequestID}))
		default:
			return errSuperBinding
		}
		out.Alias.ProjectID = projectID
		var prior superLegacyAliasRow
		lookup := tx.First(&prior, "kind = ? AND legacy_id = ?", kind, legacyID).Error
		if lookup == nil {
			if prior.ProjectID != projectID || prior.SessionID != sessionID || prior.RequestHash != requestHash {
				return errSuperConflict
			}
			out.Alias.CanonicalID = prior.CanonicalID
			out.ReadOnly = prior.ReadOnly
			out.CanAdopt = false
			return nil
		} else if !errors.Is(lookup, gorm.ErrRecordNotFound) {
			return lookup
		}
		if kind == "sre" {
			var bindings []securitySREPlanBinding
			if err := tx.Where("session_id = ? AND sre_task_id = ?", sessionID, legacyID).Find(&bindings).Error; err != nil {
				return err
			}
			ids := map[string]bool{}
			for _, b := range bindings {
				ids[b.GoalID] = true
			}
			if len(ids) == 1 {
				for id := range ids {
					out.Alias.CanonicalID = id
				}
				if err := tx.First(&row, "id = ? AND session_id = ?", out.Alias.CanonicalID, sessionID).Error; err != nil {
					return err
				}
				if err := decodeWorkGoal(row, &goal); err != nil {
					return err
				}
				out.RootTurnID = row.RootTurnID
			} else {
				id := superArchiveGoalPrefix + hash(js([]any{projectID, sessionID, legacyID}))[:32]
				goal = WorkGoal{ID: id, SessionID: sessionID, Title: redact(utf8Prefix(sre.Goal, 1000), c), UserText: redact(sre.Goal, c), Status: "paused", Summary: "历史 SRE 只读映射；未建立新执行或验收资格"}
				if plan := sre.LatestPlan(); plan != nil {
					for _, step := range plan.Steps {
						goal.Items = append(goal.Items, WorkItem{ID: step.ID, Title: redact(step.Description, c), Status: "pending", DependsOn: step.DependsOn})
					}
				}
				row = nativeWorkGoal{ID: id, SessionID: sessionID}
				if err := writeWorkGoalTx(tx, &row, &goal, true); err != nil {
					return err
				}
				out.Alias.CanonicalID = id
			}
		}
		if !workTerminal(goal.Status) && goal.Status != "paused" {
			goal.Status = "paused"
			goal.Summary = "旧执行器已排空；原操作和等待记录保留，新入口不重放历史请求"
			row.LeaseOwner = ""
			row.LeaseUntil = time.Time{}
			if err := writeWorkGoalTx(tx, &row, &goal, false); err != nil {
				return err
			}
		}
		out.ReadOnly = true
		out.CanAdopt = false
		out.Reasons = append(out.Reasons, "source_and_original_handle_reconciliation_required")
		return tx.Create(&superLegacyAliasRow{Kind: kind, LegacyID: legacyID, SessionID: sessionID, ProjectID: projectID, CanonicalID: out.Alias.CanonicalID, RequestHash: requestHash, ReadOnly: true, CreatedAt: time.Now().UTC()}).Error
	})
	return out, err
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
		// RequestID is an intake reference, not proof of an execution root.
		out.Reasons = append(out.Reasons, "original_execution_root_reconciliation_required")
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
