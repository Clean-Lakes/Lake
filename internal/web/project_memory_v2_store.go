package web

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type MemoryDetails struct {
	KnowledgeKind   string   `json:"knowledgeKind"`
	ScopeKind       string   `json:"scopeKind"`
	ResourceIDs     []string `json:"resourceIds"`
	Subject         Object   `json:"subject"`
	FactKey         string   `json:"factKey"`
	AlwaysReference bool     `json:"alwaysReference"`
	ReviewState     string   `json:"reviewState,omitempty"`
}

var memoryFactPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:/-]{0,95}$`)

var memoryV2Columns = strings.Fields("projectId key type description body revision projectRevision contentHash knowledgeKind scopeKind scopeHash subjectJSON claimJSON factKey bindingsJSON verification assertedAt observedAt validUntil reviewState alwaysReference originSessionId originTurnId createdAt updatedAt deletedAt")

func memoryHash(value any) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(jsonText(value)))) }

func memoryObjects(raw any) []Object {
	var out []Object
	if text, ok := raw.(string); ok {
		_ = json.Unmarshal([]byte(text), &out)
	} else {
		out = objects(raw)
	}
	if out == nil {
		return []Object{}
	}
	return out
}

func memoryObject(raw any) Object {
	var out Object
	if text, ok := raw.(string); ok {
		_ = json.Unmarshal([]byte(text), &out)
	} else {
		out = object(raw)
	}
	if out == nil {
		return Object{}
	}
	return out
}

func (s *Store) writeMemoryV2Row(row Object) {
	values := make([]any, 0, len(memoryV2Columns))
	updates := make([]string, 0, len(memoryV2Columns)-2)
	for i, field := range memoryV2Columns {
		values = append(values, row[field])
		if i > 1 {
			updates = append(updates, field+"=excluded."+field)
		}
	}
	s.exec("INSERT INTO projectMemoryEntriesV2("+strings.Join(memoryV2Columns, ",")+") VALUES("+strings.TrimSuffix(strings.Repeat("?,", len(values)), ",")+") ON CONFLICT(projectId,key) DO UPDATE SET "+strings.Join(updates, ","), values...)
}

func memoryV2Tombstone(old Object, revision, projectRevision int, at string) Object {
	row := Object{}
	for _, field := range memoryV2Columns {
		row[field] = ""
	}
	for _, field := range []string{"projectId", "key", "createdAt"} {
		row[field] = old[field]
	}
	row["revision"], row["projectRevision"], row["alwaysReference"] = revision, projectRevision, 0
	row["deletedAt"], row["updatedAt"], row["reviewState"] = at, at, "disabled"
	row["subjectJSON"], row["claimJSON"], row["bindingsJSON"] = "{}", "{}", "[]"
	return row
}

func (s *Store) appendMemoryV2Source(entry, source Object) {
	id := ident()
	if v := stringOf(source["sourceId"]); v != "" {
		id = v
	}
	excerpt := memoryPrefix(stringOf(source["excerpt"]), 512)
	s.exec(`INSERT OR IGNORE INTO projectMemorySourcesV2(sourceId,projectId,key,entryRevision,kind,sessionId,turnId,messageId,callId,evidenceId,resourceId,resourceGeneration,observedAt,assertedAt,outcome,excerpt,sourceHash,claimSupport) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, entry["projectId"], entry["key"], entry["revision"], stringOf(source["kind"]), stringOf(source["sessionId"]), stringOf(source["turnId"]), stringOf(source["messageId"]), stringOf(source["callId"]), stringOf(source["evidenceId"]), stringOf(source["resourceId"]), integer(source["resourceGeneration"]), stringOf(source["observedAt"]), stringOf(source["assertedAt"]), stringOf(source["outcome"]), excerpt, memoryHash(source), stringOf(source["claimSupport"]))
	s.exec(`UPDATE projectMemorySourcesV2 SET excerpt='',kind='',sessionId='',turnId='',messageId='',callId='',evidenceId='',resourceId='',resourceGeneration=0,observedAt='',assertedAt='',outcome='',claimSupport=''
 WHERE projectId=? AND key=? AND sourceId NOT IN (SELECT sourceId FROM projectMemorySourcesV2 WHERE projectId=? AND key=? ORDER BY entryRevision DESC,rowid DESC LIMIT 8)`, entry["projectId"], entry["key"], entry["projectId"], entry["key"])
}

