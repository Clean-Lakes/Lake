package ai

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

type securityImportBootstrap struct {
	FormatVersion int                   `json:"formatVersion"`
	Source        string                `json:"source"`
	ManifestHash  string                `json:"manifestHash"`
	Control       security.ControlState `json:"control"`
}

// bootstrapSecurityImportTarget runs only under all three offline owner locks.
// A verified import may initialize a genuinely empty target. Its first durable
// control is closed, and it invokes only the public SDK store migrator, never an
// Engine, provider or worker. A source-bound marker makes interruption resumable
// without treating arbitrary missing-control data as an empty installation.
func bootstrapSecurityImportTarget(ctx context.Context, home, root, source, manifestHash string, control security.ControlState, controlErr error, stop func(string) error) (security.ControlState, error) {
	path := filepath.Join(home, "security", "import-bootstrap.pending.json")
	var marker securityImportBootstrap
	err := privateSecurityRead(path, &marker)
	if errors.Is(err, os.ErrNotExist) {
		if controlErr == nil {
			return control, nil
		}
		if !errors.Is(controlErr, os.ErrNotExist) {
			return control, controlErr
		}
		if err = verifyEmptySecurityImportTarget(home, false); err != nil {
			return control, err
		}
		id, e := securityID()
		if e != nil {
			return control, e
		}
		epoch, e := securityID()
		if e != nil {
			return control, e
		}
		marker = securityImportBootstrap{FormatVersion: 1, Source: source, ManifestHash: manifestHash, Control: security.ControlState{FormatVersion: security.ControlFormat, StoreID: id, RecoveryEpoch: epoch, RuntimeRoot: root, Gate: "closed"}}
		if err = writeSecurityJSON(path, marker); err != nil {
			return control, err
		}
	} else if err != nil {
		return control, err
	}
	if marker.FormatVersion != 1 || marker.Source != source || marker.ManifestHash != manifestHash || marker.Control.RuntimeRoot != root || marker.Control.Gate != "closed" || marker.Control.StoreReady || marker.Control.RecoveryID != "" || validateSecurityControl(marker.Control) != nil {
		return control, errors.New("security: import bootstrap identity mismatch")
	}
	if controlErr == nil {
		current := control
		current.StoreReady = false
		if current != marker.Control {
			return control, errors.New("security: import bootstrap owner changed")
		}
	} else if !errors.Is(controlErr, os.ErrNotExist) {
		return control, controlErr
	}
	if err = verifyEmptySecurityImportTarget(home, true); err != nil {
		return control, err
	}
	control = marker.Control
	controlPath := filepath.Join(home, "security", "control.json")
	if err = writeSecurityJSON(controlPath, control); err != nil {
		return control, err
	}
	if err = ctx.Err(); err != nil {
		return control, err
	}
	if stop != nil {
		if err = stop("import_gate_closed"); err != nil {
			return control, err
		}
	}
	h := &SecurityHome{Home: home, RuntimeRoot: root, control: control}
	db, err := storage.OpenChecked(filepath.Join(root, "sessions.sqlite"), h.bindSecurityDatabase)
	if err != nil {
		return control, err
	}
	if err = db.Close(); err != nil {
		return control, err
	}
	for _, directory := range []string{root, filepath.Dir(root), home} {
		if err = platform.SyncDirectory(directory); err != nil {
			return control, err
		}
	}
	if stop != nil {
		if err = stop("import_store_initialized"); err != nil {
			return control, err
		}
	}
	inv := LegacyInventory{FormatVersion: 1, StoreID: control.StoreID, RecoveryEpoch: control.RecoveryEpoch, State: "ready", Stores: []LegacyStore{}, CreatedAt: time.Now().UTC()}
	if err = writeSecurityJSON(filepath.Join(home, "security", "legacy-inventory.json"), inv); err != nil {
		return control, err
	}
	control.StoreReady = true
	if err = writeSecurityJSON(controlPath, control); err != nil {
		return control, err
	}
	if err = os.Remove(path); err != nil {
		return control, err
	}
	return control, platform.SyncDirectory(filepath.Dir(path))
}

func verifyEmptySecurityImportTarget(home string, resuming bool) error {
	return filepath.WalkDir(home, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(home, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() && (rel == "." || rel == "security" || rel == "web-agent" || resuming && rel == "web-agent/adk") {
			return nil
		}
		allowed := rel == "security/owner.lock" || rel == "web-agent/.security-owner.lock" || rel == "web-agent/server.lock"
		if resuming {
			allowed = allowed || rel == "security/import-bootstrap.pending.json" || rel == "security/control.json" || rel == "security/legacy-inventory.json" || rel == "web-agent/adk/sessions.sqlite" || rel == "web-agent/adk/sessions.sqlite-journal" || rel == "web-agent/adk/sessions.sqlite-wal" || rel == "web-agent/adk/sessions.sqlite-shm"
		}
		if !allowed || !entry.Type().IsRegular() {
			return errors.New("security: import initialization requires an empty target; existing data needs explicit initialized-store recovery")
		}
		return nil
	})
}
