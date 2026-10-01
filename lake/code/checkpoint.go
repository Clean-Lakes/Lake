package code

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type checkpointEntry struct {
	Path    string      `json:"path"`
	Content string      `json:"content"`
	Existed bool        `json:"existed"`
	Mode    os.FileMode `json:"mode"`
}

type checkpointManifest struct {
	ProjectRoot string            `json:"project_root"`
	SessionID   string            `json:"session_id"`
	Entries     []checkpointEntry `json:"entries"`
}

type CheckpointStore struct {
	workspace *Workspace
	sessionID string
	root      string
}

var safeCheckpointName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var checkpointIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func NewCheckpointStore(lakeRoot, sessionID string, w *Workspace) (*CheckpointStore, error) {
	if w == nil || w.Root == "" || !safeCheckpointName.MatchString(sessionID) || lakeRoot == "" {
		return nil, errors.New("invalid checkpoint scope")
	}
	lakeRoot, err := filepath.Abs(lakeRoot)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(w.Root))
	root := filepath.Join(lakeRoot, "checkpoints", sessionID, hex.EncodeToString(digest[:16]))
	for _, dir := range []string{filepath.Join(lakeRoot, "checkpoints"), filepath.Join(lakeRoot, "checkpoints", sessionID), root} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("checkpoint directory is unsafe")
		}
		if err := os.Chmod(dir, 0700); err != nil {
			return nil, err
		}
	}
	return &CheckpointStore{workspace: w, sessionID: sessionID, root: root}, nil
}

func (s *CheckpointStore) Root() string { return s.root }

func newCheckpointID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func (s *CheckpointStore) writeSnapshot(entries []checkpointEntry) (string, error) {
	id, err := newCheckpointID()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(s.root, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		return "", err
	}
	manifest := checkpointManifest{ProjectRoot: s.workspace.Root, SessionID: s.sessionID, Entries: entries}
	data, err := json.Marshal(manifest)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	path := filepath.Join(dir, "manifest.json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		_ = os.RemoveAll(dir)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	if err := os.Chmod(path, 0600); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	return id, nil
}

func (s *CheckpointStore) Snapshot(paths []string) (string, error) {
	if len(paths) == 0 || len(paths) > maxPatchFiles {
		return "", errors.New("检查点需要 1 到 8 个文件")
	}
	seen := map[string]bool{}
	entries := make([]checkpointEntry, 0, len(paths))
	for _, path := range paths {
		clean := filepath.Clean(path)
		if seen[clean] {
			return "", errors.New("检查点包含重复文件")
		}
		seen[clean] = true
		_, data, mode, exists, err := s.workspace.patchTarget(clean)
		if err != nil {
			return "", err
		}
		entries = append(entries, checkpointEntry{Path: clean, Content: string(data), Existed: exists, Mode: mode})
	}
	return s.writeSnapshot(entries)
}

func (s *CheckpointStore) PreviewRestore(id string) (PatchPreview, error) {
	if !checkpointIDPattern.MatchString(id) {
		return PatchPreview{}, errors.New("invalid checkpoint ID")
	}
	dir := filepath.Join(s.root, id)
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return PatchPreview{}, errors.New("checkpoint directory is unsafe")
	}
	path := filepath.Join(dir, "manifest.json")
	info, err = os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxPatchFiles*(maxPatchFileBytes+4096) {
		return PatchPreview{}, errors.New("checkpoint manifest is unsafe")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return PatchPreview{}, err
	}
	var manifest checkpointManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return PatchPreview{}, err
	}
	if manifest.ProjectRoot != s.workspace.Root || manifest.SessionID != s.sessionID || len(manifest.Entries) == 0 || len(manifest.Entries) > maxPatchFiles {
		return PatchPreview{}, errors.New("checkpoint scope mismatch")
	}
	files := make([]PatchFile, 0, len(manifest.Entries))
	for _, entry := range manifest.Entries {
		files = append(files, PatchFile{Path: entry.Path, Content: entry.Content, Delete: !entry.Existed})
	}
	return s.workspace.PreviewPatch(files)
}

func (s *CheckpointStore) Apply(preview PatchPreview) (string, error) {
	if preview.ProjectRoot != s.workspace.Root || len(preview.Changes) == 0 || len(preview.Changes) > maxPatchFiles {
		return "", errors.New("patch scope mismatch")
	}
	type stagedChange struct {
		change         ChangePreview
		target, staged string
		mode           os.FileMode
	}
	staged := make([]stagedChange, 0, len(preview.Changes))
	defer func() {
		for _, item := range staged {
			if item.staged != "" {
				_ = os.Remove(item.staged)
			}
		}
	}()
	entries := make([]checkpointEntry, 0, len(preview.Changes))
	seen := map[string]bool{}
	for _, change := range preview.Changes {
		clean := filepath.Clean(change.Path)
		if seen[clean] {
			return "", errors.New("patch contains duplicate files")
		}
		seen[clean] = true
		target, before, mode, exists, err := s.workspace.patchTarget(clean)
		if err != nil {
			return "", err
		}
		if exists == change.Created || string(before) != change.Before || change.Deleted && !exists {
			return "", errors.New("文件在批准后发生变化，请重新预览")
		}
		if len(change.After) > maxPatchFileBytes || strings.IndexByte(change.After, 0) >= 0 {
			return "", errors.New("patch content is too large or binary")
		}
		item := stagedChange{change: change, target: target, mode: mode}
		if !change.Deleted {
			file, err := os.CreateTemp(filepath.Dir(target), ".lake-patch-*")
			if err != nil {
				return "", err
			}
			item.staged = file.Name()
			staged = append(staged, item)
			if err := file.Chmod(mode); err != nil {
				file.Close()
				return "", err
			}
			if _, err := file.WriteString(change.After); err != nil {
				file.Close()
				return "", err
			}
			if err := file.Close(); err != nil {
				return "", err
			}
		} else {
			staged = append(staged, item)
		}
		entries = append(entries, checkpointEntry{Path: clean, Content: string(before), Existed: exists, Mode: mode})
	}
	id, err := s.writeSnapshot(entries)
	if err != nil {
		return "", err
	}
	for _, item := range staged {
		_, current, _, exists, err := s.workspace.patchTarget(item.change.Path)
		if err != nil || exists == item.change.Created || !bytes.Equal(current, []byte(item.change.Before)) {
			_ = os.RemoveAll(filepath.Join(s.root, id))
			return "", errors.New("文件在批准后发生变化，请重新预览")
		}
	}
	committed := make([]stagedChange, 0, len(staged))
	for _, item := range staged {
		if item.change.Deleted {
			err = os.Remove(item.target)
		} else {
			err = os.Rename(item.staged, item.target)
		}
		if err != nil {
			break
		}
		committed = append(committed, item)
	}
	if err != nil {
		var rollbackError error
		for i := len(committed) - 1; i >= 0; i-- {
			item := committed[i]
			if item.change.Created {
				rollbackError = errors.Join(rollbackError, os.Remove(item.target))
			} else {
				rollbackError = errors.Join(rollbackError, restoreFile(item.target, []byte(item.change.Before), item.mode))
			}
		}
		_ = os.RemoveAll(filepath.Join(s.root, id))
		return "", errors.Join(err, rollbackError)
	}
	return id, nil
}

func restoreFile(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".lake-restore-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return fmt.Errorf("restore %s: %w", filepath.Base(path), err)
	}
	return nil
}
