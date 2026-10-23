package web

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestMemoryV2RetrievalScopesRelationsAndKnownKeys(t *testing.T) {
	s, p := memoryV2Fixture(t)
	a := stringOf(s.CreateResource(p, "Node A", "ssh", Object{"host": "192.0.2.11", "port": 22, "username": "fixture"})["id"])
	b := stringOf(s.CreateResource(p, "Node B", "ssh", Object{"host": "192.0.2.12", "port": 22, "username": "fixture"})["id"])
	m := memoryV2Mutation("database-route")
	m.Description = "数据库域名解析"
	m.Details = &MemoryDetails{KnowledgeKind: "topology", ScopeKind: "resources", ResourceIDs: []string{a, b}, FactKey: "database.route"}
	s.CommitMemoryV2(p, m)
	scope := memoryReadScope{Project: p, ResourceIDs: []string{a}, InputBudget: 64000}
	if got := s.BuildScopedMemoryIndex(scope, "数据库", 3072); stringOf(got["index"]) != "" {
		t.Fatal("relation leaked through a single endpoint")
	}
	expectPanic(t, 404, func() { s.scopedMemoryRead(scope, m.Key, true) })
	scope.ResourceIDs = []string{a, b}
	for i := 0; i < 2; i++ {
		if got := stringOf(s.BuildScopedMemoryIndex(scope, "数据库", 3072)["index"]); !strings.Contains(got, m.Key) {
			t.Fatal("scoped relation not found")
		}
	}
	s.EditTerminalResource(a, "Renamed A", Object{"host": "192.0.2.11", "port": 22, "username": "fixture"}, false)
	if got := stringOf(s.BuildScopedMemoryIndex(scope, "数据库", 3072)["index"]); !strings.Contains(got, "Renamed A") {
		t.Fatal("cached resource name survived rename")
	}
	s.EditTerminalResource(a, "Renamed A", Object{"host": "192.0.2.21", "port": 22, "username": "fixture"}, true)
	if got := stringOf(s.BuildScopedMemoryIndex(scope, "数据库", 3072)["index"]); got != "" {
		t.Fatal("cache bypassed changed resource generation")
	}
	history := s.scopedMemoryRead(scope, m.Key, true)
	if history["eligibility"] != "generation_mismatch" || history["body"] == nil {
		t.Fatal("history not explicitly marked")
	}
	ordinary := s.scopedMemoryRead(scope, m.Key, false)
	if ordinary["body"] != nil {
		t.Fatal("ordinary direct read returned stale body")
	}
	other := stringOf(s.CreateProject("Other")["id"])
	expectPanic(t, 404, func() { s.scopedMemoryRead(memoryReadScope{Project: other, ResourceIDs: []string{a, b}}, m.Key, true) })
}

func BenchmarkMemoryV2ScopedIndex500(b *testing.B) {
	s, p := memoryV2Fixture(b)
	s.update(func() any {
		for i := 0; i < 500; i++ {
			m := memoryV2Mutation(fmt.Sprintf("rule-%03d", i))
			m.Description = "备份" + strings.Repeat("说明", 77)
			s.commitMemoryV2Locked(p, m, nil, true)
		}
		return nil
	})
	scope := memoryReadScope{Project: p, InputBudget: 200000}
	for i := 0; i < 20; i++ {
		s.BuildScopedMemoryIndex(scope, "备份", 3072)
	}
	samples := make([]int64, 0, b.N)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		start := time.Now()
		s.BuildScopedMemoryIndex(scope, "备份", 3072)
		samples = append(samples, time.Since(start).Nanoseconds())
	}
	b.StopTimer()
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	b.ReportMetric(float64(samples[len(samples)/2])/1e6, "p50-ms")
	b.ReportMetric(float64(samples[min(len(samples)-1, len(samples)*95/100)])/1e6, "p95-ms")
}

func TestMemoryV2IndexBoundedDeterministicAndSearchableInChinese(t *testing.T) {
	s, p := memoryV2Fixture(t)
	// Insert fixtures transactionally to measure retrieval rather than projection I/O.
	s.update(func() any {
		for i := 0; i < 500; i++ {
			m := memoryV2Mutation(fmt.Sprintf("rule-%03d", i))
			m.Description = "发布备份检查 " + strings.Repeat("说明", 65)
			s.commitMemoryV2Locked(p, m, nil, true)
		}
		return nil
	})
	scope := memoryReadScope{Project: p, InputBudget: 200000}
	first := s.BuildScopedMemoryIndex(scope, "备份", 3072)
	index := stringOf(first["index"])
	if len(index) > 3072 || len(memoryObjects(first["items"])) > 12 || !strings.Contains(index, "rule-000") || strings.Contains(index, "先核对备份是否可恢复") {
		t.Fatal("index budget/order/body leak")
	}
	if second := s.BuildScopedMemoryIndex(scope, "备份", 3072); stringOf(second["index"]) != index {
		t.Fatal("ranking is nondeterministic")
	}
	if got := stringOf(s.BuildScopedMemoryIndex(scope, "不存在的主题", 3072)["index"]); got != "" {
		t.Fatal("zero-score ordinary records were injected")
	}
	if got := stringOf(s.BuildScopedMemoryIndex(scope, "备份", 128)["index"]); got != "" {
		t.Fatal("insufficient budget still injected memory")
	}
	start := time.Now()
	for i := 0; i < 20; i++ {
		s.BuildScopedMemoryIndex(scope, "备份", 3072)
	}
	t.Logf("500-entry retrieval average=%s", time.Since(start)/20)
}

func TestMemoryV2ProjectionIsRebuildableAndPrivate(t *testing.T) {
	s, p := memoryV2Fixture(t)
	s.CommitMemoryV2(p, memoryV2Mutation("rebuild-check"))
	if err := s.PublishProjectMemory(p); err != nil {
		t.Fatal(err)
	}
	if n := s.read(func() any {
		return integer(s.row("SELECT count(*) AS n FROM projectMemoryEntriesV2 WHERE projectId=?", p)["n"])
	}).(int); n != 1 {
		t.Fatal("publication changed canonical entries")
	}
	if integer(s.MemorySettings(p)["memorySchemaVersion"]) != 2 {
		t.Fatal("missing capability version")
	}
}
