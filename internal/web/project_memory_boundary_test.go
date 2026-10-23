package web

import (
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMemoryV2ManualEditCannotRefreshGenerationOrObservation(t *testing.T) {
	s, p := memoryV2Fixture(t)
	r := stringOf(s.CreateResource(p, "Node", "ssh", Object{"host": "192.0.2.11", "port": 22, "username": "fixture"})["id"])
	m := memoryV2Mutation("node-port")
	m.Details = &MemoryDetails{KnowledgeKind: "configuration", ScopeKind: "resources", ResourceIDs: []string{r}, FactKey: "service.port", Subject: Object{"kind": "service", "identity": "api", "conditions": "version A"}}
	s.CommitMemoryV2(p, m)
	at := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	s.update(func() any {
		s.exec("UPDATE projectMemoryEntriesV2 SET observedAt=?,verification='observed' WHERE projectId=? AND key=?", at, p, m.Key)
		return nil
	})
	oldUntil := s.ReadProjectMemory(p, m.Key, false)["validUntil"]
	m.ExpectedRevision = 1
	m.Details.Subject["conditions"] = "version B"
	s.CommitMemoryV2(p, m)
	entry := s.ReadProjectMemory(p, m.Key, false)
	if entry["observedAt"] != "" || entry["validUntil"] != oldUntil {
		t.Fatal("changed subject retained or refreshed old observation")
	}
	s.EditTerminalResource(r, "Node", Object{"host": "192.0.2.12", "port": 22, "username": "fixture"}, true)
	m.ExpectedRevision = 2
	s.CommitMemoryV2(p, m)
	if s.ReadProjectMemory(p, m.Key, false)["eligibility"] != "generation_mismatch" {
		t.Fatal("manual resave rebound old evidence to new resource generation")
	}
}

func TestMemoryV2ExtractorCannotCiteEvidenceOmittedByBudget(t *testing.T) {
	s, p := memoryV2Fixture(t)
	snapshot := ai.MemoryTurnSnapshot{ProjectID: p, UserText: "记住发布检查", Evidence: []ai.MemoryEvidence{{CallID: "omitted", Excerpt: strings.Repeat("x", 30000)}, {CallID: "retained", Excerpt: "small"}}}
	messages, err := s.memoryExtractionInputV2(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(messages[1].Content, "omitted") {
		t.Fatal("fixture did not trim evidence")
	}
	for _, tc := range []struct {
		id      string
		allowed bool
	}{{"user:0", true}, {"evidence:retained", true}, {"evidence:omitted", false}, {"evidence:invented", false}} {
		err := validateMemoryExtractionSources(messages, []MemoryExtractMutationV2{{SourceIDs: []string{tc.id}}})
		if (err == nil) != tc.allowed {
			t.Fatalf("source %s allowed=%v", tc.id, err == nil)
		}
	}
}

func TestMemoryV2ExtractionIndexDoesNotLeakAnotherResource(t *testing.T) {
	s, p := memoryV2Fixture(t)
	a := stringOf(s.CreateResource(p, "A", "ssh", Object{"host": "192.0.2.10", "port": 22, "username": "fixture"})["id"])
	b := stringOf(s.CreateResource(p, "B", "ssh", Object{"host": "192.0.2.20", "port": 22, "username": "fixture"})["id"])
	for _, r := range []string{a, b} {
		m := memoryV2Mutation("port-" + r)
		m.Description = "入口端口"
		m.Details = &MemoryDetails{KnowledgeKind: "configuration", ScopeKind: "resources", ResourceIDs: []string{r}, FactKey: "service.port"}
		s.CommitMemoryV2(p, m)
	}
	messages, err := s.memoryExtractionInputV2(ai.MemoryTurnSnapshot{ProjectID: p, UserText: "入口端口", TargetBindings: []ai.MemoryResourceBinding{{ResourceID: a, Generation: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(messages[1].Content, "port-"+a) || strings.Contains(messages[1].Content, "port-"+b) {
		t.Fatal("extraction index bypassed trusted target")
	}
}

func TestMemoryV2LegacyClassificationIsAtomicAndCannotRefreshTime(t *testing.T) {
	s, p := memoryV2Fixture(t)
	r := stringOf(s.CreateResource(p, "Node", "ssh", Object{"host": "192.0.2.11", "port": 22, "username": "fixture"})["id"])
	for _, key := range []string{"legacy-a", "legacy-b"} {
		s.CommitMemoryV2(p, memoryV2Mutation(key))
		s.update(func() any {
			s.exec("UPDATE projectMemoryEntriesV2 SET reviewState='needs_review',assertedAt='',observedAt='' WHERE projectId=? AND key=?", p, key)
			return nil
		})
	}
	revision := integer(s.MemorySettings(p)["revision"])
	details := &MemoryDetails{KnowledgeKind: "configuration", ScopeKind: "resources", ResourceIDs: []string{r}}
	items := []Object{{"key": "legacy-a", "expectedRevision": float64(1)}, {"key": "legacy-b", "expectedRevision": float64(99)}}
	expectPanic(t, 409, func() { s.ClassifyLegacyMemoriesV2(p, items, revision, details) })
	if s.ReadProjectMemory(p, "legacy-a", false)["reviewState"] != "needs_review" {
		t.Fatal("batch conflict partially classified data")
	}
	items[1]["expectedRevision"] = float64(1)
	s.ClassifyLegacyMemoriesV2(p, items, revision, details)
	for _, key := range []string{"legacy-a", "legacy-b"} {
		e := s.ReadProjectMemory(p, key, false)
		if e["body"] != "发布前先核对备份是否可恢复。" || e["observedAt"] != "" || e["eligibility"] != "expired" {
			t.Fatal("classification changed content or made legacy facts fresh")
		}
	}
}

func TestMemoryV2DisableRechecksAllStoreReadsIncludingCachedIndex(t *testing.T) {
	s, p := memoryV2Fixture(t)
	s.CommitMemoryV2(p, memoryV2Mutation("backup-method"))
	scope := memoryReadScope{Project: p, InputBudget: 200000}
	if stringOf(s.BuildScopedMemoryIndex(scope, "备份", 3072)["index"]) == "" {
		t.Fatal("fixture index empty")
	}
	s.SetMemorySettings(p, false, true, integer(s.MemorySettings(p)["settingsRevision"]))
	if stringOf(s.BuildScopedMemoryIndex(scope, "备份", 3072)["index"]) != "" || integer(s.scopedMemoryList(scope, "", 0, 50, true)["total"]) != 0 {
		t.Fatal("disabled memory bypassed store recheck")
	}
	expectPanic(t, 403, func() { s.scopedMemoryRead(scope, "backup-method", true) })
}
