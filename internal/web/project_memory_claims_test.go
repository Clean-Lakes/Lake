package web

import (
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMemoryV2TypedClaimGeneratesCanonicalTextAndOnlyNewEvidenceRefreshes(t *testing.T) {
	s, p := memoryV2Fixture(t)
	resource := s.read(func() any { return stringOf(s.row("SELECT id FROM resources WHERE projectId=?", p)["id"]) }).(string)
	claim := ai.MemoryClaim{Field: "kubernetes.api-server", Value: "https://192.0.2.10:6443", JSONPointer: "/identity/api_server", FactKey: "kubectl.api-server", KnowledgeKind: "configuration", Subject: Object{"kind": "service", "identity": "kubectl-api", "qualifiers": Object{}}, Description: "入口 API 地址", Body: "此入口 kubectl 返回 https://192.0.2.10:6443；使用前核对当前 context。"}
	var firstUntil string
	for i := 0; i < 2; i++ {
		at := time.Now().UTC().Add(time.Duration(i-1) * time.Hour).Format(time.RFC3339Nano)
		context := &ai.MemoryEvidenceContext{CallID: "typed-call", ResourceBindings: []ai.MemoryResourceBinding{{ResourceID: resource, Generation: 1}}, FinishedAt: at, Outcome: "completed_success", ClaimSupport: "structured_result", Claims: []ai.MemoryClaim{claim}}
		snapshot, job := memoryV2JobFixture(t, s, p, "typed-"+string(rune('a'+i)), func(snapshot *ai.MemoryTurnSnapshot) {
			snapshot.Evidence = []ai.MemoryEvidence{{CallID: "other-call", Completed: false}, {CallID: "typed-call", Completed: true, Context: context}}
		})
		proposal := MemoryExtractMutationV2{Operation: "upsert", Key: "cluster-api", Type: "project", Description: "模型标题", Body: "模型额外声称所有节点已恢复健康。", SourceIDs: []string{"evidence:typed-call"}, ExpectedRevision: i, KnowledgeKind: "configuration", ScopeKind: "resources", ResourceIDs: []string{resource}, FactKey: claim.FactKey, Claim: Object{"field": claim.Field, "value": claim.Value, "sourceId": "evidence:typed-call", "jsonPointer": claim.JSONPointer}}
		if _, err := s.CommitMemoryCandidates(job, snapshot, []MemoryExtractMutationV2{proposal}, ai.Usage{}); err != nil {
			t.Fatal(err)
		}
		entry := s.ReadProjectMemory(p, proposal.Key, false)
		if entry["body"] != claim.Body || entry["verification"] != "observed" || entry["observedAt"] != at || strings.Contains(stringOf(entry["body"]), "所有节点已恢复") {
			t.Fatal("unverified prose or observation time was promoted")
		}
		if i == 0 {
			firstUntil = stringOf(entry["validUntil"])
		} else if stringOf(entry["validUntil"]) <= firstUntil {
			t.Fatal("new evidence did not refresh the horizon")
		}
	}
}

func TestMemoryV2ReviewDoesNotRefreshExpiredOperationalEvidence(t *testing.T) {
	s, p := memoryV2Fixture(t)
	resource := s.read(func() any { return stringOf(s.row("SELECT id FROM resources WHERE projectId=?", p)["id"]) }).(string)
	at := time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339Nano)
	snapshot, job := memoryV2JobFixture(t, s, p, "old-observation", func(snapshot *ai.MemoryTurnSnapshot) {
		snapshot.Evidence = []ai.MemoryEvidence{{CallID: "sample", Completed: true, Excerpt: "端口 8080", Context: &ai.MemoryEvidenceContext{CallID: "sample", ResourceBindings: []ai.MemoryResourceBinding{{ResourceID: resource, Generation: 1}}, Outcome: "completed_success", FinishedAt: at, ClaimSupport: "text_excerpt"}}}
	})
	m := MemoryExtractMutationV2{Operation: "upsert", Key: "old-port", Type: "project", Description: "历史端口", Body: "该版本曾监听 8080。", SourceIDs: []string{"evidence:sample"}, KnowledgeKind: "configuration", ScopeKind: "resources", ResourceIDs: []string{resource}, FactKey: "service.port"}
	if _, err := s.CommitMemoryCandidates(job, snapshot, []MemoryExtractMutationV2{m}, ai.Usage{}); err != nil {
		t.Fatal(err)
	}
	candidate := s.read(func() any { return s.row("SELECT * FROM projectMemoryCandidatesV2 WHERE projectId=?", p) }).(Object)
	s.DecideMemoryCandidate(p, stringOf(candidate["candidateId"]), Object{"action": "accept", "expectedProjectRevision": float64(integer(s.MemorySettings(p)["revision"])), "expectedCandidateHash": candidate["candidateHash"]})
	entry := s.ReadProjectMemory(p, m.Key, false)
	if entry["expired"] != true || entry["observedAt"] != at {
		t.Fatal("review refreshed an expired operational fact")
	}
}
