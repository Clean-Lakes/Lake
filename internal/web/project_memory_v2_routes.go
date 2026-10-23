package web

import (
	"net/http"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) memoryV2Route(w http.ResponseWriter, r *http.Request, parts []string, method string) bool {
	project := parts[2]
	if len(parts) == 4 && parts[3] == "memory-classification" && method == "POST" {
		data := body(w, r, 16384)
		memoryFields(data, "items", "expectedProjectRevision", "knowledgeKind", "scopeKind", "resourceIds")
		items, ok := data["items"].([]any)
		if !ok || len(items) == 0 || len(items) > 50 {
			fail(400, "Choose 1 to 50 memories for classification")
		}
		rows := []Object{}
		for _, item := range items {
			row, ok := item.(map[string]any)
			if !ok {
				fail(400, "Invalid memory classification item")
			}
			memoryFields(row, "key", "expectedRevision")
			rows = append(rows, row)
		}
		reply(w, 200, b.Store.ClassifyLegacyMemoriesV2(project, rows, memoryRevision(data["expectedProjectRevision"]), memoryDetailsFrom(data)))
		return true
	}
	if len(parts) == 4 && parts[3] == "memory-jobs" && method == "GET" {
		b.Store.Project(project)
		offset, limit := memoryQueryInt(r, "offset", 0), memoryQueryInt(r, "limit", 50)
		if offset < 0 || limit < 1 || limit > 50 {
			fail(400, "Invalid memory pagination")
		}
		items := b.Store.read(func() any {
			return b.Store.rows(`SELECT j.jobId,j.status,j.attempts,j.lastErrorCode,j.usageJSON,j.createdAt,j.updatedAt,
 (SELECT count(*) FROM projectMemoryJobAttemptsV2 a WHERE a.jobId=j.jobId) AS dispatchCount,
 (SELECT count(*) FROM projectMemoryJobAttemptsV2 a WHERE a.jobId=j.jobId AND a.usageKnown=0) AS unknownAttempts,
 (SELECT COALESCE(sum(a.inputUsage+a.outputUsage),0) FROM projectMemoryJobAttemptsV2 a WHERE a.jobId=j.jobId AND a.usageKnown=1) AS knownTokens
 FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.projectId=? ORDER BY j.createdAt DESC LIMIT ? OFFSET ?`, project, limit, offset)
		}).([]Object)
		reply(w, 200, Object{"items": items})
		return true
	}
	if len(parts) == 4 && parts[3] == "memory-candidates" && method == "GET" {
		b.Store.Project(project)
		offset, limit := memoryQueryInt(r, "offset", 0), memoryQueryInt(r, "limit", 50)
		if offset < 0 || limit < 1 || limit > 50 {
			fail(400, "Invalid memory pagination")
		}
		items := b.Store.read(func() any {
			return b.Store.rows("SELECT candidateId,candidateHash,baseKey,baseRevision,proposalJSON,reason,status,createdAt,expiresAt FROM projectMemoryCandidatesV2 WHERE projectId=? AND status='pending' AND expiresAt>? ORDER BY createdAt,candidateId LIMIT ? OFFSET ?", project, now(), limit, offset)
		}).([]Object)
		for _, item := range items {
			item["proposal"] = memoryObject(item["proposalJSON"])
			delete(item, "proposalJSON")
		}
		reply(w, 200, Object{"items": items})
		return true
	}
	if len(parts) == 6 && parts[3] == "memory-candidates" && parts[5] == "decision" && method == "POST" {
		data := body(w, r, 8192)
		memoryFields(data, "action", "expectedProjectRevision", "expectedCandidateHash", "resourceIds", "subject", "knowledgeKind", "scopeKind")
		result := b.Store.DecideMemoryCandidate(project, parts[4], data)
		reply(w, 200, result)
		return true
	}
	if len(parts) == 7 && parts[3] == "memory" && parts[5] == "sources" && method == "GET" {
		link := b.Store.ResolveMemorySourceLink(project, parts[4], parts[6])
		if evidence := stringOf(link["evidenceId"]); evidence != "" && !b.Engine.RecordedMemoryEvidenceAvailable(stringOf(link["sessionId"]), evidence) {
			link["available"] = false
			link["reason"] = "evidence_unavailable"
		}
		reply(w, 200, link)
		return true
	}
	if len(parts) == 4 && parts[3] == "memory" && method == "GET" {
		result := b.Store.listMemoriesV2(project, r.URL.Query().Get("query"), memoryQueryInt(r, "offset", 0), memoryQueryInt(r, "limit", 50), r.URL.Query().Get("includeExpired") == "true" || r.URL.Query().Get("history") == "true", r.URL.Query().Get("includeDeleted") == "true", Object{"knowledgeKind": r.URL.Query().Get("knowledgeKind"), "reviewState": r.URL.Query().Get("reviewState"), "resourceId": r.URL.Query().Get("resourceId"), "history": r.URL.Query().Get("history") == "true"})
		reply(w, 200, result)
		return true
	}
	if len(parts) == 5 && parts[3] == "memory" && method == "PUT" {
		data := body(w, r, 32*1024)
		memoryFields(data, "type", "description", "body", "expectedRevision", "restoreDeleted", "validUntil", "knowledgeKind", "scopeKind", "resourceIds", "subject", "factKey", "alwaysReference", "reviewState")
		model := b.Models.Active()
		if model == nil {
			model = &ai.Model{}
		}
		if b.Terminals.containsCredential(jsonText(data)) || !ai.SafeMemoryContent(jsonText(data), *model) {
			fail(400, "Credentials cannot be saved in project memory")
		}
		reply(w, 200, b.Store.CommitMemoryV2(project, MemoryMutation{Key: parts[4], Type: stringOf(data["type"]), Description: stringOf(data["description"]), Body: stringOf(data["body"]), ExpectedRevision: memoryRevision(data["expectedRevision"]), RestoreDeleted: data["restoreDeleted"] == true, ValidUntil: stringOf(data["validUntil"]), Verification: "user-stated", SourceKind: "manual-ui", Details: memoryDetailsFrom(data)}))
		return true
	}
	return false
}

