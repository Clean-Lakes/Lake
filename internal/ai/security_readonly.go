package ai

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

// OpenSecurityReadOnlyHome owns the same locks as an executable runtime, but
// never bootstraps, migrates, reconciles operations, or opens the recovery gate.
// It lets a supported, gate-closed Home expose its existing local history.
func OpenSecurityReadOnlyHome(home, dataDir string) (h *SecurityHome, err error) {
	home, root, err := ResolveSecurityHome(home, dataDir)
	if err != nil {
		return nil, err
	}
	lock, err := AcquireSecurityOwner(home)
	if err != nil {
		return nil, err
	}
	h = &SecurityHome{Home: home, RuntimeRoot: root, lock: lock, readOnly: true}
	defer func() {
		if err != nil {
			h.Close()
		}
	}()
	h.rootLock, err = lockSecurityFile(filepath.Join(filepath.Dir(root), ".security-owner.lock"))
	if err != nil {
		return h, err
	}
	if err = checkLegacyRuntimeOwner(filepath.Join(filepath.Dir(root), "runtime.json")); err != nil {
		return h, err
	}
	h.control, err = ReadSecurityControl(home)
	if err != nil {
		return h, err
	}
	if h.control.Gate != "closed" || h.control.RuntimeRoot != root {
		return h, errors.New("security: recovery view requires a matching closed Home")
	}
	if _, e := os.Lstat(filepath.Join(home, "security", "bootstrap.pending")); !errors.Is(e, os.ErrNotExist) {
		return h, errors.New("security: interrupted identity bootstrap; management required")
	}
	path := filepath.Join(root, "sessions.sqlite")
	info, err := os.Lstat(path)
	if err != nil {
		return h, err
	}
	if !info.Mode().IsRegular() || !platform.Private(path, info) {
		return h, errors.New("security: invalid recovery database")
	}
	h.readOnlyDB, err = openSecurityReadOnly(path)
	if err != nil {
		return h, err
	}
	var exists int
	err = h.readOnlyDB.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='security_schema_meta'").Scan(&exists)
	if err != nil {
		return h, err
	}
	if exists == 0 {
		if h.control.StoreReady {
			return h, errors.New("security: initialized recovery database has no guard")
		}
		// Legacy databases are readable before the first guarded migration. No
		// schema or identity is written here; the pending inventory remains intact.
		return h, nil
	}
	var schema, reader int
	var store, epoch, state string
	err = h.readOnlyDB.QueryRow(`SELECT schema_version,minimum_reader_version,store_id,recovery_epoch,migration_state FROM security_schema_meta WHERE id=1`).Scan(&schema, &reader, &store, &epoch, &state)
	if err != nil {
		return h, err
	}
	if schema != security.SchemaVersion || reader < 1 || reader > security.ReaderVersion || store != h.control.StoreID || epoch != h.control.RecoveryEpoch || state != "ready" {
		return h, errors.New("security: unsupported or mismatched recovery database")
	}
	return h, nil
}

func (h *SecurityHome) ReadOnlyView() bool { return h.readOnly }

func (h *SecurityHome) CheckReadOnlyView() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || !h.readOnly {
		return errors.New("security: recovery view unavailable")
	}
	c, err := ReadSecurityControl(h.Home)
	if err != nil {
		return err
	}
	if c != h.control {
		return errors.New("security: recovery identity changed; restart required")
	}
	root, err := filepath.EvalSymlinks(filepath.Dir(h.RuntimeRoot))
	if err != nil || filepath.Join(root, "adk") != h.RuntimeRoot {
		return errors.New("security: recovery path changed")
	}
	return nil
}

// RecoverySnapshot reads the saved presentation without Engine.get, ADK SDK
// migrations, operation reconciliation, or any background/model/tool runtime.
func (h *SecurityHome) RecoverySnapshot(id string, before, limit int) (View, error) {
	if !identifier.MatchString(id) || before < 0 {
		return View{}, errors.New("invalid recovery session or cursor")
	}
	if err := h.CheckReadOnlyView(); err != nil {
		return View{}, err
	}
	state := State{View: View{Session: id, Status: "idle", Profile: "core", Cards: []Card{}}}
	path := filepath.Join(filepath.Dir(h.RuntimeRoot), "ai", id+".json")
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || !platform.Private(path, info) {
			return View{}, errors.New("invalid recovery session file")
		}
		data, e := os.ReadFile(path)
		if e != nil {
			return View{}, e
		}
		if json.Unmarshal(data, &state) != nil {
			return View{}, errors.New("invalid saved recovery session")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return View{}, err
	}
	view := state.View
	view.Session = id
	var exists int
	if err = h.readOnlyDB.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='native_operations'").Scan(&exists); err != nil {
		return View{}, err
	}
	if exists != 0 {
		rows, e := h.readOnlyDB.Query(`SELECT id,COALESCE(tool,''),COALESCE(target,''),COALESCE(status,''),COALESCE(handle,''),COALESCE(result,''),started_at FROM native_operations WHERE session_id=? AND COALESCE(status,'') NOT IN ('succeeded','failed','not_executed') AND COALESCE(risk,'')<>'readonly' ORDER BY started_at`, id)
		if e != nil {
			return View{}, e
		}
		defer rows.Close()
		view.OperationOutcomes = []OperationOutcome{}
		for rows.Next() {
			var outcome OperationOutcome
			var started sql.NullTime
			if e = rows.Scan(&outcome.ID, &outcome.Tool, &outcome.Target, &outcome.Status, &outcome.Handle, &outcome.Result, &started); e != nil {
				return View{}, e
			}
			outcome.StartedAt = started.Time
			view.OperationOutcomes = append(view.OperationOutcomes, outcome)
		}
		if e = rows.Err(); e != nil {
			return View{}, e
		}
	}
	view.TotalCards = len(view.Cards)
	end := len(view.Cards)
	if before > 0 {
		end = min(before, end)
	}
	start := end
	bytes := 0
	for start > 0 && end-start < bounded(limit, 1, 300) {
		size := len(js(view.Cards[start-1]))
		if end > start && bytes+size > 4<<20 {
			break
		}
		bytes += size
		start--
	}
	view.Cards = append([]Card{}, view.Cards[start:end]...)
	view.CardsOffset = start
	data, err := json.Marshal(view)
	if err != nil {
		return View{}, err
	}
	var snapshot View
	err = json.Unmarshal(safeJSON(data, state.Config), &snapshot)
	return snapshot, err
}
