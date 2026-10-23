package web

import (
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type memoryReadScope struct {
	Project            string
	ResourceIDs        []string
	TurnID             string
	InputBudget        int
	NeedsClarification bool
}

type memoryIndexCacheEntry struct {
	expires time.Time
	value   Object
}

// Called under Store's transaction/read lock, just like the generation helpers.
func (s *Store) InvalidateMemoryIndexCache() { s.memoryIndexCache = nil }

func (b *Server) ResolveMemoryReadScope(id string) (memoryReadScope, error) {
	current, err := b.Engine.MemoryReadContext(id)
	if err != nil {
		return memoryReadScope{}, err
	}
	project := stringOf(b.Store.Session(id)["projectId"])
	result := memoryReadScope{Project: project, ResourceIDs: []string{}, TurnID: current.TurnID, InputBudget: current.InputBudget, NeedsClarification: current.NeedsClarification}
	if !current.Enabled || current.NeedsClarification {
		return result, nil
	}
	options := b.sessionOptions(id)
	for _, ref := range current.ResourceIDs {
		resource := b.Store.Resource(ref)
		if resource["projectId"] != project || options["denyLocalExecution"] == true && resource["kind"] == "local" {
			continue
		}
		b.Store.AssertResource(id, ref)
		result.ResourceIDs = append(result.ResourceIDs, ref)
	}
	sort.Strings(result.ResourceIDs)
	return result, nil
}

func memoryScopeAllows(row Object, scope memoryReadScope) bool {
	if row["projectId"] != scope.Project {
		return false
	}
	if row["scopeKind"] == "project" {
		return row["knowledgeKind"] == "preference" || row["knowledgeKind"] == "procedure"
	}
	if scope.NeedsClarification {
		return false
	}
	bindings := memoryObjects(row["bindingsJSON"])
	if len(bindings) == 0 {
		return false
	}
	allowed := map[string]bool{}
	for _, id := range scope.ResourceIDs {
		allowed[id] = true
	}
	for _, binding := range bindings {
		if !allowed[stringOf(binding["resourceId"])] {
			return false
		}
	}
	return true
}

func memorySearchTokens(text string) []string {
	text = strings.ToLower(norm.NFKC.String(text))
	seen := map[string]bool{}
	out := []string{}
	add := func(v string) {
		if v != "" && !seen[v] && len(out) < 64 {
			seen[v] = true
			out = append(out, v)
		}
	}
	latin := []rune{}
	var lastHan rune
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			add(string(latin))
			latin = nil
			if lastHan != 0 {
				add(string([]rune{lastHan, r}))
			}
			lastHan = r
		} else {
			lastHan = 0
			if r >= 'a' && r <= 'z' || unicode.IsDigit(r) {
				latin = append(latin, r)
			} else {
				add(string(latin))
				latin = nil
			}
		}
	}
	add(string(latin))
	return out
}

func memoryRunePrefix(text string, limit int) string {
	r := []rune(text)
	return string(r[:min(len(r), limit)])
}

func RankMemoryIndex(rows []Object, query string) []Object {
	tokens := memorySearchTokens(memoryRunePrefix(query, 2560))
	type ranked struct {
		row   Object
		score int
	}
	ranks := []ranked{}
	for _, row := range rows {
		score := 0
		if integer(row["alwaysReference"]) == 1 {
			score += 10
		}
		subject := memoryObject(row["subjectJSON"])
		fields := []struct {
			text   string
			weight int
		}{{stringOf(row["key"]), 6}, {stringOf(row["description"]), 3}, {stringOf(subject["identity"]) + " " + jsonText(subject["qualifiers"]), 4}}
		for _, token := range tokens {
			for _, field := range fields {
				if strings.Contains(strings.ToLower(norm.NFKC.String(field.text)), token) {
					score += field.weight
				}
			}
		}
		if score > 0 {
			ranks = append(ranks, ranked{row, score})
		}
	}
	sort.Slice(ranks, func(i, j int) bool {
		if ranks[i].score != ranks[j].score {
			return ranks[i].score > ranks[j].score
		}
		return stringOf(ranks[i].row["key"]) < stringOf(ranks[j].row["key"])
	})
	out := []Object{}
	for _, r := range ranks {
		out = append(out, r.row)
	}
	return out
}

func (s *Store) scopedMemoryRows(scope memoryReadScope, history bool) []Object {
	s.activeProject(scope.Project)
	if s.memorySettings(scope.Project)["useEnabled"] != true {
		return nil
	}
	rows := []Object{}
	for _, row := range s.rows("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND deletedAt='' ORDER BY key", scope.Project) {
		if !memoryScopeAllows(row, scope) {
			continue
		}
		eligibility := s.EvaluateMemoryEligibility(row, time.Now().UTC())
		if eligibility != "eligible" && !(history && (eligibility == "expired" || eligibility == "generation_mismatch")) {
			continue
		}
		rows = append(rows, row)
	}
	return rows
}

