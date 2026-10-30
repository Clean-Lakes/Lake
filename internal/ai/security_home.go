package ai

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

// SecurityHome is shared by all child engines of one backend. Its lock is
// released only after the backend and its external workers have stopped.
type SecurityHome struct {
	Home, RuntimeRoot string
	control           security.ControlState
	lock              *os.File
	rootLock          *os.File
	readOnlyDB        *sql.DB
	readOnly          bool
	mu                sync.Mutex
	closed            bool
}

func securityID() (string, error) {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}

// ResolveSecurityHome resolves aliases before comparing persisted identities.
// Existing Home/DataDir symlinks may be intentional; the manifest fixes their
// canonical targets so changing an alias cannot redirect the runtime later.
func ResolveSecurityHome(home, dataDir string) (string, string, error) {
	if home == "" {
		return "", "", errors.New("security: explicit Home required")
	}
	h, err := canonicalSecurityDir(home)
	if err != nil {
		return "", "", err
	}
	if dataDir == "" {
		// The manifest, not a new CLI's default directory, owns an established root.
		c, e := ReadSecurityControl(h)
		if e == nil {
			dataDir = filepath.Dir(c.RuntimeRoot)
		} else if errors.Is(e, os.ErrNotExist) {
			dataDir = filepath.Join(h, "web-agent")
		} else {
			return "", "", e
		}
	}
	d, err := canonicalSecurityDir(dataDir)
	if err != nil {
		return "", "", err
	}
	root := filepath.Join(d, "adk")
	if info, e := os.Lstat(root); e == nil && !info.IsDir() {
		return "", "", errors.New("security: runtime root must be a real directory")
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return "", "", e
	}
	return h, root, nil
}
func canonicalSecurityDir(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err = platform.MkdirAll(abs, 0700); err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func privateSecurityRead(path string, v any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !platform.Private(path, info) || info.Size() > 4<<20 {
		return errors.New("security: invalid private state file")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	dec := json.NewDecoder(io.LimitReader(f, 4<<20))
	dec.DisallowUnknownFields()
	if err = dec.Decode(v); err != nil {
		return errors.New("security: invalid state JSON")
	}
	var extra any
	if err = dec.Decode(&extra); err != io.EOF {
		return errors.New("security: trailing state data")
	}
	return nil
}
func writeSecurityJSON(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".security-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = platform.Chmod(name, 0600); err == nil {
		_, err = f.Write(append(data, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = platform.ReplaceFile(name, path); err != nil {
		return err
	}
	return platform.SyncDirectory(filepath.Dir(path))
}

func AcquireSecurityOwner(home string) (*os.File, error) {
	dir := filepath.Join(home, "security")
	if err := platform.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || !platform.Owned(info) {
		return nil, errors.New("security: invalid control directory")
	}
	if err = platform.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	return lockSecurityFile(filepath.Join(dir, "owner.lock"))
}

func lockSecurityFile(path string) (*os.File, error) {
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("security: invalid owner lock")
	}
	f, err := platform.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = platform.LockOwner(f); err != nil {
		f.Close()
		return nil, errors.New("security: this Home already has an owner; stop that backend or use an isolated --home")
	}
	if err = platform.Chmod(path, 0600); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// OpenSecurityHome bootstraps only under the exclusive Home owner. Existing
// guarded databases with missing control state are never treated as a new Home.
func OpenSecurityHome(ctx context.Context, home, dataDir string) (h *SecurityHome, err error) {
	home, root, err := ResolveSecurityHome(home, dataDir)
	if err != nil {
		return nil, err
	}
	lock, err := AcquireSecurityOwner(home)
	if err != nil {
		return nil, err
	}
	h = &SecurityHome{Home: home, RuntimeRoot: root, lock: lock}
	defer func() {
		if err != nil {
			// Preserve invalid files as evidence. Only a valid, matching identity may
			// be tightened to closed after a failed bootstrap/reader/migration check.
			if c, e := ReadSecurityControl(h.Home); e == nil && c.StoreID == h.control.StoreID && c.RecoveryEpoch == h.control.RecoveryEpoch {
				c.Gate = "closed"
				_ = writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), c)
			}
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
	path := filepath.Join(home, "security", "control.json")
	err = privateSecurityRead(path, &h.control)
	if errors.Is(err, os.ErrNotExist) {
		// An interrupted first write also requires explicit management, not regeneration.
		if _, e := os.Lstat(filepath.Join(home, "security", "bootstrap.pending")); !errors.Is(e, os.ErrNotExist) {
			return h, errors.New("security: interrupted bootstrap; management required")
		}
		guarded, e := guardedSecurityDatabase(filepath.Join(root, "sessions.sqlite"))
		if e != nil {
			return h, e
		}
		if guarded {
			return h, errors.New("security: control state missing for existing guarded store")
		}
		id, e := securityID()
		if e != nil {
			return h, e
		}
		epoch, e := securityID()
		if e != nil {
			return h, e
		}
		h.control = security.ControlState{FormatVersion: security.ControlFormat, StoreID: id, RecoveryEpoch: epoch, RuntimeRoot: root, Gate: "open"}
		marker := filepath.Join(home, "security", "bootstrap.pending")
		if e = writeSecurityJSON(marker, map[string]string{"storeID": id}); e != nil {
			return h, e
		}
		if e = writeSecurityJSON(path, h.control); e != nil {
			return h, e
		}
		if e = os.Remove(marker); e != nil {
			return h, e
		}
		if e = platform.SyncDirectory(filepath.Dir(path)); e != nil {
			return h, e
		}
	} else if err != nil {
		return h, err
	}
	if err = h.Check(); err != nil {
		return h, err
	}
	if err = h.MigrateLegacyStores(ctx); err != nil {
		return h, err
	}
	// Bind and validate the database before Web/stdio start any background work.
	db, e := storage.OpenChecked(filepath.Join(root, "sessions.sqlite"), h.CheckDatabase)
	if e != nil {
		return h, e
	}
	if e = db.Close(); e != nil {
		return h, e
	}
	h.control.StoreReady = true
	if err = writeSecurityJSON(path, h.control); err != nil {
		return h, err
	}
	return h, nil
}

func ReadSecurityControl(home string) (security.ControlState, error) {
	var state security.ControlState
	err := privateSecurityRead(filepath.Join(home, "security", "control.json"), &state)
	if err == nil {
		err = validateSecurityControl(state)
	}
	return state, err
}
func validateSecurityControl(c security.ControlState) error {
	if c.FormatVersion != security.ControlFormat || len(c.StoreID) != 64 || len(c.RecoveryEpoch) != 64 || !filepath.IsAbs(c.RuntimeRoot) || (c.Gate != "open" && c.Gate != "closed") {
		return errors.New("security: unsupported or invalid control state")
	}
	if _, e := hex.DecodeString(c.StoreID); e != nil {
		return errors.New("security: invalid store identity")
	}
	if _, e := hex.DecodeString(c.RecoveryEpoch); e != nil {
		return errors.New("security: invalid epoch")
	}
	return nil
}
func (h *SecurityHome) Check() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errors.New("security: runtime owner closed")
	}
	if h.readOnly {
		return errors.New("security: read-only recovery view; execution is disabled")
	}
	if _, err := os.Lstat(filepath.Join(h.Home, "security", "bootstrap.pending")); !errors.Is(err, os.ErrNotExist) {
		return errors.New("security: interrupted bootstrap; management required")
	}
	c, err := ReadSecurityControl(h.Home)
	if err != nil {
		return err
	}
	if c.StoreID != h.control.StoreID || c.RecoveryEpoch != h.control.RecoveryEpoch || c.RuntimeRoot != h.RuntimeRoot || c.StoreReady != h.control.StoreReady {
		return errors.New("security: runtime identity or epoch changed")
	}
	actual, err := filepath.EvalSymlinks(filepath.Dir(h.RuntimeRoot))
	if err != nil || filepath.Join(actual, "adk") != h.RuntimeRoot {
		return errors.New("security: runtime path changed")
	}
	if c.StoreReady {
		info, err := os.Lstat(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("security: initialized database missing or replaced; management required")
		}
	}
	if info, err := os.Lstat(h.RuntimeRoot); err == nil && !info.IsDir() {
		return errors.New("security: runtime root changed")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if c.Gate != "open" {
		return errors.New("security: recovery gate closed; management required")
	}
	return nil
}
func (h *SecurityHome) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil
	}
	h.closed = true
	if h.readOnlyDB != nil {
		_ = h.readOnlyDB.Close()
	}
	if h.rootLock != nil {
		_ = h.rootLock.Close()
	}
	return h.lock.Close()
}

// RotateRecoveryEpoch always closes the gate before any future restore work.
// There is deliberately no generic "open gate" operation in this foundation.
func (h *SecurityHome) RotateRecoveryEpoch() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return errors.New("security: runtime owner closed")
	}
	if h.readOnly {
		return errors.New("security: recovery view cannot change control state")
	}
	c, err := ReadSecurityControl(h.Home)
	if err != nil {
		return err
	}
	if c.StoreID != h.control.StoreID || c.RecoveryEpoch != h.control.RecoveryEpoch {
		return errors.New("security: stale restore owner")
	}
	c.RecoveryEpoch, err = securityID()
	if err != nil {
		return err
	}
	c.RecoveryID, err = securityID()
	if err != nil {
		return err
	}
	c.Gate = "closed"
	return writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), c)
}
func (h *SecurityHome) CheckDatabase(db *sql.DB) error {
	if err := h.Check(); err != nil {
		return err
	}
	return h.bindSecurityDatabase(db)
}

