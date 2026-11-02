package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
)

// References are namespaced hashes, not resource identities or permission.
// Never export arbitrary legacy targets, commands, results, handles or IDs:
// those fields can contain credentials even when a Config is unavailable.
type SecurityOperationRisk struct {
	OperationRef string `json:"operationRef"`
	SessionRef   string `json:"sessionRef,omitempty"`
	ToolRef      string `json:"toolRef,omitempty"`
	TargetRef    string `json:"targetRef,omitempty"`
	Status       string `json:"status"`
	RecordedRisk string `json:"recordedRisk"`
	HasHandle    bool   `json:"hasHandle"`
}

type SecurityRiskStore struct {
	LegacyStoreID string                  `json:"legacyStoreID"`
	View          string                  `json:"view"` // current or archived
	Operations    int64                   `json:"operations"`
	Unresolved    int64                   `json:"unresolved"`
	EffectReview  int64                   `json:"effectReview"`
	Truncated     bool                    `json:"truncated"`
	Risks         []SecurityOperationRisk `json:"risks"`
}

type SecurityRiskReport struct {
	FormatVersion int                 `json:"formatVersion"`
	StoreID       string              `json:"storeID"`
	RecoveryEpoch string              `json:"recoveryEpoch"`
	Gate          string              `json:"gate"`
	LimitPerStore int                 `json:"limitPerStore"`
	ResourceMap   string              `json:"resourceMapping"`
	Stores        []SecurityRiskStore `json:"stores"`
}

func securityRiskRef(namespace, kind, value string) string {
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(namespace + "\x00" + kind + "\x00" + value))
	return hex.EncodeToString(digest[:])
}

func legacySecurityStoreID(source string) string {
	digest := sha256.Sum256([]byte(source))
	return hex.EncodeToString(digest[:])
}

