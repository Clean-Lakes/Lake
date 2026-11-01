package ai

import (
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func permitFixture(t *testing.T) (*gorm.DB, time.Time, security.PreparedOperation, ExecutionOwner, security.TaskGrant) {
	t.Helper()
	db, now := taskStoreFixture(t)
	models := append(securityPolicyModels(), workClosureModels()...)
	models = append(models, &nativeApproval{}, &securitySessionTargetRow{}, &securityBoundaryRow{})
	if err := db.AutoMigrate(models...); err != nil {
		t.Fatal(err)
	}
	task := startTaskFixture(t, db, now)
	var owner ExecutionOwner
	if err := db.Transaction(func(tx *gorm.DB) error {
		binding, err := bindSecurityTaskTurn(tx, task.ID, "store", "epoch", "turn", "", task.ExecutionRevision, now)
		if err != nil {
			return err
		}
		owner, err = acquireExecutionOwner(tx, binding.ID, "owner", "agent", 0, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	contract := WorkClosureContract{ProjectID: "project", GoalRevision: 1, PlanRevision: 1, Steps: map[string]WorkStepContract{"step": {Revision: 1, Required: true, Criteria: []security.AcceptanceCriterion{{ID: "c1", Method: "operation_succeeded", Target: "r1"}}}}, ActiveAttempts: map[string]string{"step": "attempt"}}
	goal := WorkGoal{ID: "goal", SessionID: "session", Status: "running", ActiveItemID: "step", Items: []WorkItem{{ID: "step", Status: "running"}}}
	if err := db.Model(&nativeWorkGoal{}).Where("id = ?", "goal").Updates(map[string]any{"data": js(goal), "closure_contract": js(contract), "goal_revision": 1, "plan_revision": 1, "progress_revision": 1}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&workExecutionAttempt{ID: "attempt", SessionID: "session", ProjectID: "project", GoalID: "goal", GoalRevision: 1, PlanRevision: 1, StepID: "step", StepRevision: 1, SecurityTaskID: task.ID, RootTurnID: "turn", State: "prepared", ClosureState: "open", Revision: 1, CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	r := security.ResourceRevision{ID: "r1", ConnectionRevision: 1, ConnectionDigest: security.ContentDigest([]byte("connection")), State: "ready"}
	if err := db.Create(&securityResourceRevisionRow{ProjectID: "project", ResourceID: r.ID, StoreID: "store", RecoveryEpoch: "epoch", ConnectionRevision: 1, ConnectionDigest: r.ConnectionDigest, State: "ready"}).Error; err != nil {
		t.Fatal(err)
	}
	p := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"r1"}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither, Limits: security.ScopeLimits{FileRoots: []string{"/var/log"}}}}}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := putSecurityProjectPolicy(tx, "store", "epoch", SecurityPolicyAction{ActorID: "user", ActionID: "policy", ProjectID: "project"}, p, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var grant security.TaskGrant
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		grant, err = issueSecurityTaskGrant(tx, "store", "epoch", SecurityTaskGrantAction{Action: SecurityTaskAction{ActorID: "user", ActionID: "grant", ProjectID: "project", SessionID: "session", GoalID: "goal", TaskID: task.ID, ExpectedRevision: 1}, Grant: security.TaskGrant{Resources: []security.ResourceRevision{r}, Capabilities: []string{"file.read"}, ExpiresAt: now.Add(30 * time.Minute), RemainingUses: 2, Limits: security.ScopeLimits{FileRoots: []string{"/var/log"}}}}, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	o := security.PreparedOperation{FormatVersion: 1, ID: "op1", Actor: "agent", StoreID: "store", RecoveryEpoch: "epoch", ProjectID: "project", SessionID: "session", GoalID: "goal", GoalRevision: 1, PlanRevision: 1, StepID: "step", StepRevision: 1, AttemptID: "attempt", TaskID: task.ID, ExecutionRevision: 1, RootTurnID: "turn", CallID: "call", Tool: "read", RegistryVersion: security.RegistryVersion, TargetKind: security.TargetResource, Resources: []security.ResourceRevision{r}, Capabilities: []string{"file.read"}, Proof: security.ProofStructured, ArgumentsDigest: security.ContentDigest([]byte("args")), PreviewDigest: security.ContentDigest([]byte("preview")), PolicyRevision: 1, EnvelopeRevision: 1, GrantRevisions: []security.RevisionRef{{ID: grant.ID, Revision: 1}}, OwnerID: owner.OwnerID, OwnerGeneration: owner.Generation, Scope: security.OperationScope{FilePath: "/var/log/syslog"}}
	return db, now, o, owner, grant
}

func commitPermitOperation(tx *gorm.DB, o security.PreparedOperation, owner ExecutionOwner, now time.Time) error {
	if _, err := AcquireSecurityPermitTx(tx, o, owner, now); err != nil {
		return err
	}
	return tx.Create(&nativeOperation{ID: o.ID, SessionID: o.SessionID, RootTurnID: o.RootTurnID, CallID: o.CallID, Tool: o.Tool, Status: "dispatched", Risk: "readonly", ResourceID: o.Resources[0].ID, SecurityTaskID: o.TaskID, StartedAt: now}).Error
}

func grantRemaining(t *testing.T, db *gorm.DB, id string) int64 {
	t.Helper()
	var row securityTaskGrantRow
	if err := db.First(&row, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return row.RemainingUses
}

func TestSecurityPermitTransactionRollbackAndReplay(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	forced := errors.New("forced native-operation registration failure")
	if err := db.Transaction(func(tx *gorm.DB) error {
		if _, err := AcquireSecurityPermitTx(tx, o, owner, now); err != nil {
			return err
		}
		return forced
	}); !errors.Is(err, forced) {
		t.Fatal(err)
	}
	if n := grantRemaining(t, db, g.ID); n != 2 {
		t.Fatalf("rollback consumed grant: %d", n)
	}
	var count int64
	if err := db.Model(&securityDecisionRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("rollback retained audit", count, err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err != nil {
		t.Fatal(err)
	}
	if n := grantRemaining(t, db, g.ID); n != 1 {
		t.Fatalf("expected one use %d", n)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err == nil {
		t.Fatal("permit reused")
	}
	if n := grantRemaining(t, db, g.ID); n != 1 {
		t.Fatalf("replay consumed grant %d", n)
	}
}

func TestSecurityPermitOnlyNotExecutedRefundsOnce(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&nativeOperation{}).Where("id = ?", o.ID).Update("status", "unknown").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return RefundSecurityPermitTx(tx, o.ID) }); err == nil {
		t.Fatal("unknown refunded")
	}
	if n := grantRemaining(t, db, g.ID); n != 1 {
		t.Fatal(n)
	}
	if err := db.Model(&nativeOperation{}).Where("id = ?", o.ID).Update("status", "not_executed").Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Transaction(func(tx *gorm.DB) error { return RefundSecurityPermitTx(tx, o.ID) }); err != nil {
			t.Fatal(err)
		}
	}
	if n := grantRemaining(t, db, g.ID); n != 2 {
		t.Fatalf("refund repeated or absent %d", n)
	}
}

func TestSecurityPermitRevocationBeforeCommitZeroDispatch(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	action := SecurityTaskAction{ActorID: "user", ActionID: "revoke", ProjectID: "project", SessionID: "session", GoalID: "goal", TaskID: o.TaskID}
	if err := db.Transaction(func(tx *gorm.DB) error { return revokeSecurityTaskGrant(tx, "store", "epoch", action, g.ID, 1, now) }); err != nil {
		t.Fatal(err)
	}
	dispatched := false
	err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) })
	if err == nil {
		dispatched = true
	}
	if dispatched {
		t.Fatal("revoked authority dispatched")
	}
	if n := grantRemaining(t, db, g.ID); n != 2 {
		t.Fatal(n)
	}
}

func TestSecurityPermitConcurrentBudgetSingleUse(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	if err := db.Model(&securityTaskGrantRow{}).Where("id = ?", g.ID).Update("remaining_uses", 1).Error; err != nil {
		t.Fatal(err)
	}
	var dispatched atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			op := o
			op.ID = op.ID + string(rune('a'+i))
			err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, op, owner, now) })
			if err == nil {
				dispatched.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if dispatched.Load() != 1 {
		t.Fatalf("dispatches=%d", dispatched.Load())
	}
	if n := grantRemaining(t, db, g.ID); n != 0 {
		t.Fatal(n)
	}
}

