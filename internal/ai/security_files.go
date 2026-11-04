package ai

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

const securityTextReadLimit = 8 << 20
const securityLogTailLimit = 64 << 10

func securityFileBase(path string) string {
	if path == string(filepath.Separator) {
		return "."
	}
	return filepath.Base(path)
}

// Only the OS's fixed top-level macOS aliases are accepted. A symlink inside
// an authorized directory must never turn its scope path into an outside read.
func securityFileParent(path string) (string, error) {
	parent := filepath.Dir(path)
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(parent, string(filepath.Separator)), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			allowed := runtime.GOOS == "darwin" && (current == "/var" || current == "/tmp" || current == "/etc")
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil || !allowed || resolved != "/private"+current {
				return "", errors.New("security: linked parent directory is not a bounded file root")
			}
		} else if !info.IsDir() {
			return "", errors.New("security: file parent is not a directory")
		}
	}
	return filepath.EvalSymlinks(parent)
}

func securityLocalFilePath(c Config, a map[string]any) (string, error) {
	path := str(a["path"])
	if !filepath.IsAbs(path) || strings.IndexByte(path, 0) >= 0 || filepath.Clean(path) != path {
		return "", errors.New("security: exact absolute file path required")
	}
	if err := safeFile(path); err != nil {
		return "", err
	}
	if err := safeConfiguredFile(c, path); err != nil {
		return "", err
	}
	return path, nil
}

// Metadata only: no target contents are read and no executable is launched.
func (e *Engine) prepareSecurityLocalFile(c Config, op *security.PreparedOperation, a map[string]any) (bool, error) {
	c = e.securityProtectedConfig(c)
	if op.Tool != "read" && op.Tool != "ls" && op.Tool != "observe_logs" {
		return false, nil
	}
	if len(op.Resources) != 1 || !op.Resources[0].Local {
		return false, nil
	}
	if op.Tool == "read" {
		format, ext := str(a["format"]), strings.ToLower(filepath.Ext(str(a["path"])))
		if format != "" && format != "auto" && format != "text" || strings.Contains(" .png .jpg .jpeg .gif .webp .pdf ", " "+ext+" ") {
			return false, nil
		}
		if num(a["offset"], 0) < 0 || num(a["byte_offset"], 0) < 0 || num(a["limit"], 200) < 1 || num(a["limit"], 200) > 2000 {
			return false, errors.New("security: invalid bounded text page")
		}
	}
	path, err := securityLocalFilePath(c, a)
	if err != nil {
		return false, err
	}
	if op.Tool == "observe_logs" && !strings.HasSuffix(strings.ToLower(path), ".log") && !strings.HasPrefix(path, "/var/log/") {
		return false, errors.New("security: bounded log path required")
	}
	rootPath, err := securityFileParent(path)
	if err != nil {
		return false, err
	}
	if err = safeFile(filepath.Join(rootPath, filepath.Base(path))); err != nil {
		return false, err
	}
	if err = safeConfiguredFile(c, filepath.Join(rootPath, filepath.Base(path))); err != nil {
		return false, err
	}
	rootInfo, err := os.Lstat(rootPath)
	if err != nil {
		return false, err
	}
	rootIdentity, err := platform.SecurityFileIdentity(rootInfo)
	if err != nil {
		return false, nil
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return false, err
	}
	defer root.Close()
	actualRoot, err := root.Stat(".")
	if err != nil || !os.SameFile(rootInfo, actualRoot) {
		return false, errors.New("security: file root changed during preparation")
	}
	info, err := root.Lstat(securityFileBase(path))
	if err != nil {
		return false, err
	}
	if op.Tool == "ls" && !info.IsDir() || op.Tool != "ls" && !info.Mode().IsRegular() {
		return false, errors.New("security: bounded file type mismatch")
	}
	identity, err := securityFrozenFileIdentity(info, op.Tool, op.Scope.ExpectedContentHash)
	if err != nil {
		return false, err
	}
	if op.Tool == "read" && info.Size() > securityTextReadLimit {
		return false, errors.New("security: text file exceeds 8 MiB limit")
	}
	if op.Tool == "observe_logs" && op.Scope.ExpectedContentHash != "" && info.Size() > securityLogTailLimit {
		return false, errors.New("security: explicit whole-content hash exceeds bounded log sample")
	}
	op.Scope.FilePath, op.Scope.FileRoot, op.Scope.FileRootIdentity = path, rootPath, rootIdentity
	op.Scope.FileIdentity, op.Scope.FileSize, op.Scope.FileModifiedNanos = identity, info.Size(), info.ModTime().UnixNano()
	op.Proof = security.ProofStructured
	return true, nil
}