// InspectSecurityRisks is a trusted offline host read, not an agent tool. It
// never opens Engine/SDK storage, reconciles operations, writes a risk ledger,
// changes the gate or resolves a side effect. The caller must stop the Home's
// backend first; the same Home/DataDir locks fence competing owners.
func InspectSecurityRisks(ctx context.Context, home string, limit int) (SecurityRiskReport, error) {
	var out SecurityRiskReport
	if home == "" || limit < 1 || limit > 1000 {
		return out, errors.New("security: explicit Home and limit between 1 and 1000 required")
	}
	if err := ctx.Err(); err != nil {
		return out, err
	}
	// Inspection must not bootstrap an accidentally misspelled Home.
	if _, err := ReadSecurityControl(home); err != nil {
		return out, errors.New("security: inspection requires existing valid control state")
	}
	h, err := openSecurityReadOnlyHome(home, "", true)
	if err != nil {
		return out, err
	}
	defer h.Close()
	if err = h.CheckReadOnlyView(); err != nil {
		return out, err
	}
	var inv LegacyInventory
	if err = privateSecurityRead(filepath.Join(h.Home, "security", "legacy-inventory.json"), &inv); err != nil {
		return out, errors.New("security: inspection requires a preserved legacy inventory")
	}
	if inv.FormatVersion != 1 || inv.StoreID != h.control.StoreID || inv.RecoveryEpoch != h.control.RecoveryEpoch || (inv.State != "ready" && inv.State != "pending_review") || len(inv.Stores) > 2 || (inv.Policy != "" && inv.Policy != preserveLegacyUnresolved) {
		return out, errors.New("security: invalid legacy inventory identity or version")
	}
	canonical := filepath.Join(h.RuntimeRoot, "sessions.sqlite")
	stdio := filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "adk", "sessions.sqlite")
	if inv.Policy == preserveLegacyUnresolved && (len(inv.Stores) != 1 || inv.Stores[0].Source != canonical || inv.State != "ready") {
		return out, errors.New("security: invalid single-store recovery policy")
	}
	out = SecurityRiskReport{FormatVersion: 1, StoreID: h.control.StoreID, RecoveryEpoch: h.control.RecoveryEpoch, Gate: h.control.Gate, LimitPerStore: limit, ResourceMap: "unverified", Stores: []SecurityRiskStore{}}
	seen := map[string]bool{}
	for _, entry := range inv.Stores {
		if entry.Source != canonical && entry.Source != stdio || seen[entry.Source] || entry.StoreID != legacySecurityStoreID(entry.Source) {
			return SecurityRiskReport{}, errors.New("security: invalid legacy store namespace")
		}
		seen[entry.Source] = true
		archive := filepath.Join(h.Home, "security", "legacy", entry.StoreID, "sessions.sqlite")
		recovery := filepath.Join(h.Home, "security", "initial-migration-recovery", "sessions.sqlite")
		if entry.Snapshot != archive && !(entry.Snapshot == recovery && entry.Source == canonical && len(inv.Stores) == 1 && inv.Policy == preserveLegacyUnresolved) {
			return SecurityRiskReport{}, errors.New("security: invalid legacy snapshot location")
		}
		resolved, e := filepath.EvalSymlinks(entry.Snapshot)
		if e != nil || resolved != entry.Snapshot {
			return SecurityRiskReport{}, errors.New("security: legacy snapshot path changed")
		}
		digest, e := hashSecurityArchive(entry.Snapshot)
		if e != nil || digest != entry.SHA256 {
			return SecurityRiskReport{}, errors.New("security: legacy snapshot checksum mismatch")
		}
		for _, suffix := range []string{"-wal", "-journal"} {
			if _, e = os.Lstat(entry.Snapshot + suffix); !errors.Is(e, os.ErrNotExist) {
				return SecurityRiskReport{}, errors.New("security: legacy snapshot has unverified journal state")
			}
		}
		db, e := openSecurityReadOnlyMode(entry.Snapshot, true)
		if e != nil {
			return SecurityRiskReport{}, errors.New("security: legacy snapshot unavailable")
		}
		row, e := inspectSecurityRiskStore(ctx, db, entry.StoreID, "archived", limit)
		db.Close()
		if e != nil {
			return SecurityRiskReport{}, e
		}
		if digest, e = hashSecurityArchive(entry.Snapshot); e != nil || digest != entry.SHA256 {
			return SecurityRiskReport{}, errors.New("security: legacy snapshot changed during inspection")
		}
		if row.Operations != entry.Operations || row.Unresolved != entry.Unresolved {
			return SecurityRiskReport{}, errors.New("security: legacy snapshot counts mismatch")
		}
		if entry.Source == canonical && entry.Operations > 0 {
			if h.readOnlyDB == nil {
				return SecurityRiskReport{}, errors.New("security: canonical operation store missing")
			}
			if e = verifyCanonicalRiskHistory(ctx, h.readOnlyDB, entry.Snapshot); e != nil {
				return SecurityRiskReport{}, e
			}
		}
		// A canonical archive preserves the migration baseline. Its current
		// operations are read below, so resolved history is not double-counted.
		if entry.Source == stdio {
			out.Stores = append(out.Stores, row)
		}
	}
	// A late/uninventoried stdio store cannot disappear from an apparently
	// complete report. It requires management, never an automatic merge.
	if _, err = os.Lstat(stdio); !errors.Is(err, os.ErrNotExist) && !seen[stdio] {
		return SecurityRiskReport{}, errors.New("security: unindexed legacy store requires management")
	}
	if h.readOnlyDB != nil {
		row, e := inspectSecurityRiskStore(ctx, h.readOnlyDB, legacySecurityStoreID(canonical), "current", limit)
		if e != nil {
			return SecurityRiskReport{}, e
		}
		out.Stores = append([]SecurityRiskStore{row}, out.Stores...)
	} else if seen[canonical] {
		return SecurityRiskReport{}, errors.New("security: canonical operation store missing")
	}
	if err = h.CheckReadOnlyView(); err != nil {
		return SecurityRiskReport{}, err
	}
	return out, nil
}

func verifyCanonicalRiskHistory(ctx context.Context, db *sql.DB, snapshot string) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	// ATTACH only changes this private read-only connection's schema names.
	// The path was allowlisted and hashed above; both files stay read-only.
	if _, err = conn.ExecContext(ctx, "ATTACH DATABASE ? AS legacy_risk_baseline", securityReadOnlyURI(snapshot, true)); err != nil {
		return errors.New("security: legacy operation baseline unavailable")
	}
	defer conn.ExecContext(context.Background(), "DETACH DATABASE legacy_risk_baseline")
	var missing int64
	if err = conn.QueryRowContext(ctx, `SELECT count(*) FROM legacy_risk_baseline.native_operations old LEFT JOIN main.native_operations current ON current.id=old.id WHERE current.id IS NULL`).Scan(&missing); err != nil || missing != 0 {
		return errors.New("security: canonical operation history missing; management required")
	}
	return nil
}