func TestSecurityPolicyActionCASAndLegacySessionIsolation(t *testing.T) {
	db, now, _, _, _ := permitFixture(t)
	p, err := loadSecurityPolicy(db, "project", "store", "epoch")
	if err != nil {
		t.Fatal(err)
	}
	a := SecurityPolicyAction{ActorID: "user", ActionID: "policy2", ProjectID: "project", ExpectedRevision: 1}
	var one, two security.ProjectPolicy
	if err = db.Transaction(func(tx *gorm.DB) error {
		one, err = putSecurityProjectPolicy(tx, "store", "epoch", a, p, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = db.Transaction(func(tx *gorm.DB) error {
		two, err = putSecurityProjectPolicy(tx, "store", "epoch", a, p, now.Add(time.Minute))
		return err
	}); err != nil || one.Revision != two.Revision {
		t.Fatal("idempotence", two, err)
	}
	a.ActionID = "stale"
	if err = db.Transaction(func(tx *gorm.DB) error {
		_, err := putSecurityProjectPolicy(tx, "store", "epoch", a, p, now)
		return err
	}); !errors.Is(err, security.ErrConflict) {
		t.Fatal("stale CAS", err)
	}
	for _, entry := range []struct {
		id string
		p  Permissions
	}{{"session", Permissions{SilentCommands: false}}, {"other", Permissions{SilentCommands: true}}} {
		if err = recordLegacySessionPolicy(db, "store", "epoch", "project", entry.id, "web", entry.p); err != nil {
			t.Fatal(err)
		}
	}
	if err = recordLegacySessionPolicy(db, "store", "epoch", "project", "session", "web", Permissions{SilentCommands: true}); err != nil {
		t.Fatal(err)
	}
	var row securityLegacySessionPolicyRow
	if err = db.First(&row, "session_id = ?", "session").Error; err != nil {
		t.Fatal(err)
	}
	if row.Data != js(Permissions{SilentCommands: false}) {
		t.Fatal("legacy settings overwritten")
	}
}

type permitApprovalBindingColumns struct {
	ID                                                                string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, SecurityTaskID, DescriptorDigest, ScopeID string
	ExecutionRevision                                                 int64
	CreatedAt                                                         time.Time
	EnvelopeException                                                 bool
}

func (permitApprovalBindingColumns) TableName() string { return "native_approvals" }

func TestSecurityPermitConsumesOriginalApprovalWithRollback(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	if err := db.AutoMigrate(&permitApprovalBindingColumns{}); err != nil {
		t.Fatal(err)
	}
	// A single approval is the capability source, while the existing explicit
	// task budget remains independently binding.
	policy, loadErr := loadSecurityPolicy(db, o.ProjectID, o.StoreID, o.RecoveryEpoch)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	policy.Rules[0].Grantable = false
	policy.Rules[0].Confirmation = security.ConfirmSingle
	if err := db.Model(&securityProjectPolicyRow{}).Where("project_id = ?", o.ProjectID).Update("data", js(policy)).Error; err != nil {
		t.Fatal(err)
	}
	_ = g
	digest, err := security.OperationDigest(o)
	if err != nil {
		t.Fatal(err)
	}
	a := nativeApproval{ID: "approval", SessionID: o.SessionID, RootTurnID: o.RootTurnID, CallID: o.CallID, Status: "authorized", Accepted: true, ExpiresAt: now.Add(10 * time.Minute)}
	if err = db.Create(&a).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Table("native_approvals").Where("id = ?", a.ID).Updates(map[string]any{"store_id": o.StoreID, "recovery_epoch": o.RecoveryEpoch, "security_task_id": o.TaskID, "descriptor_digest": digest, "execution_revision": o.ExecutionRevision, "created_at": now}).Error; err != nil {
		t.Fatal(err)
	}
	forced := errors.New("rollback")
	if err = db.Transaction(func(tx *gorm.DB) error {
		if _, err := AcquireSecurityPermitTx(tx, o, owner, now); err != nil {
			return err
		}
		return forced
	}); !errors.Is(err, forced) {
		t.Fatal(err)
	}
	if err = db.First(&a, "id = ?", a.ID).Error; err != nil || a.Status != "authorized" {
		t.Fatal("rollback consumed approval", a.Status, err)
	}
	if err = db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err != nil {
		t.Fatal(err)
	}
	if err = db.First(&a, "id = ?", a.ID).Error; err != nil || a.Status != "consumed" {
		t.Fatal("approval not consumed", a.Status, err)
	}
	var count int64
	if err = db.Model(&nativeEvidence{}).Where("operation_id = ? AND status = ?", o.ID, "approved").Count(&count).Error; err != nil || count != 1 {
		t.Fatal("original evidence missing", count, err)
	}
}

func TestSecurityPermitNilPendingTargetAndResourceConnectionChange(t *testing.T) {
	db, now, o, owner, _ := permitFixture(t)
	if err := db.Create(&securitySessionTargetRow{SessionID: o.SessionID, ProjectID: o.ProjectID, StoreID: o.StoreID, RecoveryEpoch: o.RecoveryEpoch, Revision: 1, PendingResolution: "null"}).Error; err != nil {
		t.Fatal(err)
	}
	o.TargetRevision = 1
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err != nil {
		t.Fatalf("JSON null interpreted as unresolved target: %v", err)
	}
	o.ID = "op2"
	if err := db.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", o.ProjectID, "r1").Update("connection_revision", 2).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err == nil {
		t.Fatal("stale connection dispatched")
	}
}

func TestSecurityGrantExpansionCASDiffAndNoImplicitRefresh(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err != nil {
		t.Fatal(err)
	}
	in := SecurityTaskGrantExpansion{Action: SecurityTaskAction{ActorID: "user", ActionID: "expand", ProjectID: o.ProjectID, SessionID: o.SessionID, GoalID: o.GoalID, TaskID: o.TaskID, ExpectedRevision: 1}, GrantID: g.ID, ExpectedGrantRevision: 1, ExpectedEnvelopeRevision: 1, DesiredScope: g}
	in.DesiredScope.Limits.FileRoots = []string{"/var/log/app"}
	var preview SecurityTaskGrantChange
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		preview, err = previewSecurityTaskGrantExpansion(tx, "store", "epoch", in, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if preview.AfterGrant.RemainingUses != 1 || !preview.AfterGrant.ExpiresAt.Equal(g.ExpiresAt) || !preview.AfterGrant.CreatedAt.Equal(g.CreatedAt) {
		t.Fatal("scope update refreshed budget or TTL", preview.AfterGrant)
	}
	if err := db.Transaction(func(tx *gorm.DB) error { _, err := expandSecurityTaskGrant(tx, "store", "epoch", in, now); return err }); err == nil {
		t.Fatal("unconfirmed diff accepted")
	}
	in.ConfirmedChangeDigest = preview.Digest
	var updated security.TaskGrant
	if err := db.Transaction(func(tx *gorm.DB) error {
		var err error
		updated, err = expandSecurityTaskGrant(tx, "store", "epoch", in, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 || updated.RemainingUses != 1 {
		t.Fatal(updated)
	}
	var envelope securityTaskEnvelopeRow
	if err := db.First(&envelope, "task_id = ?", o.TaskID).Error; err != nil || envelope.Revision != 2 {
		t.Fatal(envelope, err)
	}
	if err := db.Transaction(func(tx *gorm.DB) error {
		_, err := expandSecurityTaskGrant(tx, "store", "epoch", in, now.Add(time.Second))
		return err
	}); err != nil {
		t.Fatal("idempotent replay", err)
	}
	if n := grantRemaining(t, db, g.ID); n != 1 {
		t.Fatal("replay refreshed uses", n)
	}
	o.ID = "next"
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err == nil {
		t.Fatal("old prepared revision survived scope update")
	}
	in.Action.ActionID = "stale"
	if err := db.Transaction(func(tx *gorm.DB) error { _, err := expandSecurityTaskGrant(tx, "store", "epoch", in, now); return err }); !errors.Is(err, security.ErrConflict) {
		t.Fatal("stale CAS", err)
	}
}

func TestSecurityGrantExpansionCannotWidenProjectCeiling(t *testing.T) {
	db, now, o, _, g := permitFixture(t)
	in := SecurityTaskGrantExpansion{Action: SecurityTaskAction{ActorID: "user", ActionID: "expand", ProjectID: o.ProjectID, SessionID: o.SessionID, GoalID: o.GoalID, TaskID: o.TaskID, ExpectedRevision: 1}, GrantID: g.ID, ExpectedGrantRevision: 1, ExpectedEnvelopeRevision: 1, DesiredScope: g}
	in.DesiredScope.Limits.FileRoots = []string{"/var"}
	if _, err := previewSecurityTaskGrantExpansion(db, "store", "epoch", in, now); err == nil {
		t.Fatal("project hard ceiling expanded")
	}
}

func TestSecurityPermitUnsupportedAuthorityFieldsFailClosed(t *testing.T) {
	for _, table := range []string{"security_project_policies", "security_task_grants", "security_task_envelopes"} {
		t.Run(table, func(t *testing.T) {
			db, now, o, owner, _ := permitFixture(t)
			var row struct{ Data string }
			if err := db.Table(table).First(&row).Error; err != nil {
				t.Fatal(err)
			}
			changed := strings.TrimSuffix(row.Data, "}") + `,"unsupportedAuthority":true}`
			if err := db.Table(table).Where("1 = 1").Update("data", changed).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err == nil {
				t.Fatal("unknown authority field ignored")
			}
			var count int64
			if err := db.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
				t.Fatal("rejected operation registered", count, err)
			}
		})
	}
}

func TestSecurityPermitUsesCurrentLeaseForSamePreparedGeneration(t *testing.T) {
	db, now, o, owner, _ := permitFixture(t)
	if _, err := renewExecutionOwner(db, owner, now.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}
	// The original prepared token's timestamp is expired, but a continuous
	// heartbeat kept this exact generation alive. Waiting must not revoke itself.
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now.Add(20*time.Second)) }); err != nil {
		t.Fatal("live heartbeat invalidated prepared operation", err)
	}
	o.ID = "op-after-lease"
	if err := db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now.Add(26*time.Second)) }); err == nil {
		t.Fatal("expired actual lease dispatched")
	}
}

