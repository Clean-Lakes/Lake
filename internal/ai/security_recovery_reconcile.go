package ai

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type securityRecoveryReconciliationRow struct {
	ID                                                                         string `gorm:"primaryKey"`
	RecoveryID, ImpactID, SourceID, RecordDigest, DescriptorDigest, ResourceID string
	ProofOperationID, ProofTaskID, ProofDigest, Actor, ActionID                string
	ClosedAttemptID                                                            string
	ConnectionRevision                                                         int64
	ConnectionDigest, Data                                                     string
	At                                                                         time.Time
}

func (securityRecoveryReconciliationRow) TableName() string {
	return "security_recovery_reconciliations"
}

// SecurityRecoveryReconciliationReceipt exposes only proof identities, never
// operation results, arguments, filesystem contents, or archived row bodies.
type SecurityRecoveryReconciliationReceipt struct {
	ID               string    `json:"id"`
	ImpactID         string    `json:"impactId"`
	SourceID         string    `json:"sourceId"`
	RecordDigest     string    `json:"recordDigest"`
	ResourceID       string    `json:"resourceId"`
	OperationID      string    `json:"operationId"`
	TaskID           string    `json:"taskId"`
	ProofDigest      string    `json:"proofDigest"`
	Actor            string    `json:"actor"`
	ActionID         string    `json:"actionId"`
	ClosedAttemptRef string    `json:"closedAttemptRef,omitempty"`
	At               time.Time `json:"at"`
}

type SecurityRecoveryEvidenceRef struct {
	ID     uint64 `json:"id"`
	Digest string `json:"digest"`
}
type SecurityRecoveryReconciliationPreview struct {
	RecoveryID               string                        `json:"recoveryId"`
	RecoveryEpoch            string                        `json:"recoveryEpoch"`
	ReviewRevision           int64                         `json:"reviewRevision"`
	ImpactID                 string                        `json:"impactId"`
	SourceID                 string                        `json:"sourceId"`
	RecordDigest             string                        `json:"recordDigest"`
	OriginalDescriptorDigest string                        `json:"originalDescriptorDigest"`
	OriginalOperationRef     string                        `json:"originalOperationRef"`
	OriginalTool             string                        `json:"originalTool"`
	OriginalScope            security.OperationScope       `json:"originalScope"`
	OriginalServiceID        string                        `json:"originalServiceId"`
	VerificationTool         string                        `json:"verificationTool"`
	VerificationScope        security.OperationScope       `json:"verificationScope"`
	VerificationServiceID    string                        `json:"verificationServiceId"`
	Resource                 security.ResourceRevision     `json:"resource"`
	OperationID              string                        `json:"operationId"`
	TaskID                   string                        `json:"taskId"`
	GoalID                   string                        `json:"goalId"`
	StepID                   string                        `json:"stepId"`
	AttemptID                string                        `json:"attemptId"`
	EnvelopeDigest           string                        `json:"envelopeDigest"`
	DescriptorDigest         string                        `json:"descriptorDigest"`
	Evidence                 []SecurityRecoveryEvidenceRef `json:"evidence"`
	ExpiresAt                time.Time                     `json:"expiresAt"`
	Confirmation             string                        `json:"confirmation"`
	Digest                   string                        `json:"digest"`
}
type SecurityRecoveryReconciliation struct {
	Action        SecurityRecoveryAction        `json:"action"`
	ImpactID      string                        `json:"impactId"`
	SourceID      string                        `json:"sourceId"`
	RecordDigest  string                        `json:"recordDigest"`
	ResourceID    string                        `json:"resourceId"`
	OperationID   string                        `json:"operationId"`
	PreviewDigest string                        `json:"previewDigest"`
	Evidence      []SecurityRecoveryEvidenceRef `json:"evidence"`
	Confirmation  string                        `json:"confirmation"`
}