func inspectSecurityRiskStore(ctx context.Context, db *sql.DB, namespace, view string, limit int) (SecurityRiskStore, error) {
	out := SecurityRiskStore{LegacyStoreID: namespace, View: view, Risks: []SecurityOperationRisk{}}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	var integrity string
	if err = tx.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil || integrity != "ok" {
		return out, errors.New("security: invalid operation store integrity")
	}
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_operations'").Scan(&exists); err != nil {
		return out, err
	}
	if exists == 0 {
		return out, nil
	}
	columns := map[string]bool{}
	rows, err := tx.QueryContext(ctx, "PRAGMA table_info(native_operations)")
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var cid, notNull, pk int
		var name, kind string
		var defaultValue any
		if err = rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &pk); err != nil {
			rows.Close()
			return out, err
		}
		columns[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	if !columns["id"] || !columns["status"] {
		return out, errors.New("security: legacy operation identity or status schema unavailable")
	}
	// Only static, inspected column names enter SQL. Metadata strings are
	// projected to hashes or closed enums below, never emitted as raw text.
	field := func(name string) string {
		if columns[name] {
			return "COALESCE(" + name + ",'')"
		}
		return "''"
	}
	risk := field("risk")
	unresolved := "(status IS NULL OR status NOT IN ('succeeded','failed','not_executed'))"
	if err = tx.QueryRowContext(ctx, "SELECT count(*),COALESCE(sum(CASE WHEN "+unresolved+" THEN 1 ELSE 0 END),0),COALESCE(sum(CASE WHEN "+unresolved+" AND ("+risk+"<>'readonly' OR COALESCE(status,'') NOT IN ('unknown','dispatched','running')) THEN 1 ELSE 0 END),0) FROM native_operations").Scan(&out.Operations, &out.Unresolved, &out.EffectReview); err != nil {
		return out, errors.New("security: operation counts unavailable")
	}
	var invalid int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM (SELECT id FROM native_operations GROUP BY id HAVING id IS NULL OR typeof(id)<>'text' OR id='' OR length(id)>4096 OR count(*)>1)").Scan(&invalid); err != nil || invalid != 0 {
		return out, errors.New("security: ambiguous legacy operation identity")
	}
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM native_operations WHERE length("+field("session_id")+")>1048576 OR length("+field("tool")+")>1048576 OR length("+field("target")+")>1048576 OR length(COALESCE(status,''))>4096 OR length("+risk+")>4096").Scan(&invalid); err != nil || invalid != 0 {
		return out, errors.New("security: oversized operation risk metadata")
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,"+field("session_id")+","+field("tool")+","+field("target")+",COALESCE(status,''),"+risk+",CASE WHEN "+field("handle")+"<>'' THEN 1 ELSE 0 END FROM native_operations WHERE "+unresolved+" ORDER BY id LIMIT ?", limit)
	if err != nil {
		return out, errors.New("security: operation risk projection unavailable")
	}
	defer rows.Close()
	for rows.Next() {
		var id, session, tool, target, status, recordedRisk string
		var handle bool
		if err = rows.Scan(&id, &session, &tool, &target, &status, &recordedRisk, &handle); err != nil {
			return out, errors.New("security: invalid operation risk metadata")
		}
		switch status {
		case "unknown", "dispatched", "running":
		default:
			status = "unrecognized"
		}
		switch recordedRisk {
		case "readonly", "write", "dangerous":
		default:
			recordedRisk = "unclassified"
		}
		out.Risks = append(out.Risks, SecurityOperationRisk{OperationRef: securityRiskRef(namespace, "operation", id), SessionRef: securityRiskRef(namespace, "session", session), ToolRef: securityRiskRef(namespace, "tool", tool), TargetRef: securityRiskRef(namespace, "target", target), Status: status, RecordedRisk: recordedRisk, HasHandle: handle})
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	out.Truncated = out.Unresolved > int64(len(out.Risks))
	return out, nil
}