func ValidateMemoryV2(m MemoryMutation, allowUnbound ...bool) {
	validateMemoryMutation(m)
	if m.Forget {
		return
	}
	if m.Details == nil {
		fail(422, "scope_required")
	}
	d := m.Details
	if d.ScopeKind == "" || d.KnowledgeKind == "" {
		fail(422, "scope_required")
	}
	if d.ReviewState != "" && d.ReviewState != "active" && d.ReviewState != "disabled" {
		fail(400, "Invalid memory state")
	}
	if !set("preference procedure topology configuration incident_lesson")[d.KnowledgeKind] || !set("project resources")[d.ScopeKind] || !memoryFactPattern.MatchString(d.FactKey) {
		fail(400, "Invalid memory classification")
	}
	if d.ScopeKind == "project" && (len(d.ResourceIDs) != 0 || d.KnowledgeKind != "preference" && d.KnowledgeKind != "procedure") || d.ScopeKind == "resources" && (len(d.ResourceIDs) == 0 && (len(allowUnbound) == 0 || !allowUnbound[0]) || len(d.ResourceIDs) > 32) {
		fail(422, "Invalid memory resource scope")
	}
	if d.AlwaysReference && (d.ScopeKind != "project" || d.KnowledgeKind != "preference" && d.KnowledgeKind != "procedure") {
		fail(400, "Only project preferences or methods can be always referenced")
	}
	if len(jsonText(d.Subject)) > 2048 || !ai.SafeMemoryContent(jsonText(m), ai.Model{}) {
		fail(400, "Unsafe memory content")
	}
	if len(d.Subject) > 0 {
		memoryFields(d.Subject, "kind", "identity", "qualifiers", "conditions")
		if !set("none service kubernetes_workload database artifact")[stringOf(d.Subject["kind"])] {
			fail(400, "Invalid memory subject")
		}
		memoryFields(object(d.Subject["qualifiers"]), "namespace", "workloadKind", "workloadName", "workloadUID", "imageDigest", "configRevision", "serviceName", "databaseName")
		for key, value := range d.Subject {
			if key == "qualifiers" {
				qualifiers, ok := value.(map[string]any)
				if !ok {
					fail(400, "Invalid memory qualifiers")
				}
				for _, v := range qualifiers {
					if _, ok := v.(string); !ok {
						fail(400, "Invalid memory qualifier")
					}
				}
			} else if _, ok := value.(string); !ok {
				fail(400, "Invalid memory subject field")
			}
		}
	}
}

func (s *Store) memoryV2Public(row Object, details bool) Object {
	if stringOf(row["deletedAt"]) != "" {
		return Object{"projectId": row["projectId"], "key": row["key"], "revision": row["revision"], "deletedAt": row["deletedAt"], "eligibility": "deleted"}
	}
	entry := Object{}
	for _, field := range memoryV2Columns {
		if !strings.HasSuffix(field, "JSON") && field != "contentHash" && field != "scopeHash" && (details || field != "body") {
			entry[field] = row[field]
		}
	}
	entry["alwaysReference"] = integer(row["alwaysReference"]) != 0
	entry["subject"], entry["bindings"] = memoryObject(row["subjectJSON"]), memoryObjects(row["bindingsJSON"])
	entry["resourceIds"] = []string{}
	names := []string{}
	ids := []string{}
	for _, binding := range memoryObjects(row["bindingsJSON"]) {
		id := stringOf(binding["resourceId"])
		ids = append(ids, id)
		if r := s.row("SELECT name FROM resources WHERE id=? AND projectId=?", id, row["projectId"]); r != nil {
			names = append(names, stringOf(r["name"]))
		}
	}
	entry["resourceIds"], entry["resourceNames"] = ids, names
	entry["eligibility"] = s.EvaluateMemoryEligibility(row, time.Now().UTC())
	entry["expired"], entry["historical"] = memoryExpired(row, time.Now().UTC()), row["knowledgeKind"] == "incident_lesson"
	if details {
		entry["sources"] = s.rows("SELECT sourceId,kind,sessionId,turnId,messageId,callId,evidenceId,resourceId,observedAt,assertedAt,outcome,excerpt,claimSupport,COALESCE(NULLIF(observedAt,''),assertedAt) AS at FROM projectMemorySourcesV2 WHERE projectId=? AND key=? ORDER BY entryRevision DESC,rowid DESC LIMIT 8", row["projectId"], row["key"])
	}
	return entry
}

