package ai

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const recoveryWorkGoalPrefix = "recovery-history-"

type securityRecoveryWorkArchiveRow struct {
	ReadOnlyID                                      string `gorm:"primaryKey"`
	RecoveryID, Source, SourceID, GoalID, SessionID string `gorm:"index"`
}

func (securityRecoveryWorkArchiveRow) TableName() string { return "security_recovery_work_archives" }

type SecurityRecoveryWorkGoal struct {
	RecoveryID     string   `json:"recoveryId"`
	Source         string   `json:"source"`
	SourceID       string   `json:"sourceId"`
	OriginalGoalID string   `json:"originalGoalId"`
	ReadOnlyID     string   `json:"readOnlyId"`
	Goal           WorkGoal `json:"goal"`
}

func IsRecoveryWorkGoalID(id string) bool { return strings.HasPrefix(id, recoveryWorkGoalPrefix) }

func importRecoveryWorkArchives(ctx context.Context, tx *gorm.DB, source *gorm.DB, recoveryID, sourceName, sourceID string) error {
	if !source.Migrator().HasTable(&nativeWorkGoal{}) {
		return nil
	}
	var records []nativeWorkGoal
	if err := source.WithContext(ctx).Select("id,session_id").Limit(50001).Find(&records).Error; err != nil {
		return err
	}
	if len(records) > 50000 {
		return errors.New("security: recovery work archive exceeds bounded import limit")
	}
	for _, record := range records {
		if !identifier.MatchString(record.ID) || !identifier.MatchString(record.SessionID) {
			return errors.New("security: original work goal identity is invalid")
		}
		index := securityRecoveryWorkArchiveRow{ReadOnlyID: recoveryWorkGoalPrefix + hash(recoveryID+"\x00"+sourceID+"\x00"+record.SessionID+"\x00"+record.ID), RecoveryID: recoveryID, Source: sourceName, SourceID: sourceID, GoalID: record.ID, SessionID: record.SessionID}
		if err := tx.Create(&index).Error; err != nil {
			return err
		}
	}
	return nil
}

func openRecoveryWorkSource(ctx context.Context, home string, journal securityRestoreJournal, index securityRecoveryWorkArchiveRow) (*gorm.DB, func(), error) {
	if index.RecoveryID != journal.After.RecoveryID || index.Source != "preserved" && index.Source != "incoming" {
		return nil, nil, errors.New("security: invalid work archive source")
	}
	directory := filepath.Join(home, "security", "recoveries", journal.After.RecoveryID, index.Source)
	cp, err := VerifySecurityCheckpoint(ctx, directory)
	if err != nil {
		return nil, nil, err
	}
	if cp.ID != index.SourceID {
		return nil, nil, errors.New("security: work archive namespace changed")
	}
	raw, err := openSecurityReadOnlyMode(filepath.Join(directory, "adk", "sessions.sqlite"), true)
	if err != nil {
		return nil, nil, err
	}
	db, err := gorm.Open(sqlite.New(sqlite.Config{DriverName: "sqlite", Conn: raw}), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		raw.Close()
		return nil, nil, err
	}
	return db, func() { raw.Close() }, nil
}

func projectRecoveryWorkGoal(row nativeWorkGoal, index securityRecoveryWorkArchiveRow) (SecurityRecoveryWorkGoal, error) {
	var original WorkGoal
	if err := decodeWorkGoal(row, &original); err != nil {
		return SecurityRecoveryWorkGoal{}, err
	}
	if original.ID != row.ID || original.SessionID != "" && original.SessionID != row.SessionID {
		return SecurityRecoveryWorkGoal{}, errors.New("security: original work goal data identity mismatch")
	}
	original.SessionID = row.SessionID
	// IDs with this prefix are lookup-only. Never return a mutable native row
	// with a virtual primary key or alter the original archived goal/attempts.
	original.ID = index.ReadOnlyID
	original.Status = "paused"
	original.ActiveItemID = ""
	return SecurityRecoveryWorkGoal{RecoveryID: index.RecoveryID, Source: index.Source, SourceID: index.SourceID, OriginalGoalID: index.GoalID, ReadOnlyID: index.ReadOnlyID, Goal: original}, nil
}