func activeSecurityRecoveryJournal(ctx context.Context, h *SecurityHome) (securityRestoreJournal, error) {
	var journal securityRestoreJournal
	if h == nil || h.readOnly {
		return journal, errors.New("security: activate recovery and start a new restricted verification task first")
	}
	control, err := ReadSecurityControl(h.Home)
	if err != nil {
		return journal, err
	}
	if err = privateSecurityRead(filepath.Join(h.Home, "security", "restore.pending.json"), &journal); err != nil {
		return journal, err
	}
	if !validSecurityRestoreJournal(journal) || control.StoreID != h.control.StoreID || control.RecoveryEpoch != h.control.RecoveryEpoch || control.RuntimeRoot != h.RuntimeRoot || !activatedRecoveryControl(h.Home, control, journal) {
		return journal, errors.New("security: verified active recovery owner required")
	}
	if err = verifyRecoveryCheckpointBindings(ctx, filepath.Join(h.Home, "security", "recoveries", journal.After.RecoveryID), journal); err != nil {
		return journal, err
	}
	return journal, nil
}

func (e *Engine) ActiveSecurityRecoveryReview(ctx context.Context) (out SecurityRecoveryReview, err error) {
	if err = e.CheckSecurityRuntime(); err != nil {
		return out, err
	}
	journal, err := activeSecurityRecoveryJournal(ctx, e.securityHome())
	if err != nil {
		return out, err
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		var readErr error
		out, readErr = readSecurityRecoveryReview(db.WithContext(ctx), journal)
		out.State = "active"
		out.ReadyForActivation = false
		return readErr
	})
	return out, err
}

func recoveryImpactRecordDigest(op nativeOperation) string {
	return hash(js([]any{op.ID, op.Status, op.ArgsHash, op.DescriptorDigest, op.OrphanState, op.ClosureState, op.CancellationState, op.CancelRequestedAt, op.RiskResolvedAt}))
}

func originalRecoveryImpact(ctx context.Context, home string, journal securityRestoreJournal, impact securityRecoveryImpactRow) (nativeOperation, error) {
	var original nativeOperation
	if impact.Source != "incoming" && impact.Source != "preserved" {
		return original, security.ErrConflict
	}
	dir := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID, impact.Source)
	checkpoint, err := VerifySecurityCheckpoint(ctx, dir)
	if err != nil {
		return original, err
	}
	if checkpoint.ID != impact.SourceID {
		return original, security.ErrConflict
	}
	raw, err := openSecurityReadOnlyMode(filepath.Join(dir, "adk", "sessions.sqlite"), true)
	if err != nil {
		return original, err
	}
	defer raw.Close()
	db, err := gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: raw}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return original, err
	}
	columns, err := securityNativeOperationColumns(ctx, raw)
	if err != nil {
		return original, err
	}
	selected := []string{}
	for _, name := range []string{"id", "status", "args_hash", "descriptor_digest", "security_descriptor", "orphan_state", "closure_state", "cancellation_state", "cancel_requested_at", "risk_resolved_at", "store_id", "recovery_epoch", "session_id", "root_turn_id", "security_task_id", "goal_id", "step_id", "attempt_id", "goal_revision", "plan_revision", "step_revision", "tool", "call_id"} {
		if columns[name] {
			selected = append(selected, name)
		}
	}
	if err = db.WithContext(ctx).Select(selected).First(&original, "id = ?", impact.OperationID).Error; err != nil {
		return original, err
	}
	if recoveryImpactRecordDigest(original) != impact.RecordDigest || original.DescriptorDigest != impact.DescriptorDigest || original.SecurityDescriptor != impact.Descriptor {
		return original, errors.New("security: immutable original effect proof changed")
	}
	return original, nil
}

