package ai

import (
	"encoding/json"
	"errors"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

var ErrSuperResourceBusy = errors.New("superagent: resource has another task's running or unresolved operation; this operation was not dispatched")

// The original operation ledger is the conflict lease. Finishing an invocation,
// expiring an assignment or losing a connection never releases unknown effects.
// This runs in the dispatch transaction, before registering/consuming a permit.
func checkSuperResourceConflictsTx(tx *gorm.DB, current security.PreparedOperation) error {
	if current.GoalID == "" || len(current.Resources) == 0 {
		return nil
	}
	var prior []nativeOperation
	if err := tx.Where("goal_id <> ? AND security_descriptor <> '' AND (((status NOT IN ? OR status IS NULL) AND risk_resolved_at IS NULL) OR (orphan_state NOT IN ? AND orphan_state IS NOT NULL AND risk_resolved_at IS NULL) OR (cancel_requested_at IS NOT NULL AND cancellation_state NOT IN ? AND risk_resolved_at IS NULL))", current.GoalID, []string{"succeeded", "failed", "not_executed", "cancelled"}, []string{"", "resolved", "reconciled"}, []string{"stopped", "not_running", "resolved"}).Find(&prior).Error; err != nil {
		return err
	}
	for _, row := range prior {
		var other security.PreparedOperation
		if err := json.Unmarshal([]byte(row.SecurityDescriptor), &other); err != nil {
			return err // An unreadable frozen descriptor cannot prove compatibility.
		}
		if !securityOperationMayMutate(current) && !securityOperationMayMutate(other) {
			continue
		}
		for _, a := range current.Resources {
			for _, b := range other.Resources {
				if a.ID == b.ID {
					return ErrSuperResourceBusy
				}
			}
		}
	}
	return nil
}
