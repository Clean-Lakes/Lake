package ai

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

type securityOperationColumnReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func securityNativeOperationColumns(ctx context.Context, db securityOperationColumnReader) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info(native_operations)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, pk int
		var name, kind string
		var fallback any
		if err = rows.Scan(&cid, &name, &kind, &notNull, &fallback, &pk); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if !columns["id"] || !columns["status"] {
		return nil, errors.New("security: operation identity/status proof unavailable")
	}
	return columns, nil
}

// A known process exit is independent from whether partial effects have been
// reconciled. Use the same predicate for initial inventory, recovery impacts and
// risk/history projections, including stores predating orphan/cancel columns.
func securityUnresolvedOperationPredicate(columns map[string]bool) string {
	parts := []string{"status IS NULL OR status NOT IN ('succeeded','failed','not_executed')"}
	for _, column := range []string{"orphan_state", "closure_state", "cancellation_state"} {
		if columns[column] {
			parts = append(parts, "COALESCE("+column+",'')<>''")
		}
	}
	if columns["cancel_requested_at"] {
		parts = append(parts, "cancel_requested_at IS NOT NULL")
	}
	predicate := "(" + strings.Join(parts, " OR ") + ")"
	if columns["risk_resolved_at"] && columns["closure_state"] {
		predicate = "(" + predicate + " AND NOT (risk_resolved_at IS NOT NULL AND COALESCE(closure_state,'')='reconciled'))"
	}
	return predicate
}