func recoveryReadOnlyScope(caps []string, profiles []security.CommandProfileScope) bool {
	if len(caps) == 0 {
		return false
	}
	for _, profile := range profiles {
		if !security.ValidateCommandProfileScope(profile) || !slices.Contains([]string{"disk_usage", "process_snapshot", "service_status", "service_logs"}, profile.ID) {
			return false
		}
	}
	hasRead := false
	for _, capability := range caps {
		if securityReadOnlyCapability(capability) {
			hasRead = true
		}
	}
	for _, capability := range caps {
		if securityReadOnlyCapability(capability) {
			continue
		}
		if capability == "local.execute" && hasRead {
			continue
		}
		if (capability == "local.execute" || capability == "terminal.execute" || capability == "terminal.open") && len(profiles) > 0 {
			continue
		}
		return false
	}
	return true
}

func recoveryProbeMatchesOriginal(original, probe security.PreparedOperation) bool {
	if original.ServiceID != "" && original.ServiceID != probe.ServiceID {
		return false
	}
	if original.Scope.FilePath != "" && original.Scope.FilePath != probe.Scope.FilePath {
		if !slices.Contains(original.Capabilities, "file.delete") || probe.Tool != "ls" || filepath.Dir(original.Scope.FilePath) != probe.Scope.FilePath {
			return false
		}
	}
	if original.Scope.DatabaseID != "" && original.Scope.DatabaseID != probe.Scope.DatabaseID || original.Scope.Schema != "" && original.Scope.Schema != probe.Scope.Schema || original.Scope.ClusterID != "" && original.Scope.ClusterID != probe.Scope.ClusterID || original.Scope.Namespace != "" && original.Scope.Namespace != probe.Scope.Namespace || original.Scope.ResourceKind != "" && original.Scope.ResourceKind != probe.Scope.ResourceKind {
		return false
	}
	return true
}