// bindSecurityDatabase is also used by the offline initial-migration recovery
// while its owner holds the gate closed. It never dispatches agent work.
func (h *SecurityHome) bindSecurityDatabase(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS security_schema_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, minimum_reader_version INTEGER NOT NULL, store_id TEXT NOT NULL, recovery_epoch TEXT NOT NULL, migration_state TEXT NOT NULL)`)
	if err != nil {
		return err
	}
	var schema, reader int
	var store, epoch, state string
	err = db.QueryRow(`SELECT schema_version,minimum_reader_version,store_id,recovery_epoch,migration_state FROM security_schema_meta WHERE id=1`).Scan(&schema, &reader, &store, &epoch, &state)
	if errors.Is(err, sql.ErrNoRows) {
		_, err = db.Exec(`INSERT INTO security_schema_meta VALUES(1,?,?,?,?,?)`, security.SchemaVersion, security.ReaderVersion, h.control.StoreID, h.control.RecoveryEpoch, "ready")
		return err
	}
	if err != nil {
		return err
	}
	if schema != security.SchemaVersion || reader > security.ReaderVersion || store != h.control.StoreID || epoch != h.control.RecoveryEpoch || state != "ready" {
		return errors.New("security: store guard mismatch; management required")
	}
	return nil
}
func (e *Engine) securityHome() *SecurityHome {
	if e.workParent != nil {
		return e.workParent.securityHome()
	}
	if e.worker != nil {
		return e.worker.parent.securityHome()
	}
	return e.SecurityRuntime
}
func (e *Engine) CheckSecurityRuntime() error {
	if h := e.securityHome(); h != nil {
		return h.Check()
	}
	return nil
}
func guardedSecurityDatabase(path string) (bool, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	db, err := openSecurityReadOnly(path)
	if err != nil {
		return false, err
	}
	defer db.Close()
	var n int
	err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='security_schema_meta'").Scan(&n)
	return n > 0, err
}

// Older Web backends predate owner locks. Preserve a live/reused PID record
// instead of starting a competing writer against its database.
func checkLegacyRuntimeOwner(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !platform.Private(path, info) || info.Size() > 65536 {
		return errors.New("security: invalid backend runtime record; inspect it before starting")
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var state struct {
		PID int `json:"pid"`
	}
	if err = json.NewDecoder(io.LimitReader(f, 65536)).Decode(&state); err != nil || state.PID <= 0 {
		return errors.New("security: invalid backend PID record; inspect it before starting")
	}
	alive, err := platform.ProcessRunning(state.PID)
	if err != nil {
		return err
	}
	if alive {
		return errors.New("security: backend PID is still alive; stop or verify the recorded process before starting")
	}
	return nil
}