func readRecoveryWorkArchives(ctx context.Context, home string, tx *gorm.DB, journal securityRestoreJournal, sessionID, readOnlyID string, limit int, omitIdentical bool) ([]SecurityRecoveryWorkGoal, error) {
	if limit < 1 || limit > 1000 || sessionID != "" && !identifier.MatchString(sessionID) {
		return nil, errors.New("security: invalid work archive query")
	}
	query := tx.Where("recovery_id = ?", journal.After.RecoveryID)
	if sessionID != "" {
		query = query.Where("session_id = ?", sessionID)
	}
	if readOnlyID != "" {
		query = query.Where("read_only_id = ?", readOnlyID)
	}
	var indices []securityRecoveryWorkArchiveRow
	if err := query.Order("read_only_id").Limit(limit).Find(&indices).Error; err != nil {
		return nil, err
	}
	out := make([]SecurityRecoveryWorkGoal, 0, len(indices))
	for _, index := range indices {
		source, closeSource, err := openRecoveryWorkSource(ctx, home, journal, index)
		if err != nil {
			return nil, err
		}
		var row nativeWorkGoal
		err = source.WithContext(ctx).First(&row, "id = ? AND session_id = ?", index.GoalID, index.SessionID).Error
		closeSource()
		if err != nil {
			return nil, err
		}
		if omitIdentical {
			var canonical nativeWorkGoal
			if err = tx.First(&canonical, "id = ? AND session_id = ?", row.ID, row.SessionID).Error; err == nil {
				if canonical.Revision == row.Revision && canonical.GoalRevision == row.GoalRevision && canonical.PlanRevision == row.PlanRevision && canonical.ProgressRevision == row.ProgressRevision && canonical.ClosureContract == row.ClosureContract && canonical.Data == row.Data {
					continue
				}
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
		}
		goal, err := projectRecoveryWorkGoal(row, index)
		if err != nil {
			return nil, err
		}
		out = append(out, goal)
	}
	return out, nil
}

func (h *SecurityHome) SecurityRecoveryWorkHistory(ctx context.Context, sessionID string, limit int) (out []SecurityRecoveryWorkGoal, err error) {
	err = h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, journal securityRestoreJournal) error {
		out, err = readRecoveryWorkArchives(ctx, h.Home, tx, journal, sessionID, "", limit, false)
		return err
	})
	return out, err
}

// RecoveryWorkGoalProjections appends immutable history to the existing shape.
// Root WorkGoals must call it after loading canonical goals; all mutations keep
// using native rows and reject/never look up these virtual read-only identities.
func (e *Engine) RecoveryWorkGoalProjections(ctx context.Context, sessionID string, canonical []WorkGoal) ([]WorkGoal, error) {
	h := e.securityHome()
	if h == nil {
		return canonical, nil
	}
	var journal securityRestoreJournal
	if err := privateSecurityRead(filepath.Join(h.Home, "security", "restore.pending.json"), &journal); errors.Is(err, os.ErrNotExist) {
		return canonical, nil
	} else if err != nil {
		return nil, err
	}
	if _, err := ReadRecoveryLedgerIndex(ctx, h.Home); err != nil {
		return nil, err
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	var archived []SecurityRecoveryWorkGoal
	err = store.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var readErr error
		archived, readErr = readRecoveryWorkArchives(ctx, h.Home, tx, journal, sessionID, "", 1000, true)
		return readErr
	})
	if err != nil {
		return nil, err
	}
	for _, goal := range archived {
		canonical = append(canonical, goal.Goal)
	}
	return canonical, nil
}

func (e *Engine) ReadOnlyRecoveryWorkGoal(ctx context.Context, sessionID, id string) (WorkGoal, error) {
	if !IsRecoveryWorkGoalID(id) || !identifier.MatchString(id) {
		return WorkGoal{}, gorm.ErrRecordNotFound
	}
	h := e.securityHome()
	if h == nil {
		return WorkGoal{}, gorm.ErrRecordNotFound
	}
	var journal securityRestoreJournal
	if err := privateSecurityRead(filepath.Join(h.Home, "security", "restore.pending.json"), &journal); err != nil {
		return WorkGoal{}, err
	}
	if _, err := ReadRecoveryLedgerIndex(ctx, h.Home); err != nil {
		return WorkGoal{}, err
	}
	store, err := e.adkStore()
	if err != nil {
		return WorkGoal{}, err
	}
	var goals []SecurityRecoveryWorkGoal
	err = store.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var readErr error
		goals, readErr = readRecoveryWorkArchives(ctx, h.Home, tx, journal, sessionID, id, 1, false)
		return readErr
	})
	if err != nil {
		return WorkGoal{}, err
	}
	if len(goals) != 1 {
		return WorkGoal{}, gorm.ErrRecordNotFound
	}
	return goals[0].Goal, nil
}