func (s *Store) listMemoriesV2(project, query string, offset, limit int, includeExpired, includeDeleted bool, filters ...Object) Object {
	if offset < 0 || limit < 1 || limit > 50 || len([]rune(query)) > 160 {
		fail(400, "Invalid memory query")
	}
	return s.read(func() any {
		settings := s.memorySettings(project)
		items := []Object{}
		q := strings.ToLower(strings.TrimSpace(query))
		for _, row := range s.rows("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? ORDER BY updatedAt DESC,key", project) {
			if !includeDeleted && stringOf(row["deletedAt"]) != "" || !includeExpired && memoryExpired(row, time.Now().UTC()) {
				continue
			}
			if q != "" && !strings.Contains(strings.ToLower(stringOf(row["key"])+" "+stringOf(row["description"])), q) {
				continue
			}
			items = append(items, s.memoryV2Public(row, false))
			if len(filters) > 0 {
				filter := filters[0]
				entry := items[len(items)-1]
				keep := true
				if kind := stringOf(filter["knowledgeKind"]); kind != "" && entry["knowledgeKind"] != kind {
					keep = false
				}
				if state := stringOf(filter["reviewState"]); state != "" && entry["reviewState"] != state && entry["eligibility"] != state {
					keep = false
				}
				if ref := stringOf(filter["resourceId"]); ref != "" {
					found := false
					for _, b := range memoryObjects(row["bindingsJSON"]) {
						found = found || b["resourceId"] == ref
					}
					keep = keep && found
				}
				if filter["history"] == true {
					keep = keep && (entry["eligibility"] == "expired" || entry["eligibility"] == "generation_mismatch" || entry["eligibility"] == "disabled" || entry["historical"] == true)
				}
				if !keep {
					items = items[:len(items)-1]
				}
			}
		}
		total := len(items)
		items = items[min(offset, total):min(offset+limit, total)]
		return Object{"settings": settings, "items": items, "total": total, "projectRevision": settings["revision"]}
	}).(Object)
}