func TestSecurityPermitProjectAllowStillConsumesExplicitEnvelopeBudget(t *testing.T) {
	db, now, o, owner, g := permitFixture(t)
	policy, err := loadSecurityPolicy(db, o.ProjectID, o.StoreID, o.RecoveryEpoch)
	if err != nil {
		t.Fatal(err)
	}
	policy.Rules[0].Effect = security.EffectAllow
	if err = db.Model(&securityProjectPolicyRow{}).Where("project_id = ?", o.ProjectID).Update("data", js(policy)).Error; err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two"} {
		o.ID = id
		if err = db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err != nil {
			t.Fatal(err)
		}
	}
	var row securityTaskGrantRow
	if err = db.First(&row, "id = ?", g.ID).Error; err != nil || row.RemainingUses != 0 {
		t.Fatalf("project allow bypassed budget: %+v %v", row, err)
	}
	o.ID = "three"
	if err = db.Transaction(func(tx *gorm.DB) error { return commitPermitOperation(tx, o, owner, now) }); err == nil {
		t.Fatal("exhausted project-allow budget executed")
	}
	var count int64
	if err = db.Model(&nativeOperation{}).Where("id = ?", o.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("denied call registered operation: %d %v", count, err)
	}
	if err = db.Model(&nativeOperation{}).Where("id = ?", "one").Update("status", "not_executed").Error; err != nil {
		t.Fatal(err)
	}
	if err = RefundSecurityPermitTx(db, "one"); err != nil {
		t.Fatal(err)
	}
	if err = RefundSecurityPermitTx(db, "one"); err != nil {
		t.Fatal(err)
	}
	if err = db.First(&row, "id = ?", g.ID).Error; err != nil || row.RemainingUses != 1 {
		t.Fatalf("refund not exactly once: %+v %v", row, err)
	}
}
