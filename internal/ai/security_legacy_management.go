package ai

import (
	"context"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
	"time"
)

type SecurityLegacyPolicy struct {
	ProjectID, SessionID, Source string
	Revision                     int64
	Permissions                  Permissions
}
type SecurityLegacyPolicyAction struct {
	SecurityPolicyAction
	SessionID   string
	Permissions Permissions
}

func (e *Engine) SecurityLegacySessionPolicy(ctx context.Context, projectID, sessionID string) (out SecurityLegacyPolicy, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	row, source, err := effectiveLegacyPolicyTx(db.WithContext(ctx), projectID, sessionID, storeID, epoch)
	if err != nil {
		return out, err
	}
	out = SecurityLegacyPolicy{ProjectID: projectID, SessionID: sessionID, Source: row.Source, Revision: row.Revision}
	if source != "" {
		out.Source = "pilot:" + source
	}
	err = decodeSecurityJSON(row.Data, &out.Permissions)
	return out, err
}

// This is an explicit authenticated settings action. Generic Configure and a
// project's defaults cannot call it implicitly or refresh another session.
func (e *Engine) UpdateSecurityLegacySessionPolicy(ctx context.Context, a SecurityLegacyPolicyAction) (out SecurityLegacyPolicy, err error) {
	if !validPolicyAction(a.SecurityPolicyAction) || a.SessionID == "" || a.ExpectedRevision < 1 {
		return out, errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := js(a)
			replay, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &out)
			if replay || err != nil {
				return err
			}
			policy, err := loadSecurityPolicy(tx, a.ProjectID, storeID, epoch)
			if err != nil {
				return err
			}
			if policy.Mode != "legacy" {
				return errSecurityAction
			}
			_, source, err := effectiveLegacyPolicyTx(tx, a.ProjectID, a.SessionID, storeID, epoch)
			if err != nil {
				return err
			}
			if source != "" {
				return errors.New("专员权限由 Pilot 统一管理")
			}
			var row securityLegacySessionPolicyRow
			if err = tx.First(&row, "session_id = ? AND project_id = ? AND store_id = ? AND recovery_epoch = ?", a.SessionID, a.ProjectID, storeID, epoch).Error; err != nil {
				return err
			}
			if row.Revision != a.ExpectedRevision {
				return security.ErrConflict
			}
			result := tx.Model(&securityLegacySessionPolicyRow{}).Where("session_id = ? AND revision = ?", row.SessionID, row.Revision).Updates(map[string]any{"data": js(a.Permissions), "revision": row.Revision + 1})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return security.ErrConflict
			}
			out = SecurityLegacyPolicy{ProjectID: row.ProjectID, SessionID: row.SessionID, Source: row.Source, Revision: row.Revision + 1, Permissions: a.Permissions}
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "legacy.policy.update", row.SessionID, request, row.Revision, out.Revision, out, time.Now().UTC(), row.ProjectID)
		})
	})
	return out, err
}