func (s *Store) readMemoryV2(project, key string, includeDeleted bool) Object {
	return s.read(func() any {
		s.activeProject(project)
		row := required(s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", project, key), "Memory")
		if !includeDeleted && stringOf(row["deletedAt"]) != "" {
			fail(404, "Memory not found")
		}
		return s.memoryV2Public(row, true)
	}).(Object)
}

func (s *Store) CommitMemoryV2(project string, m MemoryMutation) Object {
	ValidateMemoryV2(m)
	result := s.update(func() any { return s.commitMemoryV2Locked(project, m, nil, false) }).(Object)
	if err := s.PublishProjectMemory(project); err != nil {
		result["publicationError"] = "记忆已保存到数据库，文件投影待修复；下次启动将重试。"
		if m.Forget {
			result["publicationError"] = "数据库中的记忆已遗忘，文件清理尚未完成；下次启动将重试。"
		}
	}
	return result
}

// The caller owns the transaction. Automatic commits never increase epoch, so
// another source turn remains eligible; manual edits invalidate earlier jobs.
func (s *Store) commitMemoryV2Locked(project string, m MemoryMutation, sources []Object, automatic bool) Object {
	s.ensureMemorySettings(project)
	settings := s.memorySettings(project)
	old := s.row("SELECT * FROM projectMemoryEntriesV2 WHERE projectId=? AND key=?", project, m.Key)
	revision := integer(old["revision"])
	if m.Forget && old != nil && stringOf(old["deletedAt"]) != "" && (m.ExpectedRevision == revision || m.ExpectedRevision == revision-1) {
		return Object{"key": m.Key, "revision": revision, "deleted": true, "projectRevision": settings["revision"]}
	}
	if m.ExpectedRevision != revision {
		fail(409, "Memory changed; refresh and retry")
	}
	if old != nil && stringOf(old["deletedAt"]) != "" && (!m.RestoreDeleted || automatic) {
		fail(409, "Memory was forgotten; explicit restore required")
	}
	t := now()
	next := integer(settings["revision"]) + 1
	var entry Object
	if m.Forget {
		if old == nil {
			fail(404, "Memory not found")
		}
		entry = memoryV2Tombstone(old, revision+1, next, t)
		s.exec("DELETE FROM projectMemorySourcesV2 WHERE projectId=? AND key=?", project, m.Key)
		s.exec("DELETE FROM projectMemoryRevisionsV2 WHERE projectId=? AND key=?", project, m.Key)
		s.exec("DELETE FROM projectMemoryCandidatesV2 WHERE projectId=? AND baseKey=?", project, m.Key)
		s.eraseStrategyExperiments("jobId IN (SELECT id FROM strategyJobs WHERE accessProjectId=?)", project)
		s.strategyInvalidateJobs("id IN (SELECT jobId FROM strategyExperiments WHERE jobId IN (SELECT id FROM strategyJobs WHERE accessProjectId=?))", project)
	} else {
		if (old == nil || stringOf(old["deletedAt"]) != "") && integer(s.row("SELECT count(*) AS n FROM projectMemoryEntriesV2 WHERE projectId=? AND deletedAt=''", project)["n"]) >= 500 {
			fail(429, "Project memory is full")
		}
		d := m.Details
		bindings := s.MemoryResourceBindings(project, d.ResourceIDs)
		if d.AlwaysReference && integer(s.row("SELECT count(*) AS n FROM projectMemoryEntriesV2 WHERE projectId=? AND key!=? AND deletedAt='' AND alwaysReference=1", project, m.Key)["n"]) >= 2 {
			fail(429, "At most two memories can be always referenced")
		}
		subject := d.Subject
		if subject == nil {
			subject = Object{}
		}
		scopeHash := memoryScopeHash(d.ScopeKind, bindings, subject)
		if other := s.row("SELECT key FROM projectMemoryEntriesV2 WHERE projectId=? AND scopeHash=? AND factKey=? AND deletedAt='' AND reviewState='active' AND key!=?", project, scopeHash, d.FactKey, m.Key); other != nil {
			fail(409, "Conflicting memory fact")
		}
		created, originSession, originTurn := t, m.OriginSessionID, m.OriginTurnID
		if old != nil && stringOf(old["deletedAt"]) == "" {
			created, originSession, originTurn = stringOf(old["createdAt"]), stringOf(old["originSessionId"]), stringOf(old["originTurnId"])
		}
		entry = Object{"projectId": project, "key": m.Key, "type": m.Type, "description": m.Description, "body": m.Body, "revision": revision + 1, "projectRevision": next, "contentHash": memoryHash(m.Body), "knowledgeKind": d.KnowledgeKind, "scopeKind": d.ScopeKind, "scopeHash": scopeHash, "subjectJSON": jsonText(subject), "claimJSON": "{}", "factKey": d.FactKey, "bindingsJSON": jsonText(bindings), "verification": "user-stated", "assertedAt": t, "observedAt": "", "validUntil": m.ValidUntil, "reviewState": "active", "alwaysReference": 0, "originSessionId": originSession, "originTurnId": originTurn, "createdAt": created, "updatedAt": t, "deletedAt": ""}
		if !automatic && old != nil && (d.KnowledgeKind == "topology" || d.KnowledgeKind == "configuration") && old["bindingsJSON"] != entry["bindingsJSON"] && sameMemoryResources(memoryObjects(old["bindingsJSON"]), bindings) {
			proved := true
			for _, binding := range bindings {
				matched := false
				for _, source := range sources {
					if source["kind"] == "evidence" && source["outcome"] == "completed_success" && source["resourceId"] == binding["resourceId"] && integer(source["resourceGeneration"]) == integer(binding["generation"]) {
						matched = true
					}
				}
				proved = proved && matched
			}
			if !proved {
				entry["bindingsJSON"] = old["bindingsJSON"]
			}
		}
		if d.AlwaysReference {
			entry["alwaysReference"] = 1
		}
		if d.ReviewState == "disabled" {
			entry["reviewState"] = "disabled"
			entry["alwaysReference"] = 0
		}
		if automatic {
			entry["assertedAt"] = ""
			for _, source := range sources {
				if at := stringOf(source["assertedAt"]); at != "" && (stringOf(entry["assertedAt"]) == "" || at < stringOf(entry["assertedAt"])) {
					entry["assertedAt"] = at
				}
				if len(m.Claim) > 0 && source["outcome"] == "completed_success" {
					if at := stringOf(source["observedAt"]); at != "" && (stringOf(entry["observedAt"]) == "" || at < stringOf(entry["observedAt"])) {
						entry["observedAt"] = at
					}
				}
			}
			if len(m.Claim) > 0 {
				entry["claimJSON"] = jsonText(m.Claim)
				entry["verification"] = "observed"
			}
		}
		if !automatic && old != nil && old["reviewState"] == "needs_review" && (d.KnowledgeKind == "topology" || d.KnowledgeKind == "configuration") {
			entry["assertedAt"] = ""
			entry["observedAt"] = ""
		}
		if !automatic && old != nil && old["body"] == m.Body && old["knowledgeKind"] == d.KnowledgeKind && old["scopeHash"] == scopeHash && old["bindingsJSON"] == entry["bindingsJSON"] && old["subjectJSON"] == entry["subjectJSON"] && old["factKey"] == entry["factKey"] {
			entry["observedAt"], entry["assertedAt"], entry["verification"] = old["observedAt"], old["assertedAt"], old["verification"]
			entry["claimJSON"] = old["claimJSON"]
		}
		if sources == nil {
			sources = []Object{{"kind": m.SourceKind, "sessionId": m.OriginSessionID, "turnId": m.OriginTurnID, "messageId": m.OriginMessageID, "assertedAt": t, "excerpt": "", "outcome": "user_stated"}}
		}
		entry["validUntil"] = DeriveMemoryValidity(entry, old)
	}
	s.writeMemoryV2Row(entry)
	if !m.Forget {
		for _, source := range sources {
			s.appendMemoryV2Source(entry, source)
		}
		s.exec("INSERT INTO projectMemoryRevisionsV2(projectId,key,revision,snapshotJSON,changeKind,changedAt) VALUES(?,?,?,?,?,?)", project, m.Key, entry["revision"], jsonText(entry), "upsert", t)
		s.exec("DELETE FROM projectMemoryRevisionsV2 WHERE projectId=? AND key=? AND revision NOT IN (SELECT revision FROM projectMemoryRevisionsV2 WHERE projectId=? AND key=? ORDER BY revision DESC LIMIT 20)", project, m.Key, project, m.Key)
	}
	epoch := integer(settings["epoch"])
	if !automatic {
		epoch++
		s.exec("UPDATE projectMemoryJobs SET status='skipped',lastErrorCode='memory_changed',leaseToken='',leaseOwner='',leaseUntilMs=0,updatedAt=? WHERE turnSequence IN (SELECT sequence FROM projectMemoryTurns WHERE projectId=?) AND status IN ('queued','retry_wait','running','budget_wait')", t, project)
	}
	s.exec("UPDATE projectMemorySettings SET revision=?,epoch=?,updatedAt=? WHERE projectId=?", next, epoch, t, project)
	id := ident()
	s.exec("INSERT INTO projectMemoryCommits(commitId,projectId,revision,mutationKeysJSON,createdAt) VALUES(?,?,?,?,?)", id, project, next, jsonText([]string{m.Key}), t)
	return Object{"commitId": id, "key": m.Key, "revision": entry["revision"], "projectRevision": next, "deleted": m.Forget}
}

func sameMemoryResources(left, right []Object) bool {
	ids := func(rows []Object) []string {
		out := []string{}
		for _, row := range rows {
			out = append(out, stringOf(row["resourceId"]))
		}
		sort.Strings(out)
		return out
	}
	return jsonText(ids(left)) == jsonText(ids(right))
}

func (s *Store) insertMemoryCandidate(project, jobID, key string, revision int, proposal Object, reason string) string {
	h := memoryHash(proposal)
	if old := s.row("SELECT candidateId FROM projectMemoryCandidatesV2 WHERE projectId=? AND jobId=? AND candidateHash=?", project, jobID, h); old != nil {
		return stringOf(old["candidateId"])
	}
	if integer(s.row("SELECT count(*) AS n FROM projectMemoryCandidatesV2 WHERE projectId=? AND status='pending' AND expiresAt>?", project, now())["n"]) >= 100 {
		fail(429, "Memory review queue is full")
	}
	id := ident()
	s.exec("INSERT INTO projectMemoryCandidatesV2(candidateId,projectId,jobId,candidateHash,baseKey,baseRevision,proposalJSON,reason,status,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)", id, project, jobID, h, key, revision, jsonText(proposal), reason, now(), time.Now().UTC().Add(30*24*time.Hour).Format(time.RFC3339Nano))
	return id
}

func memoryPrefix(value string, bytes int) string {
	if bytes <= 0 {
		return ""
	}
	if len(value) <= bytes {
		return value
	}
	for bytes > 0 && value[bytes]&0xc0 == 0x80 {
		bytes--
	}
	return value[:bytes]
}

func memoryScopeHash(kind string, bindings []Object, subject Object) string {
	ids := []string{}
	for _, b := range bindings {
		ids = append(ids, stringOf(b["resourceId"]))
	}
	sort.Strings(ids)
	qualifiers := Object{}
	for k, v := range object(subject["qualifiers"]) {
		if k != "imageDigest" && k != "configRevision" {
			qualifiers[k] = v
		}
	}
	return memoryHash(Object{"kind": kind, "resources": ids, "subject": Object{"kind": subject["kind"], "identity": subject["identity"], "qualifiers": qualifiers}})
}
