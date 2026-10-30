package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	_ "modernc.org/sqlite"
)

type LegacyStore struct {
	StoreID    string `json:"legacyStoreID"`
	Source     string `json:"source"`
	Snapshot   string `json:"snapshot"`
	SHA256     string `json:"sha256"`
	Operations int64  `json:"operations"`
	Unresolved int64  `json:"unresolved"`
	Sessions   int64  `json:"sessions"`
}
type LegacyInventory struct {
	FormatVersion int           `json:"formatVersion"`
	StoreID       string        `json:"storeID"`
	RecoveryEpoch string        `json:"recoveryEpoch"`
	State         string        `json:"state"`
	Policy        string        `json:"policy,omitempty"`
	Stores        []LegacyStore `json:"stores"`
	CreatedAt     time.Time     `json:"createdAt"`
}

func openSecurityReadOnly(path string) (*sql.DB, error) {
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	q := u.Query()
	q.Set("mode", "ro")
	q.Set("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err = db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// InventoryLegacyStores does not merge SDK tables or change source operations.
// Stable store IDs namespace history from the two formerly independent roots.
func (h *SecurityHome) InventoryLegacyStores(ctx context.Context) (LegacyInventory, error) {
	if h.readOnly {
		return LegacyInventory{}, errors.New("security: recovery view cannot snapshot or migrate stores")
	}
	inv := LegacyInventory{FormatVersion: 1, StoreID: h.control.StoreID, RecoveryEpoch: h.control.RecoveryEpoch, State: "ready", Stores: []LegacyStore{}, CreatedAt: time.Now().UTC()}
	roots := []string{h.RuntimeRoot, filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "adk")}
	for i, root := range roots {
		source := filepath.Join(root, "sessions.sqlite")
		info, err := os.Lstat(source)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return inv, err
		}
		if !info.Mode().IsRegular() {
			return inv, errors.New("security: legacy database must be a regular file")
		}
		if info.Size() == 0 {
			continue
		}
		digest := sha256.Sum256([]byte(source))
		id := hex.EncodeToString(digest[:])
		archiveDir := filepath.Join(h.Home, "security", "legacy", id)
		if err = platform.MkdirAll(archiveDir, 0700); err != nil {
			return inv, err
		}
		// Snapshot first; all inspection below uses the immutable snapshot, never a
		// mixture of separate reads from a changing old database.
		snapshot := filepath.Join(archiveDir, "sessions.sqlite")
		if _, err = os.Lstat(snapshot); errors.Is(err, os.ErrNotExist) {
			if err = snapshotSecurityDatabase(ctx, source, snapshot); err != nil {
				return inv, err
			}
		} else if err != nil {
			return inv, err
		}
		sum, err := hashSecurityArchive(snapshot)
		if err != nil {
			return inv, err
		}
		row := LegacyStore{StoreID: id, Source: source, Snapshot: snapshot, SHA256: sum}
		db, err := openSecurityReadOnly(snapshot)
		if err != nil {
			return inv, err
		}
		err = func() error {
			defer db.Close()
			var integrity string
			if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
				return err
			}
			if integrity != "ok" {
				return errors.New("security: invalid legacy snapshot")
			}
			var n int
			if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_operations'").Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				if err := db.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(CASE WHEN status IS NULL OR status NOT IN ('succeeded','failed','not_executed') THEN 1 ELSE 0 END),0) FROM native_operations`).Scan(&row.Operations, &row.Unresolved); err != nil {
					return err
				}
			}
			// SDK table names are only inspected through sqlite_master. No SDK internal
			// table is rewritten, copied into another store, or used as an authority.
			if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sessions'").Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sessions").Scan(&row.Sessions); err != nil {
					return err
				}
			}
			return nil
		}()
		if err != nil {
			return inv, err
		}
		inv.Stores = append(inv.Stores, row)
		// Until the later resource-level reconciler exists, uncertain migration is
		// conservatively Home-wide. An archive is preservation, not reconciliation.
		if row.Unresolved > 0 || i == 1 {
			inv.State = "pending_review"
		}
	}
	return inv, nil
}
func snapshotSecurityDatabase(ctx context.Context, source, dest string) error {
	db, err := openSecurityReadOnly(source)
	if err != nil {
		return err
	}
	defer db.Close()
	f, err := os.CreateTemp(filepath.Dir(dest), ".snapshot-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Close(); err != nil {
		return err
	}
	if err = platform.Chmod(name, 0600); err != nil {
		return err
	}
	if _, err = db.ExecContext(ctx, "VACUUM INTO ?", name); err != nil {
		return err
	}
	f, err = os.OpenFile(name, os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	err = f.Sync()
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = platform.ReplaceFile(name, dest); err != nil {
		return err
	}
	return platform.SyncDirectory(filepath.Dir(dest))
}
func (h *SecurityHome) MigrateLegacyStores(ctx context.Context) error {
	if h.readOnly {
		return errors.New("security: recovery view cannot migrate stores")
	}
	pending := filepath.Join(h.Home, "security", "legacy-inventory.pending")
	if _, e := os.Lstat(pending); !errors.Is(e, os.ErrNotExist) {
		return errors.New("security: interrupted legacy inventory; management required")
	}
	path := filepath.Join(h.Home, "security", "legacy-inventory.json")
	var previous LegacyInventory
	if err := privateSecurityRead(path, &previous); err == nil {
		if previous.FormatVersion != 1 || previous.StoreID != h.control.StoreID || previous.RecoveryEpoch != h.control.RecoveryEpoch || previous.State != "ready" {
			return errors.New("security: legacy inventory requires management")
		}
		if previous.Policy != "" && previous.Policy != preserveLegacyUnresolved {
			return errors.New("security: unsupported legacy recovery policy")
		}
		if previous.Policy == preserveLegacyUnresolved && (len(previous.Stores) != 1 || previous.Stores[0].Source != filepath.Join(h.RuntimeRoot, "sessions.sqlite")) {
			return errors.New("security: recovery policy is only valid for one canonical store")
		}
		for _, row := range previous.Stores {
			if row.Unresolved > 0 && previous.Policy != preserveLegacyUnresolved {
				return errors.New("security: unresolved legacy history requires explicit adoption")
			}
			digest, err := hashSecurityArchive(row.Snapshot)
			if err != nil {
				return err
			}
			if digest != row.SHA256 {
				return errors.New("security: legacy archive changed")
			}
		}
		// Never silently ignore a stdio store introduced after the initial scan.
		old := filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", "adk", "sessions.sqlite")
		if _, err := os.Lstat(old); err == nil {
			return errors.New("security: late legacy store discovered; management required")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if h.control.StoreReady {
		return errors.New("security: initialized legacy inventory missing; management required")
	}
	if err := writeSecurityJSON(pending, map[string]string{"storeID": h.control.StoreID}); err != nil {
		return err
	}
	inv, err := h.InventoryLegacyStores(ctx)
	if err != nil {
		return err
	}
	if err = writeSecurityJSON(path, inv); err != nil {
		return err
	}
	if err = os.Remove(pending); err != nil {
		return err
	}
	if err = platform.SyncDirectory(filepath.Dir(pending)); err != nil {
		return err
	}
	if inv.State != "ready" {
		h.control.Gate = "closed"
		if err = writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), h.control); err != nil {
			return err
		}
		return fmt.Errorf("security: legacy history preserved; unresolved operations or dual stores require management (gate closed)")
	}
	return nil
}

func hashSecurityArchive(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || !platform.Private(path, info) {
		return "", errors.New("security: invalid private archive")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