func recoveryReconciliationPreviewTx(tx *gorm.DB, journal securityRestoreJournal, impactID, resourceID, operationID string, now time.Time) (out SecurityRecoveryReconciliationPreview, err error) {
	var review securityRecoveryReviewRow
	if err = tx.First(&review, "recovery_id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", journal.After.RecoveryID, journal.After.StoreID, journal.After.RecoveryEpoch, "activation_prepared").Error; err != nil {
		return out, err
	}
	var impact securityRecoveryImpactRow
	if err = tx.First(&impact, "id = ? AND recovery_id = ? AND scope_state = ?", impactID, journal.After.RecoveryID, "mapped").Error; err != nil {
		return out, err
	}
	original, err := verifiedRecoveryDescriptor(impact)
	if err != nil {
		return out, err
	}
	var block securityRecoveryResourceBlockRow
	if err = tx.First(&block, "recovery_id = ? AND impact_id = ? AND resource_id = ? AND state = ?", journal.After.RecoveryID, impactID, resourceID, "blocked").Error; err != nil {
		return out, err
	}
	var current securityResourceRevisionRow
	if err = tx.First(&current, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", block.ProjectID, resourceID, journal.After.StoreID, journal.After.RecoveryEpoch, "ready").Error; err != nil {
		return out, err
	}
	ref := recoveryResourceReference(current)
	if current.ConnectionRevision != block.ConnectionRevision || current.ConnectionDigest != block.ConnectionDigest {
		return out, security.ErrConflict
	}
	matched := false
	for _, source := range original.Resources {
		if source == ref {
			matched = true
		}
	}
	if !matched {
		return out, errors.New("security: original affected connection differs from current verification asset")
	}
	var op nativeOperation
	if err = tx.First(&op, "id = ? AND store_id = ? AND recovery_epoch = ? AND status = ?", operationID, journal.After.StoreID, journal.After.RecoveryEpoch, "succeeded").Error; err != nil {
		return out, err
	}
	if op.ID == original.ID || op.SecurityTaskID == original.TaskID || op.ResourceID != resourceID || op.ResourceConnectionRevision != ref.ConnectionRevision || op.FinishedAt == nil || op.FinishedAt.After(now) || now.Sub(*op.FinishedAt) > 5*time.Minute || op.OrphanState != "" || op.ClosureState == "effects_unknown" {
		return out, errors.New("security: a fresh new-epoch verification operation is required")
	}
	var probe security.PreparedOperation
	if decodeSecurityJSON(op.SecurityDescriptor, &probe) != nil {
		return out, security.ErrConflict
	}
	digest, digestErr := security.OperationDigest(probe)
	if digestErr != nil || digest != op.DescriptorDigest || probe.ID != op.ID || probe.TaskID != op.SecurityTaskID || probe.ProjectID != block.ProjectID || probe.SessionID != op.SessionID || probe.GoalID != op.GoalID || probe.StepID != op.StepID || probe.AttemptID != op.AttemptID || probe.RootTurnID != op.RootTurnID || probe.OwnerID != op.OwnerID || probe.OwnerGeneration != op.OwnerGeneration || probe.ArgumentsDigest != op.ArgsHash || probe.StoreID != journal.After.StoreID || probe.RecoveryEpoch != journal.After.RecoveryEpoch || len(probe.Resources) != 1 || probe.Resources[0] != ref || probe.Proof == security.ProofOpaque || probe.MCPServerID != "" || !recoveryReadOnlyScope(probe.Capabilities, nil) && probe.Proof != security.ProofCommandProfile {
		return out, errors.New("security: exact registered read proof required")
	}
	entry, known := security.LookupTool(probe.Tool)
	if !known || entry.TargetKind != probe.TargetKind || !recoveryProbeMatchesOriginal(original, probe) {
		return out, errors.New("security: verification probe does not address the original effect target")
	}
	if probe.Proof == security.ProofCommandProfile && !recoveryReadOnlyScope(probe.Capabilities, []security.CommandProfileScope{{ID: probe.CommandProfileID, Version: probe.CommandProfileVersion, ArgumentsDigest: probe.CommandArgumentsDigest}}) {
		return out, errSecurityAction
	}
	var task securityTaskRow
	if err = tx.First(&task, "id = ? AND project_id = ? AND session_id = ? AND goal_id = ? AND store_id = ? AND recovery_epoch = ?", op.SecurityTaskID, probe.ProjectID, op.SessionID, op.GoalID, journal.After.StoreID, journal.After.RecoveryEpoch).Error; err != nil {
		return out, err
	}
	if !task.ExpiresAt.After(now) || !slices.Contains([]security.TaskState{security.TaskActive, security.TaskIdle, security.TaskWaiting, security.TaskCompleted}, task.State) || task.CreatedAt.After(op.StartedAt) {
		return out, errors.New("security: current restricted verification task required")
	}
	var envelopeRow securityTaskEnvelopeRow
	if err = tx.First(&envelopeRow, "task_id = ? AND store_id = ? AND recovery_epoch = ?", task.ID, journal.After.StoreID, journal.After.RecoveryEpoch).Error; err != nil {
		return out, err
	}
	var envelope security.TaskEnvelope
	if decodeSecurityJSON(envelopeRow.Data, &envelope) != nil || envelope.Revision != envelopeRow.Revision || len(envelope.ResourceIDs) != 1 || envelope.ResourceIDs[0] != resourceID || len(envelope.Resources) != 1 || envelope.Resources[0] != ref || len(envelope.BudgetGrantIDs) == 0 || envelope.BackgroundPolicy != "foreground_only" || !recoveryReadOnlyScope(envelope.Capabilities, envelope.CommandProfiles) {
		return out, errors.New("security: verification must use an explicit read-only task envelope for the original asset")
	}
	var attempt workExecutionAttempt
	if err = tx.First(&attempt, "id = ? AND security_task_id = ? AND session_id = ? AND goal_id = ? AND step_id = ? AND root_turn_id = ?", op.AttemptID, task.ID, op.SessionID, op.GoalID, op.StepID, op.RootTurnID).Error; err != nil {
		return out, err
	}
	if attempt.GoalRevision != op.GoalRevision || attempt.PlanRevision != op.PlanRevision || attempt.StepRevision != op.StepRevision {
		return out, security.ErrConflict
	}
	var proofs []nativeEvidence
	if err = tx.Where("operation_id = ? AND session_id = ? AND status = ?", op.ID, op.SessionID, "completed").Order("id").Find(&proofs).Error; err != nil {
		return out, err
	}
	if len(proofs) == 0 || len(proofs) > 100 {
		return out, errors.New("security: original committed verification evidence required")
	}
	refs := make([]SecurityRecoveryEvidenceRef, 0, len(proofs))
	for _, proof := range proofs {
		if proof.CallID != op.CallID || proof.Tool != op.Tool || proof.At.Before(op.StartedAt) || proof.At.After(now) || now.Sub(proof.At) > 5*time.Minute {
			return out, security.ErrConflict
		}
		refs = append(refs, SecurityRecoveryEvidenceRef{proof.ID, hash(js(proof))})
	}
	out = SecurityRecoveryReconciliationPreview{RecoveryID: journal.After.RecoveryID, RecoveryEpoch: journal.After.RecoveryEpoch, ReviewRevision: review.Revision, ImpactID: impact.ID, SourceID: impact.SourceID, RecordDigest: impact.RecordDigest, OriginalDescriptorDigest: impact.DescriptorDigest, OriginalOperationRef: impact.OperationRef, OriginalTool: original.Tool, OriginalScope: original.Scope, OriginalServiceID: original.ServiceID, VerificationTool: probe.Tool, VerificationScope: probe.Scope, VerificationServiceID: probe.ServiceID, Resource: ref, OperationID: op.ID, TaskID: task.ID, GoalID: op.GoalID, StepID: op.StepID, AttemptID: op.AttemptID, EnvelopeDigest: hash(envelopeRow.Data), DescriptorDigest: op.DescriptorDigest, Evidence: refs, ExpiresAt: op.FinishedAt.Add(5 * time.Minute), Confirmation: "已核实原操作 " + impact.OperationRef + " 在资源 " + resourceID + " 上已停止且剩余副作用已核实"}
	if task.ExpiresAt.Before(out.ExpiresAt) {
		out.ExpiresAt = task.ExpiresAt
	}
	out.Digest = hash(js(out))
	return out, nil
}