func (s *Store) BuildScopedMemoryIndex(scope memoryReadScope, query string, maxBytes int) Object {
	return s.read(func() any {
		maxBytes = min(3072, maxBytes, max(0, scope.InputBudget*2/50))
		if maxBytes < 256 {
			return Object{"index": "", "items": []Object{}}
		}
		eligible := s.scopedMemoryRows(scope, false) // Recheck scope/TTL even on cache hit.
		versions := []Object{}
		for _, row := range eligible {
			versions = append(versions, Object{"key": row["key"], "revision": row["revision"]})
		}
		cacheKey := memoryHash(Object{"scope": scope, "settings": s.memorySettings(scope.Project), "query": query, "versions": versions, "maxBytes": maxBytes})
		if cached, ok := s.memoryIndexCache[cacheKey]; ok && time.Now().Before(cached.expires) {
			return memoryObject(jsonText(cached.value))
		}
		rows := RankMemoryIndex(eligible, query)
		var index strings.Builder
		items := []Object{}
		for _, row := range rows {
			entry := s.memoryV2Public(row, false)
			scopeLabel := "项目"
			if row["scopeKind"] == "resources" {
				scopeLabel = strings.Join(entry["resourceNames"].([]string), "、")
			}
			line := fmt.Sprintf("- [%s](%s.md) r%d · %s · %s · %s · %s · %s\n", row["key"], row["key"], integer(row["revision"]), row["knowledgeKind"], memoryRunePrefix(stringOf(row["description"]), 80), memoryRunePrefix(scopeLabel, 36), row["verification"], memoryRunePrefix(stringOf(row["observedAt"])+stringOf(row["assertedAt"]), 10))
			if row["knowledgeKind"] == "incident_lesson" {
				line = strings.TrimSuffix(line, "\n") + " · 历史案例\n"
			}
			if row["knowledgeKind"] == "configuration" || row["knowledgeKind"] == "topology" {
				line = strings.TrimSuffix(line, "\n") + " · 版本待核对\n"
			}
			if len(items) >= 12 || index.Len()+len(line)+100 > maxBytes {
				break
			}
			index.WriteString(line)
			items = append(items, entry)
		}
		if len(items) < len(rows) {
			index.WriteString("- 可搜索更多：list_project_memories\n")
		}
		result := Object{"index": index.String(), "items": items, "revision": s.memorySettings(scope.Project)["revision"]}
		if s.memoryIndexCache == nil || len(s.memoryIndexCache) >= 64 {
			s.memoryIndexCache = map[string]memoryIndexCacheEntry{}
		}
		s.memoryIndexCache[cacheKey] = memoryIndexCacheEntry{expires: time.Now().Add(30 * time.Second), value: result}
		return result
	}).(Object)
}

func (s *Store) scopedMemoryList(scope memoryReadScope, query string, offset, limit int, history bool) Object {
	if offset < 0 || limit < 1 || limit > 50 || len([]rune(query)) > 160 {
		fail(400, "Invalid memory query")
	}
	return s.read(func() any {
		rows := s.scopedMemoryRows(scope, history)
		items := []Object{}
		for _, row := range rows {
			if query != "" && len(RankMemoryIndex([]Object{row}, query)) == 0 {
				continue
			}
			items = append(items, s.memoryV2Public(row, false))
		}
		total := len(items)
		items = items[min(offset, total):min(total, offset+limit)]
		return Object{"items": items, "total": total, "projectRevision": s.memorySettings(scope.Project)["revision"]}
	}).(Object)
}

func (s *Store) scopedMemoryRead(scope memoryReadScope, key string, history bool) Object {
	return s.read(func() any {
		s.activeProject(scope.Project)
		if s.memorySettings(scope.Project)["useEnabled"] != true {
			fail(403, "Project memory is disabled")
		}
		row := s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", scope.Project, key)
		// Do not reveal metadata for out-of-scope keys.
		if row == nil || !memoryScopeAllows(row, scope) {
			fail(404, "Memory not found in current target scope")
		}
		entry := s.memoryV2Public(row, true)
		eligible := stringOf(entry["eligibility"])
		if eligible != "eligible" && !(history && (eligible == "expired" || eligible == "generation_mismatch")) {
			delete(entry, "body")
			delete(entry, "sources")
		}
		return entry
	}).(Object)
}