func openSecurityLocalFile(scope security.OperationScope, name string) (*os.File, error) {
	root, err := os.OpenRoot(scope.FileRoot)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Stat(".")
	if err != nil {
		return nil, err
	}
	identity, err := platform.SecurityFileIdentity(info)
	if err != nil || identity != scope.FileRootIdentity {
		return nil, errors.New("security: approved file root changed")
	}
	base := securityFileBase(scope.FilePath)
	before, err := root.Lstat(base)
	if err != nil {
		return nil, err
	}
	if err = securityFileInfoMatches(scope, before, name); err != nil {
		return nil, err
	}
	file, err := platform.OpenSecurityRootFile(root, base)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !os.SameFile(before, opened) {
		file.Close()
		return nil, errors.New("security: approved file was replaced during open")
	}
	if err = securityFileInfoMatches(scope, opened, name); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func securityFileInfoMatches(scope security.OperationScope, info os.FileInfo, name string) error {
	identity, err := securityFrozenFileIdentity(info, name, scope.ExpectedContentHash)
	strict := name != "observe_logs" || scope.ExpectedContentHash != ""
	if err != nil || identity != scope.FileIdentity || strict && (info.Size() != scope.FileSize || info.ModTime().UnixNano() != scope.FileModifiedNanos) || !strict && info.Size() < scope.FileSize {
		return errors.New("security: approved file identity or contents changed")
	}
	if name == "ls" && !info.IsDir() || name != "ls" && !info.Mode().IsRegular() {
		return errors.New("security: approved file type changed")
	}
	return nil
}

func securityFrozenFileIdentity(info os.FileInfo, name, expectedHash string) (string, error) {
	if name == "observe_logs" && expectedHash == "" {
		return platform.SecurityFileStableIdentity(info)
	}
	return platform.SecurityFileIdentity(info)
}

func (e *Engine) executeSecurityLocalFile(ctx context.Context, c Config, name string, a map[string]any) (any, error) {
	if err := e.requireSecurityAdapterContext(ctx, c); err != nil {
		return nil, err
	}
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if permit == nil || permit.operation.Tool != name || permit.operation.Proof != security.ProofStructured || permit.operation.Scope.FileRoot == "" || hash(js(a)) != permit.operation.ArgumentsDigest {
		return nil, &ToolNotExecutedError{Err: errors.New("security: exact bounded-file permit required")}
	}
	path, err := securityLocalFilePath(c, a)
	if err != nil || path != permit.operation.Scope.FilePath {
		return nil, &ToolNotExecutedError{Err: errors.New("security: bounded-file arguments changed")}
	}
	var file *os.File
	err = e.validateSecurityPermitAtIO(ctx, permit.operation.ProjectID, permit.operation.SessionID, func(SecurityCatalogView) error {
		var openErr error
		file, openErr = openSecurityLocalFile(permit.operation.Scope, name)
		return openErr
	})
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	defer file.Close()
	result, err := readSecurityLocalFile(ctx, file, permit.operation.Scope, name, a, c)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func readSecurityLocalFile(ctx context.Context, file *os.File, scope security.OperationScope, name string, a map[string]any, c Config) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var result any
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if err = securityFileInfoMatches(scope, opened, name); err != nil {
		return nil, err
	}
	if name == "observe_logs" && scope.ExpectedContentHash == "" {
		scope.FileSize, scope.FileModifiedNanos = opened.Size(), opened.ModTime().UnixNano()
	}
	openedStrictIdentity, _ := platform.SecurityFileIdentity(opened)
	if name == "ls" {
		entries, err := file.ReadDir(1001)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		truncated := len(entries) > 1000
		if truncated {
			entries = entries[:1000]
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		lines := []string{}
		for _, entry := range entries {
			suffix := ""
			if entry.IsDir() {
				suffix = "/"
			}
			lines = append(lines, entry.Name()+suffix)
		}
		result = map[string]any{"output": redact(strings.Join(lines, "\n"), c), "exitCode": 0, "truncated": truncated, "path": scope.FilePath, "count": len(entries)}
	} else {
		start, limit := int64(0), int64(securityTextReadLimit)
		if name == "observe_logs" {
			limit = securityLogTailLimit
			if scope.FileSize > limit {
				start = scope.FileSize - limit
			}
		}
		readLength := limit + 1
		if name == "observe_logs" {
			readLength = scope.FileSize - start
		}
		data, err := io.ReadAll(io.NewSectionReader(file, start, readLength))
		if err != nil {
			return nil, err
		}
		if len(data) > int(limit) {
			return nil, errors.New("security: bounded read size changed")
		}
		if scope.ExpectedContentHash != "" && hash(string(data)) != scope.ExpectedContentHash {
			return nil, errors.New("security: explicit file content hash changed")
		}
		if name == "observe_logs" && start > 0 {
			if newline := bytes.IndexByte(data, '\n'); newline >= 0 {
				data = data[newline+1:]
			} else {
				data = nil
			}
		}
		if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
			return nil, errors.New("security: bounded read requires UTF-8 text")
		}
		if name == "observe_logs" {
			text := string(data)
			lines := strings.SplitAfter(text, "\n")
			if len(lines) > 0 && lines[len(lines)-1] == "" {
				lines = lines[:len(lines)-1]
			}
			truncated := start > 0 || len(lines) > 200
			if len(lines) > 200 {
				lines = lines[len(lines)-200:]
			}
			output := strings.Join(lines, "")
			result = map[string]any{"output": output, "exitCode": 0, "truncated": truncated, "sample_hash": hash(output), "observed_at": time.Now().UTC().Format(time.RFC3339Nano), "sample_bytes": len(output), "sample_file_size": scope.FileSize}
		} else {
			result, err = textReadPage(scope.FilePath, string(data), num(a["offset"], 0), num(a["limit"], 200), num(a["byte_offset"], 0), hash(string(data)), c)
			if err != nil {
				return nil, err
			}
		}
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if err = securityFileInfoMatches(scope, info, name); err != nil {
		return nil, fmt.Errorf("security: file changed while reading: %w", err)
	}
	if name == "observe_logs" && scope.ExpectedContentHash == "" && info.Size() == scope.FileSize {
		currentStrictIdentity, identityErr := platform.SecurityFileIdentity(info)
		if identityErr != nil || currentStrictIdentity != openedStrictIdentity || info.ModTime().UnixNano() != scope.FileModifiedNanos {
			return nil, errors.New("security: log was rewritten while sampling")
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
