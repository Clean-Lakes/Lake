package web

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/platform"
)

type memoryMarkdownMeta struct {
	ProjectID       string
	OriginSessionID string
	OriginTurnID    string
	Revision        int
	UpdatedAt       string
	Verification    string
	ObservedAt      string
	ValidUntil      string
}

func renderMemoryMarkdown(key, kind, description, body string, meta memoryMarkdownMeta) string {
	q := func(s string) string {
		b, _ := json.Marshal(s)
		return string(b)
	}
	var out strings.Builder
	fmt.Fprintf(&out, "---\nname: %s\ndescription: %s\nmetadata:\n  type: %s\n  projectId: %s\n  originSessionId: %s\n  originTurnId: %s\n  revision: %d\n  updatedAt: %s\n  verification: %s\n", q(key), q(description), q(kind), q(meta.ProjectID), q(meta.OriginSessionID), q(meta.OriginTurnID), meta.Revision, q(meta.UpdatedAt), q(meta.Verification))
	if meta.ValidUntil != "" {
		fmt.Fprintf(&out, "  validUntil: %s\n", q(meta.ValidUntil))
	}
	if meta.ObservedAt != "" {
		fmt.Fprintf(&out, "  observedAt: %s\n", q(meta.ObservedAt))
	}
	out.WriteString("---\n\n")
	out.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		out.WriteByte('\n')
	}
	return out.String()
}

func memoryProjectionPath(root, project string) string {
	return filepath.Join(root, "memories", "projects", project, "memory")
}

func safeMemoryDirectory(path string) error {
	parts := []string{}
	for current := path; current != filepath.Dir(current); current = filepath.Dir(current) {
		parts = append(parts, current)
		if filepath.Base(current) == "memories" {
			break
		}
	}
	if len(parts) == 0 || filepath.Base(parts[len(parts)-1]) != "memories" {
		return errMemoryProjection
	}
	for i := len(parts) - 1; i >= 0; i-- {
		current := parts[i]
		if err := platform.MkdirAll(current, 0700); err != nil {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errMemoryProjection
		}
		if err := platform.Chmod(current, 0700); err != nil {
			return err
		}
	}
	return nil
}

func safeMemoryFile(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errMemoryProjection
	}
	return nil
}

func boundedMemoryIndex(rows []Object) string {
	lines := strings.Split(strings.TrimSuffix(memoryIndex(rows), "\n"), "\n")
	if len(rows) == 0 {
		return ""
	}
	var out strings.Builder
	for _, line := range lines {
		if out.Len()+len(line)+1 > 25000 || strings.Count(out.String(), "\n") >= 200 {
			break
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	return out.String()
}

// SQLite owns the logical commit. This projection is serialized per Store and can
// always be rebuilt after a crash, without another model request.
func (s *Store) PublishProjectMemory(project string) error {
	s.memoryPublishMu.Lock()
	defer s.memoryPublishMu.Unlock()
	snapshot := s.read(func() any {
		rows, revision := s.listMemoryRows(project)
		return struct {
			rows     []Object
			revision int
		}{rows, revision}
	}).(struct {
		rows     []Object
		revision int
	})
	dir := memoryProjectionPath(s.Dir, project)
	if err := safeMemoryDirectory(dir); err != nil {
		return err
	}
	keep := map[string]bool{"MEMORY.md": true}
	for _, row := range snapshot.rows {
		key := stringOf(row["key"])
		if !validMemoryKey(key) {
			return errMemoryProjection
		}
		name := key + ".md"
		keep[name] = true
		path := filepath.Join(dir, name)
		if err := safeMemoryFile(path); err != nil {
			return err
		}
		if err := atomicFile(path, []byte(stringOf(row["markdown"]))); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "MEMORY.md" || !strings.HasSuffix(name, ".md") || !validMemoryKey(strings.TrimSuffix(name, ".md")) {
			continue
		}
		if keep[name] {
			continue
		}
		path := filepath.Join(dir, name)
		if err := safeMemoryFile(path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	indexPath := filepath.Join(dir, "MEMORY.md")
	if err := safeMemoryFile(indexPath); err != nil {
		return err
	}
	if err := atomicFile(indexPath, []byte(boundedMemoryIndex(snapshot.rows))); err != nil {
		return err
	}
	s.update(func() any {
		settings := s.memorySettings(project)
		if integer(settings["revision"]) == snapshot.revision && integer(settings["publishedRevision"]) < snapshot.revision {
			s.exec("UPDATE projectMemorySettings SET publishedRevision=? WHERE projectId=?", snapshot.revision, project)
			s.exec("UPDATE projectMemoryCommits SET publishedAt=? WHERE projectId=? AND revision<=? AND publishedAt=''", now(), project, snapshot.revision)
		}
		return nil
	})
	return nil
}

func (s *Store) ReconcileProjectMemoryFiles() error {
	projects := s.read(func() any {
		return s.rows("SELECT m.projectId FROM projectMemorySettings m JOIN projects ON projects.id=m.projectId WHERE m.publishedRevision<m.revision AND " + activeProjectsSQL)
	}).([]Object)
	for _, row := range projects {
		if err := s.PublishProjectMemory(stringOf(row["projectId"])); err != nil {
			return err
		}
	}
	return nil
}