// SecurityRecoveryReconciliationPreview binds fresh registered evidence to one
// immutable archived operation and one exact current connection. It is read-only.
func (e *Engine) SecurityRecoveryReconciliationPreview(ctx context.Context, impactID, resourceID, operationID string) (out SecurityRecoveryReconciliationPreview, err error) {
	if err = e.CheckSecurityRuntime(); err != nil {
		return out, err
	}
	home := e.securityHome()
	journal, err := activeSecurityRecoveryJournal(ctx, home)
	if err != nil {
		return out, err
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var impact securityRecoveryImpactRow
			if err := tx.First(&impact, "id = ? AND recovery_id = ?", impactID, journal.After.RecoveryID).Error; err != nil {
				return err
			}
			if _, err := originalRecoveryImpact(ctx, home.Home, journal, impact); err != nil {
				return err
			}
			var err error
			out, err = recoveryReconciliationPreviewTx(tx, journal, impactID, resourceID, operationID, time.Now().UTC())
			return err
		})
	})
	return out, err
}

// ReconcileSecurityRecoveryImpact is an explicit human verification action, not
// automatic acceptance of a successful unrelated task. It cannot reopen a Home,
// change a policy, grant authority, or clear any other source/resource block.
func (e *Engine) ReconcileSecurityRecoveryImpact(ctx context.Context, in SecurityRecoveryReconciliation) (out SecurityRecoveryReview, err error) {
	if err = e.CheckSecurityRuntime(); err != nil {
		return out, err
	}
	home := e.securityHome()
	journal, err := activeSecurityRecoveryJournal(ctx, home)
	if err != nil {
		return out, err
	}
	if !validRecoveryAction(in.Action, journal) || in.Action.ActorID != "local-user" {
		return out, errSecurityAction
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	request := js(in)
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if repeated, err := securityActionReplay(tx, journal.After.StoreID, journal.After.RecoveryEpoch, in.Action.ActorID, in.Action.ActionID, request, &out); repeated || err != nil {
				return err
			}
			var impact securityRecoveryImpactRow
			if err := tx.First(&impact, "id = ? AND recovery_id = ?", in.ImpactID, in.Action.RecoveryID).Error; err != nil {
				return err
			}
			sourceOriginal, err := originalRecoveryImpact(ctx, home.Home, journal, impact)
			if err != nil {
				return err
			}
			preview, err := recoveryReconciliationPreviewTx(tx, journal, in.ImpactID, in.ResourceID, in.OperationID, time.Now().UTC())
			if err != nil {
				return err
			}
			if in.Action.ExpectedRevision != preview.ReviewRevision || in.SourceID != preview.SourceID || in.RecordDigest != preview.RecordDigest || in.PreviewDigest != preview.Digest || !slices.Equal(in.Evidence, preview.Evidence) || in.Confirmation != preview.Confirmation {
				return security.ErrConflict
			}
			now := time.Now().UTC()
			receipt := securityRecoveryReconciliationRow{ID: hash(journal.After.RecoveryID + "\x00" + in.Action.ActorID + "\x00" + in.Action.ActionID), RecoveryID: journal.After.RecoveryID, ImpactID: impact.ID, SourceID: impact.SourceID, RecordDigest: impact.RecordDigest, DescriptorDigest: impact.DescriptorDigest, ResourceID: in.ResourceID, ProofOperationID: in.OperationID, ProofTaskID: preview.TaskID, ProofDigest: preview.Digest, Actor: in.Action.ActorID, ActionID: in.Action.ActionID, ConnectionRevision: preview.Resource.ConnectionRevision, ConnectionDigest: preview.Resource.ConnectionDigest, Data: js(preview), At: now}
			if err = tx.Create(&receipt).Error; err != nil {
				return err
			}
			changed := tx.Model(&securityRecoveryResourceBlockRow{}).Where("recovery_id = ? AND impact_id = ? AND resource_id = ? AND state = ? AND connection_revision = ? AND connection_digest = ?", journal.After.RecoveryID, impact.ID, in.ResourceID, "blocked", preview.Resource.ConnectionRevision, preview.Resource.ConnectionDigest).Updates(map[string]any{"state": "reconciled", "proof_ref": receipt.ID, "revision": gorm.Expr("revision + 1")})
			if changed.Error != nil {
				return changed.Error
			}
			if changed.RowsAffected != 1 {
				return security.ErrConflict
			}
			// The incoming canonical row may also carry the original unresolved-effect
			// fence. Retire only that derived fence after every archived scope for the
			// exact original descriptor has its own receipt. Immutable archives and the
			// original result/status/attempt are never rewritten.
			var pending int64
			if err = tx.Table("security_recovery_resource_blocks AS b").Joins("JOIN security_recovery_impacts AS i ON i.id=b.impact_id AND i.recovery_id=b.recovery_id").Where("b.recovery_id = ? AND i.operation_id = ? AND i.descriptor_digest = ? AND b.state = ?", journal.After.RecoveryID, impact.OperationID, impact.DescriptorDigest, "blocked").Count(&pending).Error; err != nil {
				return err
			}
			if pending == 0 {
				var original nativeOperation
				find := tx.First(&original, "id = ? AND descriptor_digest = ? AND security_descriptor = ?", impact.OperationID, impact.DescriptorDigest, impact.Descriptor)
				if find.Error != nil && !errors.Is(find.Error, gorm.ErrRecordNotFound) {
					return find.Error
				}
				if find.Error == nil {
					var matching int64
					if err = tx.Model(&securityRecoveryImpactRow{}).Where("recovery_id = ? AND operation_id = ? AND descriptor_digest = ? AND record_digest = ? AND scope_state = ?", journal.After.RecoveryID, original.ID, original.DescriptorDigest, recoveryImpactRecordDigest(original), "mapped").Count(&matching).Error; err != nil {
						return err
					}
					if matching == 0 {
						return errors.New("security: canonical original effect facts changed after recovery; keep source blocks")
					}
					if err = tx.Model(&nativeOperation{}).Where("id = ? AND descriptor_digest = ? AND security_descriptor = ?", original.ID, impact.DescriptorDigest, impact.Descriptor).Updates(map[string]any{"risk_resolved_at": now, "closure_state": "reconciled", "orphan_state": "reconciled"}).Error; err != nil {
						return err
					}
					if err = tx.Create(&nativeEvidence{OperationID: original.ID, SessionID: original.SessionID, CallID: original.CallID, Tool: original.Tool, Status: "recovery_effect_reconciled", Data: js(map[string]string{"receiptId": receipt.ID, "sourceId": impact.SourceID, "recordDigest": impact.RecordDigest}), At: now}).Error; err != nil {
						return err
					}

				}
				if err = closeReconciledRecoveryAttemptTx(tx, journal, sourceOriginal, receipt.ID, now); err != nil {
					return err
				}
			}
			changed = tx.Model(&securityRecoveryReviewRow{}).Where("recovery_id = ? AND revision = ? AND state = ? AND ledger_index_hash = ?", in.Action.RecoveryID, in.Action.ExpectedRevision, "activation_prepared", journal.LedgerIndexHash).Update("revision", in.Action.ExpectedRevision+1)
			if changed.Error != nil {
				return changed.Error
			}
			if changed.RowsAffected != 1 {
				return security.ErrConflict
			}
			out, err = readSecurityRecoveryReview(tx, journal)
			if err != nil {
				return err
			}
			out.State = "active"
			out.ReadyForActivation = false
			return securityActionRecord(tx, journal.After.StoreID, journal.After.RecoveryEpoch, in.Action.ActorID, in.Action.ActionID, "recovery.effect.reconcile", receipt.ID, request, in.Action.ExpectedRevision, out.Revision, out, now)
		})
	})
	return out, err
}

