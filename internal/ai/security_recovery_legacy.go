package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type securityRecoveryLegacyReviewRow struct {
	ID                                      string `gorm:"primaryKey"`
	RecoveryID, SessionID, ProjectID        string `gorm:"index"`
	SourceDigest, PriorPolicies             string
	MaximumPriorRevision, ConfirmedRevision int64
	Confirmed                               bool
}

func (securityRecoveryLegacyReviewRow) TableName() string { return "security_recovery_legacy_reviews" }

type SecurityRecoveryLegacySource struct {
	Snapshot    string      `json:"snapshot"`
	Source      string      `json:"source"`
	Revision    int64       `json:"revision"`
	Permissions Permissions `json:"permissions"`
}
type SecurityRecoveryLegacyPolicy struct {
	SessionID         string                         `json:"sessionId"`
	ProjectID         string                         `json:"projectId"`
	SourceDigest      string                         `json:"sourceDigest"`
	PriorPolicies     []SecurityRecoveryLegacySource `json:"priorPolicies"`
	Confirmed         bool                           `json:"confirmed"`
	ConfirmedRevision int64                          `json:"confirmedRevision"`
}
type SecurityRecoveryLegacyConfirmation struct {
	Action       SecurityRecoveryAction `json:"action"`
	SessionID    string                 `json:"sessionId"`
	SourceDigest string                 `json:"sourceDigest"`
	Permissions  Permissions            `json:"permissions"`
}

func importRecoveryLegacyPolicies(ctx context.Context, tx *gorm.DB, source *sql.DB, recoveryID, sourceName string) error {
	var exists int
	if err := source.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='security_legacy_session_policies'").Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return nil
	}
	rows, err := source.QueryContext(ctx, "SELECT session_id,project_id,source,revision,data FROM security_legacy_session_policies ORDER BY session_id")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var session, project, origin, data string
		var revision int64
		if err = rows.Scan(&session, &project, &origin, &revision, &data); err != nil {
			return err
		}
		if !identifier.MatchString(session) || origin != "web" && origin != "standalone" || revision < 1 {
			return errors.New("security: invalid legacy session policy")
		}
		var p Permissions
		if err = decodeSecurityJSON(data, &p); err != nil {
			return err
		}
		id := hash(recoveryID + "\x00legacy\x00" + session)
		var row securityRecoveryLegacyReviewRow
		if err = tx.First(&row, "id = ?", id).Error; errors.Is(err, gorm.ErrRecordNotFound) {
			row = securityRecoveryLegacyReviewRow{ID: id, RecoveryID: recoveryID, SessionID: session, ProjectID: project}
		} else if err != nil {
			return err
		}
		if row.ProjectID != project {
			return errors.New("security: legacy policy session project conflict")
		}
		var prior []SecurityRecoveryLegacySource
		if row.PriorPolicies != "" {
			if err = json.Unmarshal([]byte(row.PriorPolicies), &prior); err != nil {
				return err
			}
		}
		prior = append(prior, SecurityRecoveryLegacySource{Snapshot: sourceName, Source: origin, Revision: revision, Permissions: p})
		row.PriorPolicies = js(prior)
		row.SourceDigest = hash(row.SourceDigest + "\x00" + sourceName + "\x00" + data)
		row.MaximumPriorRevision = max(row.MaximumPriorRevision, revision)
		if err = tx.Save(&row).Error; err != nil {
			return err
		}
	}
	return rows.Err()
}