// The user selects and reviews existing bodies; classification never copies a
// client supplied body or turns legacy observations into fresh evidence.
func (s *Store) ClassifyLegacyMemoriesV2(project string, items []Object, projectRevision int, details *MemoryDetails) Object {
	if details == nil {
		fail(422, "scope_required")
	}
	if len(items) == 0 || len(items) > 50 {
		fail(400, "Choose 1 to 50 memories for classification")
	}
	result := s.update(func() any {
		s.activeProject(project)
		if integer(s.memorySettings(project)["revision"]) != projectRevision {
			fail(409, "Project memory changed; refresh before classifying")
		}
		seen := map[string]bool{}
		for _, item := range items {
			key := stringOf(item["key"])
			if seen[key] {
				fail(400, "Duplicate memory classification item")
			}
			seen[key] = true
			old := required(s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", project, key), "Memory")
			if old["reviewState"] != "needs_review" || stringOf(old["deletedAt"]) != "" {
				fail(409, "Only unclassified memories can be classified together")
			}
			d := *details
			d.Subject = memoryObject(old["subjectJSON"])
			d.FactKey = stringOf(old["factKey"])
			m := MemoryMutation{Key: key, Type: stringOf(old["type"]), Description: stringOf(old["description"]), Body: stringOf(old["body"]), ExpectedRevision: memoryRevision(item["expectedRevision"]), Details: &d, Verification: "user-stated", SourceKind: "manual-ui"}
			ValidateMemoryV2(m)
			s.commitMemoryV2Locked(project, m, nil, false)
		}
		return Object{"classified": len(items), "projectRevision": s.memorySettings(project)["revision"]}
	}).(Object)
	if err := s.PublishProjectMemory(project); err != nil {
		result["publicationError"] = "分类已保存，文件投影待修复；下次启动将重试。"
	}
	return result
}

func (s *Store) DecideMemoryCandidate(project, id string, data Object) Object {
	result := s.update(func() any {
		settings := s.memorySettings(project)
		if integer(settings["revision"]) != memoryRevision(data["expectedProjectRevision"]) {
			fail(409, "Project memory changed; refresh before review")
		}
		candidate := required(s.row("SELECT * FROM projectMemoryCandidatesV2 WHERE projectId=? AND candidateId=?", project, id), "Memory candidate")
		if candidate["candidateHash"] != data["expectedCandidateHash"] || candidate["status"] != "pending" {
			fail(409, "Memory candidate changed")
		}
		until, _ := time.Parse(time.RFC3339Nano, stringOf(candidate["expiresAt"]))
		if !time.Now().Before(until) {
			fail(410, "Memory candidate expired")
		}
		action := stringOf(data["action"])
		if action == "reject" {
			s.exec("UPDATE projectMemoryCandidatesV2 SET status='rejected',proposalJSON='' WHERE candidateId=?", id)
			return Object{"status": "rejected"}
		}
		if action != "accept" {
			fail(400, "Invalid candidate decision")
		}
		proposal := memoryObject(candidate["proposalJSON"])
		key := stringOf(candidate["baseKey"])
		old := s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", project, key)
		if stringOf(old["deletedAt"]) != "" || integer(old["revision"]) != integer(candidate["baseRevision"]) {
			fail(409, "Memory changed after candidate was created")
		}
		for _, field := range []string{"resourceIds", "subject", "knowledgeKind", "scopeKind"} {
			if value, ok := data[field]; ok {
				proposal[field] = value
			}
		}
		if proposal["factKey"] == nil {
			proposal["factKey"] = "legacy." + key
		}
		m := MemoryMutation{Key: key, Type: stringOf(proposal["type"]), Description: stringOf(proposal["description"]), Body: stringOf(proposal["body"]), ExpectedRevision: integer(candidate["baseRevision"]), Verification: "user-stated", SourceKind: "review", Details: memoryDetailsFrom(proposal)}
		if m.Details.KnowledgeKind == "" {
			m.Details.KnowledgeKind = "procedure"
		}
		ValidateMemoryV2(m)
		sources := memoryObjects(proposal["sources"])
		// A review is not a fresh sample. Any evidence binding must still match.
		for _, source := range sources {
			if ref := stringOf(source["resourceId"]); ref != "" {
				generation := s.row("SELECT generation FROM resourceMemoryGenerations WHERE resourceId=?", ref)
				if integer(generation["generation"]) != integer(source["resourceGeneration"]) {
					fail(409, "Candidate resource changed; collect new evidence")
				}
			}
		}
		sources = append(sources, Object{"kind": "review", "assertedAt": now(), "outcome": "user_stated"})
		out := s.commitMemoryV2Locked(project, m, sources, false)
		// Operational candidates retain their original evidence/assertion horizon.
		if m.Details.KnowledgeKind == "topology" || m.Details.KnowledgeKind == "configuration" || m.Details.KnowledgeKind == "incident_lesson" {
			entry := s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", project, key)
			entry["assertedAt"] = ""
			for _, source := range sources {
				if at := stringOf(source["assertedAt"]); source["kind"] != "review" && at != "" && (stringOf(entry["assertedAt"]) == "" || at < stringOf(entry["assertedAt"])) {
					entry["assertedAt"] = at
				}
				if at := stringOf(source["observedAt"]); at != "" && (source["outcome"] == "completed_success" || m.Details.KnowledgeKind == "incident_lesson" && source["outcome"] == "completed_failure") && (stringOf(entry["observedAt"]) == "" || at < stringOf(entry["observedAt"])) {
					entry["observedAt"] = at
				}
			}
			entry["validUntil"] = DeriveMemoryValidity(entry, old)
			if entry["observedAt"] != "" {
				entry["verification"] = "observed"
			}
			s.writeMemoryV2Row(entry)
			s.exec("UPDATE projectMemoryRevisionsV2 SET snapshotJSON=? WHERE projectId=? AND key=? AND revision=?", jsonText(entry), project, key, entry["revision"])
		}
		s.exec("UPDATE projectMemoryCandidatesV2 SET status='accepted',proposalJSON='' WHERE candidateId=?", id)
		out["status"] = "accepted"
		return out
	}).(Object)
	_ = s.PublishProjectMemory(project)
	return result
}

func (s *Store) ResolveMemorySourceLink(project, key, sourceID string) Object {
	return s.read(func() any {
		s.activeProject(project)
		row := required(s.row("SELECT * FROM projectMemorySourcesV2 WHERE projectId=? AND key=? AND sourceId=?", project, key, sourceID), "Memory source")
		session := s.row("SELECT id FROM sessions WHERE id=? AND projectId=? AND "+activeSessionsSQL, row["sessionId"], project)
		if session == nil {
			return Object{"available": false, "reason": "source_unavailable", "source": row}
		}
		if row["messageId"] == "" || s.row("SELECT id FROM messages WHERE id=? AND sessionId=?", row["messageId"], row["sessionId"]) == nil {
			return Object{"available": false, "reason": "turn_unavailable", "source": row}
		}
		return Object{"available": true, "sessionId": row["sessionId"], "turnId": row["turnId"], "messageId": row["messageId"], "evidenceId": row["evidenceId"], "source": row}
	}).(Object)
}
