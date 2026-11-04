package web

import (
	"testing"
	"time"
)

func TestMemoryV2ReviewDoesNotRefreshExpiredOperationalEvidence(t *testing.T) {
	s, p := memoryV2Fixture(t)
	resource := s.read(func() any { return stringOf(s.row("SELECT id FROM resources WHERE projectId=?", p)["id"]) }).(string)
	at := time.Now().UTC().Add(-48 * time.Hour).Format(time.RFC3339Nano)
	s.update(func() any {
		s.insertMemoryCandidate(p, "historical-job", "old-port", 0, Object{
			"type": "project", "description": "历史端口", "body": "该版本曾监听 8080。",
			"knowledgeKind": "configuration", "scopeKind": "resources", "resourceIds": []string{resource}, "factKey": "service.port",
			"sources": []Object{{"kind": "evidence", "callId": "sample", "resourceId": resource, "resourceGeneration": 1, "observedAt": at, "outcome": "completed_success"}},
		}, "unverified")
		return nil
	})
	candidate := s.read(func() any { return s.row("SELECT * FROM projectMemoryCandidatesV2 WHERE projectId=?", p) }).(Object)
	s.DecideMemoryCandidate(p, stringOf(candidate["candidateId"]), Object{"action": "accept", "expectedProjectRevision": float64(integer(s.MemorySettings(p)["revision"])), "expectedCandidateHash": candidate["candidateHash"]})
	entry := s.ReadProjectMemory(p, "old-port", false)
	if entry["expired"] != true || entry["observedAt"] != at {
		t.Fatal("review refreshed an expired operational fact")
	}
}
