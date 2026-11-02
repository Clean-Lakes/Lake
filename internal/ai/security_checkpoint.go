package ai

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

const securityCheckpointFormat = 1

// SecurityCheckpoint is a paired, offline snapshot. The live control file is
// deliberately excluded: restoring an old checkpoint must never restore its
// authority epoch. A manifest is only published after every member is durable.
type SecurityCheckpoint struct {
	FormatVersion int                      `json:"formatVersion"`
	ID            string                   `json:"id"`
	StoreID       string                   `json:"storeID"`
	RecoveryEpoch string                   `json:"recoveryEpoch"`
	CreatedAt     time.Time                `json:"createdAt"`
	Files         []SecurityCheckpointFile `json:"files"`
}

type SecurityCheckpointFile struct {
	Path              string `json:"path"`
	Kind              string `json:"kind"`
	Present           bool   `json:"present"`
	SHA256            string `json:"sha256,omitempty"`
	Size              int64  `json:"size,omitempty"`
	SQLiteUserVersion int64  `json:"sqliteUserVersion,omitempty"`
	SchemaSHA256      string `json:"schemaSHA256,omitempty"`
}

// CreateSecurityCheckpoint requires an offline Home and uses SQLite consistent
// snapshots, including committed WAL data. It never reads the secret directory,
// contacts providers/resources, migrates the SDK, or changes the execution gate.
func CreateSecurityCheckpoint(ctx context.Context, home, destination string) (SecurityCheckpoint, error) {
	h, err := openSecurityReadOnlyHome(home, "", true)
	if err != nil {
		return SecurityCheckpoint{}, err
	}
	defer h.Close()
	if !h.control.StoreReady || h.readOnlyDB == nil {
		return SecurityCheckpoint{}, errors.New("security: checkpoint requires an initialized canonical store")
	}
	if err = h.CheckReadOnlyView(); err != nil {
		return SecurityCheckpoint{}, err
	}
	webLock, err := lockSecurityFile(filepath.Join(filepath.Dir(h.RuntimeRoot), "server.lock"))
	if err != nil {
		return SecurityCheckpoint{}, err
	}
	defer webLock.Close()
	return writeSecurityCheckpoint(ctx, filepath.Dir(h.RuntimeRoot), destination, h.control)
}

func checkpointFileAllowed(path, kind string) bool {
	if path == "adk/sessions.sqlite" || path == "lake-web.sqlite" {
		return kind == "sqlite"
	}
	if path == "tool-schedules.json" {
		return kind == "json"
	}
	if kind != "json" || !strings.HasPrefix(path, "ai/") || !strings.HasSuffix(path, ".json") || strings.Contains(path, "\\") || strings.Contains(path, "//") {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(path))
	if clean != path {
		return false
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(path, "ai/"), ".json"), "/")
	if len(parts) != 1 && (len(parts) != 3 || parts[0] != "children") {
		return false
	}
	for i, part := range parts {
		if i == 0 && part == "children" && len(parts) == 3 {
			continue
		}
		if !identifier.MatchString(part) {
			return false
		}
	}
	return true
}

