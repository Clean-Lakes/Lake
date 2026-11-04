package ai

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"gorm.io/gorm"
)

const superSchemaVersion = 5

type superSchemaRow struct {
	ID      int `gorm:"primaryKey"`
	Version int
}

func (superSchemaRow) TableName() string { return "superagent_schema" }

type superSourceRow struct {
	ID                                          string `gorm:"primaryKey"`
	ProjectID, Kind, ActorRef, Revision, Cursor string
	Enabled                                     bool
}

func (superSourceRow) TableName() string { return "superagent_sources" }

type superEventRow struct {
	SourceKind                                                      string
	RoutingAttempts                                                 int
	RetryAt                                                         time.Time
	HostInputHash                                                   string
	ID                                                              string `gorm:"primaryKey"`
	SourceID                                                        string `gorm:"uniqueIndex:super_event_source,priority:1"`
	SourceEventID                                                   string `gorm:"uniqueIndex:super_event_source,priority:2"`
	ProjectID                                                       string `gorm:"index"`
	SourceRevision, ActorRef, ThreadRef, Kind, Payload, PayloadHash string
	Disposition                                                     string `gorm:"index"`
	ReceivedAt                                                      time.Time
}

func (superEventRow) TableName() string { return "superagent_events" }

type superDecisionRow struct {
	AppliedAt                           *time.Time
	ID                                  string `gorm:"primaryKey"`
	EventID                             string `gorm:"uniqueIndex:super_decision,priority:1"`
	PartKey                             string `gorm:"uniqueIndex:super_decision,priority:2"`
	Revision                            int64  `gorm:"uniqueIndex:super_decision,priority:3"`
	TaskID, Action, Reason, RequestHash string
	Quote, Title, RoleKey               string
	At                                  time.Time
}

func (superDecisionRow) TableName() string { return "superagent_decisions" }

type superRoleRow struct {
	ID                                     string `gorm:"primaryKey"`
	ProjectID, RoleKey, Name, Capabilities string
	Duties                                 string
	Revision                               int64
}

func (superRoleRow) TableName() string { return "superagent_roles" }

type superWorkerRow struct {
	RoleSnapshot                                          string
	Protocol                                              string
	ParentGeneration                                      int64
	GoalSessionID                                         string
	ConversationMode                                      string
	ID                                                    string `gorm:"primaryKey"`
	TaskID                                                string `gorm:"index"`
	ProjectID, SessionID, ParentWorkerID, RoleID, ScopeID string
	SourceEventID, OriginRootTurnID                       string
	Revision                                              int64
	CreatedAt                                             time.Time
}

func (superWorkerRow) TableName() string { return "superagent_workers" }

func (w superWorkerRow) goalSession() string {
	if w.GoalSessionID != "" {
		return w.GoalSessionID
	}
	return w.SessionID
}

type superAssignmentRow struct {
	InvocationKind                        string
	FailureCount                          int
	LastError                             string
	ID                                    string `gorm:"primaryKey"`
	WorkerID                              string `gorm:"index"`
	AttemptID, OwnerID, Checkpoint, State string
	ProjectID                             string `gorm:"index"`
	InputEventID                          string
	CreatedAt                             time.Time
	Generation                            int64
	LeaseUntil                            time.Time
}

func (superAssignmentRow) TableName() string { return "superagent_assignments" }

type superSubscriptionRow struct {
	ID                      string `gorm:"primaryKey"`
	SourceID                string `gorm:"uniqueIndex:super_subscription,priority:1"`
	ThreadRef               string `gorm:"uniqueIndex:super_subscription,priority:2"`
	WorkerID                string `gorm:"uniqueIndex:super_subscription,priority:3"`
	ProjectID, TaskID, Mode string
	Revision                int64
	ClosedAt                *time.Time
}

func (superSubscriptionRow) TableName() string { return "superagent_subscriptions" }

type superInboxRow struct {
	ID                                          string `gorm:"primaryKey"`
	EventID                                     string `gorm:"uniqueIndex:super_input,priority:1"`
	PartKey                                     string `gorm:"uniqueIndex:super_input,priority:2"`
	WorkerID                                    string `gorm:"uniqueIndex:super_input,priority:3"`
	TaskID, AssignmentID, Mode, ConsumedEventID string
	SourceMessageID, RootTurnID                 string
	SDKSessionID                                string
	DeliveredAt, ConsumedAt                     *time.Time
}

type superHandbackRow struct {
	EventID  string `gorm:"primaryKey"`
	WorkerID string `gorm:"primaryKey"`
	Reason   string
	At       time.Time
}

func (superHandbackRow) TableName() string { return "superagent_handbacks" }

func (superInboxRow) TableName() string { return "superagent_inbox" }

type superOutputRow struct {
	ID                                                                                         string `gorm:"primaryKey"`
	TaskID, ProjectID, ChannelRef, SourceMessageID, Kind, Payload, RequestHash, State, Receipt string
	ReportRevision                                                                             int64
	RetryAt, CreatedAt                                                                         time.Time
}

func (superOutputRow) TableName() string { return "superagent_outbox" }

type superLegacyAliasRow struct {
	ReadOnly                                       bool
	Kind                                           string `gorm:"primaryKey"`
	LegacyID                                       string `gorm:"primaryKey"`
	SessionID, ProjectID, CanonicalID, RequestHash string
	CreatedAt                                      time.Time
}

func (superLegacyAliasRow) TableName() string { return "superagent_legacy_aliases" }

