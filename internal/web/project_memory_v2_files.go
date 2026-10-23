package web

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func memoryV2ProjectionPath(root, project string) string {
	return filepath.Join(root, "memories", "v2", "projects", project, "memory")
}

func renderMemoryV2Markdown(row Object) string {
	var out strings.Builder
	out.WriteString("---\n")
	for _, field := range []string{"projectId", "key", "type", "description", "knowledgeKind", "scopeKind", "factKey", "verification", "observedAt", "assertedAt", "validUntil", "reviewState", "revision", "createdAt", "updatedAt", "originSessionId", "originTurnId"} {
		fmt.Fprintf(&out, "%s: %s\n", field, jsonText(row[field]))
	}
	fmt.Fprintf(&out, "bindings: %s\nsubject: %s\nsources: %s\n---\n\n%s\n", stringOf(row["bindingsJSON"]), stringOf(row["subjectJSON"]), jsonText(row["sources"]), stringOf(row["body"]))
	return out.String()
}

func (s *Store) cleanLegacyMemoryProjection() error {
	projects := s.read(func() any { return s.rows("SELECT id FROM projects") }).([]Object)
	for _, project := range projects {
		id := stringOf(project["id"])
		if !workflowIdentifier.MatchString(id) {
			return errMemoryProjection
		}
		dir := memoryProjectionPath(s.Dir, id)
		if err := safeMemoryDirectory(dir); err != nil {
			return err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if name != "MEMORY.md" && (!strings.HasSuffix(name, ".md") || !validMemoryKey(strings.TrimSuffix(name, ".md"))) {
				continue
			}
			path := filepath.Join(dir, name)
			if err := safeMemoryFile(path); err != nil {
				return err
			}
			if err := os.Remove(path); err != nil {
				return err
			}
		}
		if err := atomicFile(filepath.Join(dir, "MEMORY.md"), nil); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) publishMemoryV2(project string) error {
	s.memoryPublishMu.Lock()
	defer s.memoryPublishMu.Unlock()
	var revision int
	var rows []Object
	index := ""
	s.read(func() any {
		rows, revision = s.listMemoryRows(project)
		active := []Object{}
		for _, row := range rows {
			row["sources"] = s.rows("SELECT kind,sessionId,turnId,messageId,callId,evidenceId,observedAt,assertedAt FROM projectMemorySourcesV2 WHERE projectId=? AND key=? ORDER BY entryRevision DESC,rowid DESC LIMIT 8", project, row["key"])
			if s.EvaluateMemoryEligibility(row, time.Now().UTC()) == "eligible" {
				active = append(active, row)
			}
		}
		index = boundedMemoryIndex(active)
		return nil
	})
	if !workflowIdentifier.MatchString(project) {
		return errMemoryProjection
	}
	dir := memoryV2ProjectionPath(s.Dir, project)
	if err := safeMemoryDirectory(dir); err != nil {
		return err
	}
	keep := map[string]bool{"MEMORY.md": true}
	for _, row := range rows {
		key := stringOf(row["key"])
		if !validMemoryKey(key) {
			return errMemoryProjection
		}
		path := filepath.Join(dir, key+".md")
		if err := safeMemoryFile(path); err != nil {
			return err
		}
		if err := atomicFile(path, []byte(renderMemoryV2Markdown(row))); err != nil {
			return err
		}
		keep[key+".md"] = true
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if keep[name] || !strings.HasSuffix(name, ".md") || !validMemoryKey(strings.TrimSuffix(name, ".md")) {
			continue
		}
		path := filepath.Join(dir, name)
		if err := safeMemoryFile(path); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	path := filepath.Join(dir, "MEMORY.md")
	if err := safeMemoryFile(path); err != nil {
		return err
	}
	if err := atomicFile(path, []byte(index)); err != nil {
		return err
	}
	s.update(func() any {
		if integer(s.memorySettings(project)["revision"]) == revision {
			s.exec("UPDATE projectMemorySettings SET publishedRevision=? WHERE projectId=?", revision, project)
			s.exec("UPDATE projectMemoryCommits SET publishedAt=? WHERE projectId=? AND revision<=? AND publishedAt=''", now(), project, revision)
		}
		return nil
	})
	return nil
}
