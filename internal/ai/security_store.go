package ai

import (
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// These are application tables in the canonical ADK store. They do not replace
// native operations, native approvals, or WorkGoal as their respective ledgers.
type securityTaskRow struct {
	ID                               string `gorm:"primaryKey"`
	GoalID                           string `gorm:"index"`
	GoalRevision                     int64
	SourceMessageID                  string
	SourceKind, SourceEventID        string
	ProjectID                        string `gorm:"index"`
	SessionID                        string `gorm:"index"`
	ParentTaskID, Kind               string
	StoreID, RecoveryEpoch           string
	State                            security.TaskState `gorm:"index"`
	StateRevision, ExecutionRevision int64
	CreatedAt, ExpiresAt             time.Time
	ClosedReason                     string
	BackgroundPolicy                 string
}

func (securityTaskRow) TableName() string { return "security_tasks" }

type securityTaskBinding struct {
	ID                                     string `gorm:"primaryKey"`
	TaskID                                 string `gorm:"uniqueIndex:security_task_execution,priority:1;index"`
	Kind                                   string `gorm:"uniqueIndex:security_task_execution,priority:2"`
	ExecutionID                            string `gorm:"uniqueIndex:security_task_execution,priority:3"`
	SessionID, GoalID, RootTurnID, ScopeID string
	StoreID, RecoveryEpoch                 string
	ExecutionRevision                      int64
	State                                  string `gorm:"index"`
	OwnerID, OwnerKind                     string
	OwnerGeneration                        int64
	LeaseUntil                             time.Time
	CreatedAt, UpdatedAt                   time.Time
}

func (securityTaskBinding) TableName() string { return "security_task_bindings" }

type securityAuthorityEvent struct {
	ProjectID                                                 string `gorm:"index"`
	ID                                                        string `gorm:"primaryKey"`
	ActionKey                                                 string `gorm:"uniqueIndex"`
	RequestHash                                               string
	StoreID, RecoveryEpoch, ActorID, ActionID, Kind, ObjectID string
	BeforeRevision, AfterRevision                             int64
	Result                                                    string
	At                                                        time.Time
}

func (securityAuthorityEvent) TableName() string { return "security_authority_events" }

func securityStoreModels() []any {
	models := append([]any{&securityTaskRow{}, &securityTaskBinding{}, &securityAuthorityEvent{}, &securitySessionTargetRow{}, &securityBoundaryRow{}, &securityGoalSelectionRow{}, &securityWorkResumeRow{}, &securityRuntimeModeRow{}}, securityWorkflowModels()...)
	models = append(models, securityScheduleModels()...)
	return append(models, securitySREModels()...)
}

func migrateSecurityStore(tx *gorm.DB) error { return tx.AutoMigrate(securityStoreModels()...) }

func (r securityTaskRow) task() security.SecurityTask {
	return security.SecurityTask{ID: r.ID, GoalID: r.GoalID, ProjectID: r.ProjectID, SessionID: r.SessionID, ParentTaskID: r.ParentTaskID, Kind: r.Kind, StoreID: r.StoreID, RecoveryEpoch: r.RecoveryEpoch, State: r.State, StateRevision: r.StateRevision, ExecutionRevision: r.ExecutionRevision, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, ClosedReason: r.ClosedReason}
}

func securityTaskRecord(t security.SecurityTask) securityTaskRow {
	return securityTaskRow{ID: t.ID, GoalID: t.GoalID, ProjectID: t.ProjectID, SessionID: t.SessionID, ParentTaskID: t.ParentTaskID, Kind: t.Kind, StoreID: t.StoreID, RecoveryEpoch: t.RecoveryEpoch, State: t.State, StateRevision: t.StateRevision, ExecutionRevision: t.ExecutionRevision, CreatedAt: t.CreatedAt, ExpiresAt: t.ExpiresAt, ClosedReason: t.ClosedReason}
}