func superagentModels() []any {
	return append(superagentV4Models(), &superRoleMutationRow{})
}

func superagentV4Models() []any {
	return append(superagentV3Models(), &superChannelRow{}, &superChannelSourceRow{}, &superTaskReferenceRow{})
}

func superagentV3Models() []any {
	return []any{&superSchemaRow{}, &superSourceRow{}, &superEventRow{}, &superDecisionRow{}, &superRoleRow{}, &superWorkerRow{}, &superAssignmentRow{}, &superSubscriptionRow{}, &superInboxRow{}, &superOutputRow{}, &superLegacyAliasRow{}, &superHandbackRow{}, &superAdmissionRow{}, &superProjectRow{}, &superBudgetRow{}, &superModelChargeRow{}}
}

// MigrateSuperagentStore adds routing metadata only. A newer schema is rejected
// before AutoMigrate. Activation/cutover is a separate operation.
func MigrateSuperagentStore(db *gorm.DB) error {
	if db.Migrator().HasTable(&superSchemaRow{}) {
		var row superSchemaRow
		if err := db.First(&row, "id = ?", 1).Error; err != nil {
			return err
		}
		if row.Version != 3 && row.Version != 4 && row.Version != superSchemaVersion {
			return errors.New("superagent: unsupported schema")
		}
		if row.Version == 3 {
			for _, model := range superagentV3Models() {
				if !db.Migrator().HasTable(model) {
					return errors.New("superagent: incomplete previous schema")
				}
			}
			if err := db.Transaction(func(tx *gorm.DB) error {
				if err := tx.AutoMigrate(&superChannelRow{}, &superChannelSourceRow{}, &superTaskReferenceRow{}); err != nil {
					return err
				}
				var workers []superWorkerRow
				if err := tx.Where("parent_worker_id = ''").Order("created_at,id").Find(&workers).Error; err != nil {
					return err
				}
				for _, worker := range workers {
					if _, err := ensureSuperChannelTx(tx, worker.ProjectID, worker.RoleID, worker.CreatedAt); err != nil {
						return err
					}
				}
				return tx.Model(&superSchemaRow{}).Where("id = ? AND version = ?", 1, 3).Update("version", 4).Error
			}); err != nil {
				return err
			}
			row.Version = 4
		}
		if row.Version == 4 {
			for _, model := range superagentV4Models() {
				if !db.Migrator().HasTable(model) {
					return errors.New("superagent: incomplete previous schema")
				}
			}
			return db.Transaction(func(tx *gorm.DB) error {
				if err := tx.AutoMigrate(&superRoleRow{}, &superWorkerRow{}, &superRoleMutationRow{}); err != nil {
					return err
				}
				var workers []superWorkerRow
				if err := tx.Find(&workers).Error; err != nil {
					return err
				}
				for _, worker := range workers {
					var role superRoleRow
					if err := tx.First(&role, "id = ? AND project_id = ?", worker.RoleID, worker.ProjectID).Error; err != nil {
						return err
					}
					if err := tx.Model(&worker).Update("role_snapshot", js(specialistRole(role))).Error; err != nil {
						return err
					}
				}
				return tx.Model(&superSchemaRow{}).Where("id = ? AND version = ?", 1, 4).Update("version", superSchemaVersion).Error
			})
		}
		for _, model := range superagentModels() {
			if !db.Migrator().HasTable(model) {
				return errors.New("superagent: incomplete schema")
			}
		}
		return nil
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.AutoMigrate(superagentModels()...); err != nil {
			return err
		}
		if err := tx.Create(&superSchemaRow{ID: 1, Version: superSchemaVersion}).Error; err != nil {
			return err
		}
		// Previous binaries already honor this guard before any AutoMigrate.
		// Metadata is not safe for an older writer to ignore during cutover.
		if tx.Migrator().HasTable("security_schema_meta") {
			return tx.Exec("UPDATE security_schema_meta SET minimum_reader_version=MAX(minimum_reader_version,3) WHERE id=1").Error
		}
		return nil
	})
}

func (e *Engine) superStore() (*gorm.DB, error) {
	owner, err := securityRootEngine(e)
	if err != nil {
		return nil, err
	}
	if err = owner.CheckSecurityRuntime(); err != nil {
		return nil, err
	}
	store, err := owner.adkStore()
	if err != nil {
		return nil, err
	}
	owner.superOnce.Do(func() {
		var schema superSchemaRow
		needsBackup := !store.DB.Migrator().HasTable(&superSchemaRow{})
		if !needsBackup && store.DB.First(&schema, "id = ?", 1).Error == nil {
			needsBackup = schema.Version == 3 || schema.Version == 4
		}
		if needsBackup {
			lifetime := owner.HostContext
			if lifetime == nil {
				lifetime = owner.workContext
			}
			if lifetime == nil {
				lifetime = context.Background()
			}
			// A multi-GiB consistent VACUUM snapshot plus quick_check can exceed
			// 30 seconds. This is one migration only; shutdown still cancels it.
			backupCtx, cancel := context.WithTimeout(lifetime, 5*time.Minute)
			defer cancel()
			owner.superErr = store.Backup(backupCtx, filepath.Join(owner.runtimeDirectory(), "before-superagent-"+uid()+".sqlite"))
			if owner.superErr != nil {
				return
			}
		}
		owner.superErr = MigrateSuperagentStore(store.DB)
		if owner.superErr == nil {
			owner.superInitialized.Store(true)
		}
	})
	return store.DB, owner.superErr
}