// Linked originals are immutable facts while any source scope remains blocked.
// Generic resolution and startup orphan cleanup must use the source protocol,
// otherwise even a legitimate changed derived flag loses the archived binding.
func securityRecoveryOperationPendingTx(tx *gorm.DB, op nativeOperation) (bool, error) {
	if !tx.Migrator().HasTable(&securityRecoveryImpactRow{}) || !tx.Migrator().HasTable(&securityRecoveryResourceBlockRow{}) {
		return false, nil
	}
	var count int64
	err := tx.Table("security_recovery_resource_blocks AS b").Joins("JOIN security_recovery_impacts AS i ON i.id=b.impact_id AND i.recovery_id=b.recovery_id").Where("i.operation_id = ? AND i.descriptor_digest = ? AND b.state = ?", op.ID, op.DescriptorDigest, "blocked").Count(&count).Error
	return count > 0, err
}

// Ordinary restart marks an abandoned dispatched attempt unknown. Recovery
// originals retain their exact source facts and separate persistent quarantine.
func recoverDispatchedSecurityOperations(tx *gorm.DB) error {
	query := tx.Model(&nativeOperation{}).Where("status = ?", "dispatched")
	if tx.Migrator().HasTable(&securityRecoveryImpactRow{}) && tx.Migrator().HasTable(&securityRecoveryResourceBlockRow{}) {
		query = query.Where(`NOT EXISTS (SELECT 1 FROM security_recovery_impacts i JOIN security_recovery_resource_blocks b ON b.impact_id=i.id AND b.recovery_id=i.recovery_id WHERE i.operation_id=native_operations.id AND i.descriptor_digest=native_operations.descriptor_digest AND b.state='blocked')`)
	}
	return query.Update("status", "unknown").Error
}