func checkpointSources(dataRoot string) ([]SecurityCheckpointFile, error) {
	files := []SecurityCheckpointFile{{Path: "adk/sessions.sqlite", Kind: "sqlite"}, {Path: "lake-web.sqlite", Kind: "sqlite"}, {Path: "tool-schedules.json", Kind: "json"}}
	aiRoot := filepath.Join(dataRoot, "ai")
	err := filepath.WalkDir(aiRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if errors.Is(walkErr, os.ErrNotExist) && path == aiRoot {
			return nil
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("security: symlink in checkpoint session tree")
		}
		if entry.IsDir() {
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".json") {
			return nil
		}
		rel, err := filepath.Rel(dataRoot, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !checkpointFileAllowed(rel, "json") {
			return errors.New("security: unrecognized checkpoint session path")
		}
		files = append(files, SecurityCheckpointFile{Path: rel, Kind: "json"})
		if len(files) > 10000 {
			return errors.New("security: checkpoint file count exceeds limit")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

func privateCheckpointDir(path string, create bool) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	// Resolve the caller's root alias once (e.g. macOS /var -> /private/var).
	// Member traversal is subsequently checked against this canonical root.
	abs = filepath.Join(parent, filepath.Base(abs))
	if create {
		if err = os.Mkdir(abs, 0700); err != nil {
			return "", err
		}
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || !platform.Private(abs, info) {
		return "", errors.New("security: invalid private checkpoint directory")
	}
	return abs, nil
}

func writeSecurityCheckpoint(ctx context.Context, dataRoot, destination string, control security.ControlState) (SecurityCheckpoint, error) {
	cp := SecurityCheckpoint{FormatVersion: securityCheckpointFormat, StoreID: control.StoreID, RecoveryEpoch: control.RecoveryEpoch, CreatedAt: time.Now().UTC()}
	var err error
	cp.ID, err = securityID()
	if err != nil {
		return cp, err
	}
	cp.Files, err = checkpointSources(dataRoot)
	if err != nil {
		return cp, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(destination))
	if err != nil {
		return cp, err
	}
	canonicalDestination := filepath.Join(parent, filepath.Base(destination))
	if withinSecurityPath(dataRoot, canonicalDestination) {
		return cp, errors.New("security: checkpoint destination overlaps live data")
	}
	dest, err := privateCheckpointDir(canonicalDestination, true)
	if err != nil {
		return cp, err
	}
	for i := range cp.Files {
		if err = ctx.Err(); err != nil {
			return cp, err
		}
		file := &cp.Files[i]
		source := filepath.Join(dataRoot, filepath.FromSlash(file.Path))
		info, e := os.Lstat(source)
		if errors.Is(e, os.ErrNotExist) && file.Path != "adk/sessions.sqlite" {
			continue
		}
		if e != nil {
			return cp, e
		}
		if !info.Mode().IsRegular() || !platform.Private(source, info) {
			return cp, errors.New("security: invalid private checkpoint source")
		}
		out := filepath.Join(dest, filepath.FromSlash(file.Path))
		if e = platform.MkdirAll(filepath.Dir(out), 0700); e != nil {
			return cp, e
		}
		if file.Kind == "sqlite" {
			e = snapshotSecurityDatabase(ctx, source, out)
		} else {
			e = copySecurityCheckpointFile(ctx, source, out)
		}
		if e != nil {
			return cp, e
		}
		file.Present = true
		if file.SHA256, e = hashSecurityArchive(out); e != nil {
			return cp, e
		}
		info, e = os.Stat(out)
		if e != nil {
			return cp, e
		}
		file.Size = info.Size()
		if file.Kind == "sqlite" {
			db, openErr := openSecurityReadOnlyMode(out, true)
			if openErr != nil {
				return cp, openErr
			}
			file.SQLiteUserVersion, file.SchemaSHA256, e = securityCheckpointSQLiteMetadata(ctx, db)
			db.Close()
			if e != nil {
				return cp, e
			}
		}
	}
	if err = verifySecurityCheckpointFiles(ctx, dest, cp); err != nil {
		return cp, err
	}
	if err = syncSecurityCheckpointDirectories(dest); err != nil {
		return cp, err
	}
	encoded, err := json.Marshal(cp)
	if err != nil || len(encoded) >= 4<<20 {
		return cp, errors.New("security: checkpoint manifest exceeds limit")
	}
	if err = writeSecurityJSON(filepath.Join(dest, "manifest.json"), cp); err != nil {
		return cp, err
	}
	return cp, platform.SyncDirectory(dest)
}

func syncSecurityCheckpointDirectories(root string) error {
	var dirs []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("security: changed checkpoint directory")
		}
		if entry.IsDir() {
			dirs = append(dirs, path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err = platform.SyncDirectory(dirs[i]); err != nil {
			return err
		}
	}
	return nil
}

func withinSecurityPath(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func copySecurityCheckpointFile(ctx context.Context, source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || !platform.Private(source, info) {
		return errors.New("security: invalid private checkpoint member")
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(destination), ".checkpoint-*")
	if err != nil {
		return err
	}
	name := out.Name()
	defer os.Remove(name)
	if err = platform.Chmod(name, 0600); err == nil {
		_, err = io.Copy(out, &securityContextReader{ctx: ctx, reader: in})
	}
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = platform.ReplaceFile(name, destination); err != nil {
		return err
	}
	return platform.SyncDirectory(filepath.Dir(destination))
}

type securityContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *securityContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// VerifySecurityCheckpoint validates membership, hashes, SQLite integrity and
// the canonical store identity. It returns no database contents or credentials.
func VerifySecurityCheckpoint(ctx context.Context, directory string) (SecurityCheckpoint, error) {
	dir, err := privateCheckpointDir(directory, false)
	if err != nil {
		return SecurityCheckpoint{}, err
	}
	var cp SecurityCheckpoint
	if err = privateSecurityRead(filepath.Join(dir, "manifest.json"), &cp); err != nil {
		return cp, err
	}
	return cp, verifySecurityCheckpointFiles(ctx, dir, cp)
}

func verifySecurityCheckpointFiles(ctx context.Context, directory string, cp SecurityCheckpoint) error {
	if cp.FormatVersion != securityCheckpointFormat || len(cp.ID) != 64 || len(cp.StoreID) != 64 || len(cp.RecoveryEpoch) != 64 || cp.CreatedAt.IsZero() || len(cp.Files) < 3 || len(cp.Files) > 10000 {
		return errors.New("security: invalid checkpoint manifest")
	}
	for _, id := range []string{cp.ID, cp.StoreID, cp.RecoveryEpoch} {
		if _, err := hex.DecodeString(id); err != nil {
			return errors.New("security: invalid checkpoint identity")
		}
	}
	seen := map[string]bool{}
	for _, member := range cp.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !checkpointFileAllowed(member.Path, member.Kind) || seen[member.Path] {
			return errors.New("security: invalid or duplicate checkpoint member")
		}
		seen[member.Path] = true
		path := filepath.Join(directory, filepath.FromSlash(member.Path))
		if !member.Present {
			if member.Path == "adk/sessions.sqlite" || member.SHA256 != "" || member.Size != 0 || member.SchemaSHA256 != "" || member.SQLiteUserVersion != 0 {
				return errors.New("security: missing canonical checkpoint store")
			}
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				return errors.New("security: unexpected checkpoint member")
			}
			continue
		}
		// Reject symlink ancestors, not just a symlink at the final file name.
		parent, err := filepath.EvalSymlinks(filepath.Dir(path))
		if err != nil || parent != filepath.Dir(path) {
			return errors.New("security: checkpoint member path changed")
		}
		info, err := os.Lstat(path)
		if err != nil || info.Size() != member.Size {
			return errors.New("security: checkpoint member size changed")
		}
		digest, err := hashSecurityArchive(path)
		if err != nil || digest != member.SHA256 {
			return errors.New("security: checkpoint member hash changed")
		}
		if member.Kind == "sqlite" {
			for _, suffix := range []string{"-wal", "-journal", "-shm"} {
				if _, e := os.Lstat(path + suffix); !errors.Is(e, os.ErrNotExist) {
					return errors.New("security: checkpoint SQLite has mutable companions")
				}
			}
			db, err := openSecurityReadOnlyMode(path, true)
			if err != nil {
				return err
			}
			err = checkSecurityCheckpointDatabase(ctx, db, member.Path == "adk/sessions.sqlite", cp)
			if err == nil {
				version, schema, e := securityCheckpointSQLiteMetadata(ctx, db)
				if e != nil || version != member.SQLiteUserVersion || schema != member.SchemaSHA256 {
					err = errors.New("security: checkpoint SQLite schema binding mismatch")
				}
			}
			db.Close()
			if err != nil {
				return err
			}
		} else {
			if info.Size() > 64<<20 {
				return errors.New("security: checkpoint JSON member exceeds limit")
			}
			data, e := os.ReadFile(path)
			if e != nil || !json.Valid(data) {
				return errors.New("security: invalid checkpoint JSON member")
			}
		}
	}
	for _, required := range []string{"adk/sessions.sqlite", "lake-web.sqlite", "tool-schedules.json"} {
		if !seen[required] {
			return errors.New("security: incomplete paired checkpoint")
		}
	}
	return nil
}

func securityCheckpointSQLiteMetadata(ctx context.Context, db *sql.DB) (int64, string, error) {
	var version int64
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return 0, "", err
	}
	rows, err := db.QueryContext(ctx, `SELECT type,name,tbl_name,COALESCE(sql,'') FROM sqlite_master ORDER BY type,name,tbl_name`)
	if err != nil {
		return 0, "", err
	}
	defer rows.Close()
	hash := sha256.New()
	encoder := json.NewEncoder(hash)
	for rows.Next() {
		var fields [4]string
		if err = rows.Scan(&fields[0], &fields[1], &fields[2], &fields[3]); err != nil {
			return 0, "", err
		}
		if err = encoder.Encode(fields); err != nil {
			return 0, "", err
		}
	}
	if err = rows.Err(); err != nil {
		return 0, "", err
	}
	return version, hex.EncodeToString(hash.Sum(nil)), nil
}

func checkSecurityCheckpointDatabase(ctx context.Context, db *sql.DB, canonical bool, cp SecurityCheckpoint) error {
	var integrity string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return errors.New("security: checkpoint integrity failure")
	}
	if !canonical {
		return nil
	}
	var schema, reader int
	var store, epoch, state string
	err := db.QueryRowContext(ctx, "SELECT schema_version,minimum_reader_version,store_id,recovery_epoch,migration_state FROM security_schema_meta WHERE id=1").Scan(&schema, &reader, &store, &epoch, &state)
	if err != nil {
		return err
	}
	if schema != security.SchemaVersion || reader < 1 || reader > security.ReaderVersion || store != cp.StoreID || epoch != cp.RecoveryEpoch || state != "ready" {
		return errors.New("security: checkpoint store binding mismatch")
	}
	return nil
}

func checkpointManifestHash(directory string) (string, error) {
	data, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
