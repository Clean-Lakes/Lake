package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"sort"
	"strings"
	"time"
)

func (s *Store) memoryGenerationSnapshot(project string) map[string]int {
	return s.read(func() any {
		result := map[string]int{}
		if s.memoryV2 {
			for _, r := range s.rows("SELECT g.resourceId,g.generation FROM resourceMemoryGenerations g JOIN resources r ON r.id=g.resourceId WHERE r.projectId=?", project) {
				result[stringOf(r["resourceId"])] = integer(r["generation"])
			}
		}
		return result
	}).(map[string]int)
}

// These helpers run under the Store read/update lock. Never accept generation
// numbers supplied by a client or a model.
func (s *Store) MemoryResourceBindings(project string, ids []string) []Object {
	bindings := []Object{}
	seen := map[string]bool{}
	ordered := append([]string(nil), ids...)
	sort.Strings(ordered)
	for _, id := range ordered {
		if seen[id] {
			fail(400, "Duplicate memory resource")
		}
		seen[id] = true
		r := s.row("SELECT id FROM resources WHERE id=? AND projectId=? AND "+activeResourcesSQL, id, project)
		if r == nil {
			fail(422, "Memory resource is unavailable in this project")
		}
		generation := s.row("SELECT generation FROM resourceMemoryGenerations WHERE resourceId=?", id)
		if generation == nil {
			fail(409, "Memory resource generation is unavailable")
		}
		bindings = append(bindings, Object{"resourceId": id, "generation": generation["generation"]})
	}
	return bindings
}

func (s *Store) BumpMemoryResourceGeneration(resource, reason string) {
	if !s.memoryV2 {
		return
	}
	s.InvalidateMemoryIndexCache()
	ids := []string{resource}
	// Docker connections can inherit the execution endpoint of an SSH resource.
	for _, row := range s.rows("SELECT resourceId,config FROM resourceConnections") {
		if !strings.HasPrefix(reason, "project_") && memoryObject(row["config"])["ssh_asset_ref"] == resource {
			ids = append(ids, stringOf(row["resourceId"]))
		}
	}
	for _, id := range ids {
		s.exec("INSERT INTO resourceMemoryGenerations(resourceId,generation,updatedAt,reason) VALUES(?,2,?,?) ON CONFLICT(resourceId) DO UPDATE SET generation=generation+1,updatedAt=excluded.updatedAt,reason=excluded.reason", id, now(), reason)
	}
}

func (s *Store) memorySnapshotBindingsValid(snapshot ai.MemoryTurnSnapshot) bool {
	return s.read(func() any {
		bindings := append([]ai.MemoryResourceBinding{}, snapshot.TargetBindings...)
		for _, evidence := range snapshot.Evidence {
			if evidence.Context != nil {
				bindings = append(bindings, evidence.Context.ResourceBindings...)
			}
		}
		for _, binding := range bindings {
			row := s.row("SELECT generation FROM resourceMemoryGenerations g JOIN resources ON resources.id=g.resourceId WHERE resourceId=? AND projectId=? AND "+activeResourcesSQL, binding.ResourceID, snapshot.ProjectID)
			if integer(row["generation"]) != binding.Generation {
				return false
			}
		}
		return true
	}).(bool)
}

func (s *Store) EvaluateMemoryEligibility(row Object, at time.Time) string {
	if stringOf(row["deletedAt"]) != "" {
		return "deleted"
	}
	if state := stringOf(row["reviewState"]); state != "active" {
		return state
	}
	bindings := memoryObjects(row["bindingsJSON"])
	if row["scopeKind"] == "resources" && len(bindings) == 0 {
		return "needs_review"
	}
	for _, b := range bindings {
		r := s.row("SELECT id FROM resources WHERE id=? AND projectId=? AND "+activeResourcesSQL, b["resourceId"], row["projectId"])
		if r == nil {
			return "missing_resource"
		}
		g := s.row("SELECT generation FROM resourceMemoryGenerations WHERE resourceId=?", b["resourceId"])
		if integer(g["generation"]) != integer(b["generation"]) {
			return "generation_mismatch"
		}
	}
	if memoryExpired(row, at) {
		return "expired"
	}
	return "eligible"
}

func DeriveMemoryValidity(entry, old Object) string {
	until := stringOf(entry["validUntil"])
	kind := stringOf(entry["knowledgeKind"])
	if kind != "topology" && kind != "configuration" {
		return until
	}
	base := stringOf(entry["observedAt"])
	if base == "" {
		base = stringOf(entry["assertedAt"])
	}
	t, err := time.Parse(time.RFC3339Nano, base)
	if err != nil {
		return "1970-01-01T00:00:00Z"
	}
	ttl := 24 * time.Hour
	if kind == "topology" {
		ttl *= 7
	}
	defaultUntil := t.Add(ttl).Format(time.RFC3339Nano)
	if until == "" {
		until = defaultUntil
	}
	// RFC3339Nano strings are not ordered chronologically for differing offsets.
	minTime := func(a, b string) string {
		ta, ea := time.Parse(time.RFC3339Nano, a)
		tb, eb := time.Parse(time.RFC3339Nano, b)
		if eb == nil && (ea != nil || tb.Before(ta)) {
			return b
		}
		return a
	}
	until = minTime(until, defaultUntil)
	if old != nil && stringOf(old["deletedAt"]) == "" && stringOf(old["validUntil"]) != "" && (stringOf(entry["observedAt"]) == "" || entry["observedAt"] == old["observedAt"]) {
		until = minTime(until, stringOf(old["validUntil"]))
	}
	return until
}