// Side-effect closure permits an explicit new-task retry. It is independent of
// the original attempt's execution state and never creates acceptance/coverage.
func closeReconciledRecoveryAttemptTx(tx *gorm.DB, journal securityRestoreJournal, original nativeOperation, receiptID string, now time.Time) error {
	if original.AttemptID == "" {
		return nil
	}
	var attempt workExecutionAttempt
	err := tx.First(&attempt, "id = ? AND session_id = ? AND goal_id = ? AND step_id = ? AND security_task_id = ? AND root_turn_id = ?", original.AttemptID, original.SessionID, original.GoalID, original.StepID, original.SecurityTaskID, original.RootTurnID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if attempt.GoalRevision != original.GoalRevision || attempt.PlanRevision != original.PlanRevision || attempt.StepRevision != original.StepRevision {
		return errors.New("security: original attempt binding changed; keep recovery risk")
	}
	var operations []nativeOperation
	if err = tx.Where("attempt_id = ? AND session_id = ? AND goal_id = ? AND security_task_id = ? AND root_turn_id = ?", attempt.ID, attempt.SessionID, attempt.GoalID, attempt.SecurityTaskID, attempt.RootTurnID).Find(&operations).Error; err != nil {
		return err
	}
	for _, op := range operations {
		pending, err := securityRecoveryOperationPendingTx(tx, op)
		if err != nil {
			return err
		}
		if pending {
			return nil
		}
		var unresolved int64
		if err = tx.Model(&nativeOperation{}).Where("id = ?", op.ID).Where(securityUnresolvedOperationPredicate(map[string]bool{"orphan_state": true, "closure_state": true, "cancellation_state": true, "cancel_requested_at": true, "risk_resolved_at": true})).Count(&unresolved).Error; err != nil {
			return err
		}
		if unresolved != 0 {
			return nil
		}
	}
	// A newer preserved-only operation may belong to the same original attempt
	// but be absent from the restored canonical ledger. Its source fence counts.
	var impacts []securityRecoveryImpactRow
	if err = tx.Where("recovery_id = ?", journal.After.RecoveryID).Find(&impacts).Error; err != nil {
		return err
	}
	for _, impact := range impacts {
		descriptor, err := verifiedRecoveryDescriptor(impact)
		if err != nil {
			return err
		}
		if descriptor.AttemptID != attempt.ID || descriptor.SessionID != attempt.SessionID || descriptor.GoalID != attempt.GoalID || descriptor.StepID != attempt.StepID || descriptor.TaskID != attempt.SecurityTaskID || descriptor.RootTurnID != attempt.RootTurnID {
			continue
		}
		var blocked int64
		if err = tx.Model(&securityRecoveryResourceBlockRow{}).Where("recovery_id = ? AND impact_id = ? AND state = ?", journal.After.RecoveryID, impact.ID, "blocked").Count(&blocked).Error; err != nil {
			return err
		}
		if blocked != 0 {
			return nil
		}
	}
	if attempt.ClosureState == "reconciled" || attempt.ClosureState == "covered" {
		return nil
	}
	changed := tx.Model(&workExecutionAttempt{}).Where("id = ? AND revision = ? AND closure_state = ?", attempt.ID, attempt.Revision, attempt.ClosureState).Updates(map[string]any{"closure_state": "reconciled", "revision": attempt.Revision + 1})
	if changed.Error != nil {
		return changed.Error
	}
	if changed.RowsAffected != 1 {
		return security.ErrConflict
	}
	if err = tx.Model(&securityRecoveryReconciliationRow{}).Where("id = ?", receiptID).Update("closed_attempt_id", attempt.ID).Error; err != nil {
		return err
	}
	var canonical int64
	if err = tx.Model(&nativeOperation{}).Where("id = ? AND attempt_id = ? AND session_id = ? AND goal_id = ?", original.ID, attempt.ID, attempt.SessionID, attempt.GoalID).Count(&canonical).Error; err != nil {
		return err
	}
	if canonical == 0 {
		return nil
	}
	return tx.Create(&nativeEvidence{OperationID: original.ID, SessionID: original.SessionID, CallID: original.CallID, Tool: original.Tool, Status: "recovery_attempt_reconciled", Data: js(map[string]string{"receiptId": receiptID, "attemptId": attempt.ID}), At: now}).Error
}