func appendRecoveryLegacyReviews(tx *gorm.DB, out *SecurityRecoveryReview) error {
	var rows []securityRecoveryLegacyReviewRow
	if err := tx.Where("recovery_id = ?", out.RecoveryID).Order("session_id").Find(&rows).Error; err != nil {
		return err
	}
	out.LegacyPolicies = []SecurityRecoveryLegacyPolicy{}
	for _, row := range rows {
		var prior []SecurityRecoveryLegacySource
		if err := json.Unmarshal([]byte(row.PriorPolicies), &prior); err != nil {
			return err
		}
		out.LegacyPolicies = append(out.LegacyPolicies, SecurityRecoveryLegacyPolicy{SessionID: row.SessionID, ProjectID: row.ProjectID, SourceDigest: row.SourceDigest, PriorPolicies: prior, Confirmed: row.Confirmed, ConfirmedRevision: row.ConfirmedRevision})
		if !row.Confirmed {
			out.ReviewComplete = false
			out.ReadyForActivation = false
		}
	}
	return nil
}

func legacyPermissionsNarrower(p, old Permissions) bool {
	return (!p.SilentReadFiles || old.SilentReadFiles) && (!p.SilentWriteFiles || old.SilentWriteFiles) && (!p.SilentReadSQL || old.SilentReadSQL) && (!p.SilentCommands || old.SilentCommands) && (!p.SilentTerminalCreation || old.SilentTerminalCreation) && (p.BlockUnreferencedAssets || !old.BlockUnreferencedAssets) && (p.DenyLocalExecution || !old.DenyLocalExecution)
}

func (h *SecurityHome) ConfirmSecurityRecoveryLegacyPolicy(ctx context.Context, in SecurityRecoveryLegacyConfirmation) (out SecurityRecoveryReview, err error) {
	request := js(in)
	err = h.withSecurityRecoveryReview(ctx, func(tx *gorm.DB, journal securityRestoreJournal) error {
		if repeated, actionErr := recoveryActionBegin(tx, journal, in.Action, request, &out); repeated || actionErr != nil {
			return actionErr
		}
		var row securityRecoveryLegacyReviewRow
		if actionErr := tx.First(&row, "recovery_id = ? AND session_id = ?", journal.After.RecoveryID, in.SessionID).Error; actionErr != nil {
			return actionErr
		}
		if row.SourceDigest != in.SourceDigest || row.Confirmed {
			return security.ErrConflict
		}
		var prior []SecurityRecoveryLegacySource
		if actionErr := json.Unmarshal([]byte(row.PriorPolicies), &prior); actionErr != nil {
			return actionErr
		}
		if len(prior) == 0 {
			return errors.New("security: original legacy policy missing")
		}
		for _, old := range prior {
			if !legacyPermissionsNarrower(in.Permissions, old.Permissions) {
				return errors.New("security: recovery cannot revive a newer denial or broaden original session permissions")
			}
		}
		policy := securityLegacySessionPolicyRow{SessionID: row.SessionID, ProjectID: row.ProjectID, StoreID: journal.After.StoreID, RecoveryEpoch: journal.After.RecoveryEpoch, Source: prior[0].Source, Revision: row.MaximumPriorRevision + 1, Data: js(in.Permissions)}
		if actionErr := tx.Save(&policy).Error; actionErr != nil {
			return actionErr
		}
		if actionErr := tx.Model(&securityRecoveryLegacyReviewRow{}).Where("id = ? AND confirmed = ?", row.ID, false).Updates(map[string]any{"confirmed": true, "confirmed_revision": policy.Revision}).Error; actionErr != nil {
			return actionErr
		}
		var actionErr error
		out, actionErr = recoveryActionCommit(tx, journal, in.Action, "recovery.legacy.confirm", row.SessionID, request, time.Now().UTC())
		return actionErr
	})
	return out, err
}

func ConfirmSecurityRecoveryLegacyPolicyOffline(ctx context.Context, home string, in SecurityRecoveryLegacyConfirmation) (SecurityRecoveryReview, error) {
	h, err := OpenSecurityReadOnlyHome(home, "")
	if err != nil {
		return SecurityRecoveryReview{}, err
	}
	defer h.Close()
	in.Action.ActorID = "local-user"
	return h.ConfirmSecurityRecoveryLegacyPolicy(ctx, in)
}
