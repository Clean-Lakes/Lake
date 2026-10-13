package web

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type MemoryExtractMutation struct {
	Operation        string   `json:"operation"`
	Key              string   `json:"key"`
	Type             string   `json:"type"`
	Description      string   `json:"description"`
	Body             string   `json:"body"`
	SourceIDs        []string `json:"sourceIds"`
	Verification     string   `json:"verification"`
	ExpectedRevision int      `json:"expectedRevision"`
}

func (s *Store) RecoverMemoryJobs() {
	s.update(func() any {
		s.exec("UPDATE projectMemoryJobs SET status='queued',leaseOwner='',leaseToken='',leaseUntilMs=0,updatedAt=? WHERE status='running'", now())
		return nil
	})
}

func (s *Store) PruneMemoryArtifacts() {
	s.update(func() any {
		sevenDays := time.Now().UTC().AddDate(0, 0, -7).Format(time.RFC3339Nano)
		thirtyDays := time.Now().UTC().AddDate(0, 0, -30).Format(time.RFC3339Nano)
		s.exec(`UPDATE projectMemoryTurns SET snapshotJSON='' WHERE snapshotJSON<>'' AND sequence IN (
SELECT t.sequence FROM projectMemoryTurns t JOIN projectMemoryJobs j ON j.turnSequence=t.sequence
WHERE (j.status IN ('succeeded','no_op') AND j.updatedAt<?) OR (j.status IN ('skipped','blocked','failed') AND j.updatedAt<?))`, sevenDays, thirtyDays)
		return nil
	})
}

func (s *Store) ClaimMemoryJob() Object {
	return s.update(func() any {
		row := s.row(`SELECT j.*,t.projectId,t.sessionId,t.turnId,t.epoch,t.knowledgeBaseRevision,t.snapshotJSON,t.snapshotHash,t.modelRefJSON
FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence
JOIN projects ON projects.id=t.projectId
WHERE j.status IN ('queued','retry_wait') AND j.nextAttemptAtMs<=? AND `+activeProjectsSQL+`
ORDER BY t.sequence LIMIT 1`, time.Now().UnixMilli())
		if row == nil {
			return Object(nil)
		}
		token := ident()
		s.exec("UPDATE projectMemoryJobs SET status='running',attempts=attempts+1,leaseOwner='local',leaseToken=?,leaseUntilMs=?,updatedAt=? WHERE jobId=?", token, time.Now().Add(90*time.Second).UnixMilli(), now(), row["jobId"])
		row["leaseToken"] = token
		row["attempts"] = integer(row["attempts"]) + 1
		return row
	}).(Object)
}

func (s *Store) SettleMemoryJob(jobID, token, status, code string, usage ai.Usage) {
	s.update(func() any {
		row := s.row("SELECT j.status,j.attempts,j.usageJSON,j.turnSequence FROM projectMemoryJobs j WHERE j.jobId=? AND j.leaseToken=?", jobID, token)
		if row == nil {
			return nil
		}
		var previous ai.Usage
		_ = json.Unmarshal([]byte(stringOf(row["usageJSON"])), &previous)
		previous.Input += usage.Input
		previous.Output += usage.Output
		previous.Total += usage.Total
		previous.Known = previous.Known || usage.Known
		if row["status"] == "skipped" {
			s.exec("UPDATE projectMemoryJobs SET usageJSON=?,leaseToken='',leaseOwner='',leaseUntilMs=0,updatedAt=? WHERE jobId=?", jsonText(previous), now(), jobID)
			return nil
		}
		if row["status"] != "running" {
			return nil
		}
		next := int64(0)
		if status == "queued" {
			next = time.Now().UnixMilli()
		} else if status == "retry_wait" && integer(row["attempts"]) < 3 {
			backoff := 30 * time.Second
			if integer(row["attempts"]) > 1 {
				backoff = 120 * time.Second
			}
			next = time.Now().Add(backoff).UnixMilli()
		} else if status == "retry_wait" {
			status = "failed"
		}
		s.exec("UPDATE projectMemoryJobs SET status=?,nextAttemptAtMs=?,leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode=?,usageJSON=?,updatedAt=? WHERE jobId=?", status, next, code, jsonText(previous), now(), jobID)
		if status != "retry_wait" && status != "queued" {
			outcome := status
			if status == "succeeded" {
				outcome = "applied"
			}
			s.exec("UPDATE projectMemoryTurns SET outcome=?,processedAt=? WHERE sequence=?", outcome, now(), row["turnSequence"])
		}
		return nil
	})
}

// Commit all model mutations, the job result and its deduplication receipt in
// one SQLite transaction. A stale lease or a later user edit cannot write back.
func (s *Store) CommitMemoryExtraction(job Object, snapshot ai.MemoryTurnSnapshot, mutations []MemoryExtractMutation, usage ai.Usage) (changed bool, err error) {
	defer func() {
		if p := recover(); p != nil {
			if failure, ok := p.(*Failure); ok {
				err = failure
			} else {
				err = fmt.Errorf("memory commit rejected")
			}
		}
	}()
	result := s.update(func() any {
		jobID, token := stringOf(job["jobId"]), stringOf(job["leaseToken"])
		live := s.row("SELECT status,leaseToken,usageJSON FROM projectMemoryJobs WHERE jobId=?", jobID)
		if live == nil || live["status"] != "running" || live["leaseToken"] != token {
			fail(409, "Memory job lease expired")
		}
		settings := s.memorySettings(snapshot.ProjectID)
		if settings["useEnabled"] != true || settings["extractionEnabled"] != true || integer(settings["epoch"]) != snapshot.Epoch {
			fail(409, "Memory job invalidated")
		}
		if s.row("SELECT projectId FROM sessions WHERE id=?", snapshot.SessionID)["projectId"] != snapshot.ProjectID {
			fail(409, "Memory source project changed")
		}
		if len(mutations) > 5 {
			fail(400, "Too many memory changes")
		}
		projectRevision := integer(settings["revision"])
		nextRevision := projectRevision + 1
		t := now()
		keys := []string{}
		seen := map[string]bool{}
		for _, mutation := range mutations {
			if mutation.Operation != "upsert" || seen[mutation.Key] || len(mutation.SourceIDs) == 0 {
				fail(400, "Invalid memory extraction")
			}
			seen[mutation.Key] = true
			m := MemoryMutation{Key: mutation.Key, Type: mutation.Type, Description: mutation.Description, Body: mutation.Body, ExpectedRevision: mutation.ExpectedRevision, Verification: mutation.Verification}
			validateMemoryMutation(m)
			validSource, evidenceSource := false, false
			for _, source := range mutation.SourceIDs {
				if source == "user:0" {
					validSource = true
					continue
				}
				matched := false
				for _, evidence := range snapshot.Evidence {
					if source == "evidence:"+evidence.CallID && evidence.Completed {
						validSource, evidenceSource = true, true
						matched = true
					}
				}
				if !matched {
					fail(400, "Memory source could not be verified")
				}
			}
			if !validSource || mutation.Verification == "observed" && !evidenceSource || mutation.Verification == "user-stated" && !containsMemorySource(mutation.SourceIDs, "user:0") {
				fail(400, "Memory source could not be verified")
			}
			old := s.row("SELECT * FROM projectMemories WHERE projectId=? AND key=?", snapshot.ProjectID, mutation.Key)
			oldRevision := 0
			if old != nil {
				oldRevision = integer(old["revision"])
				if stringOf(old["deletedAt"]) != "" {
					fail(409, "Memory changed after source turn")
				}
			}
			if old != nil && old["body"] == m.Body && old["description"] == m.Description && old["type"] == m.Type {
				continue
			}
			if old != nil && integer(old["projectRevision"]) > snapshot.KnowledgeBaseRevision {
				fail(409, "Memory changed after source turn")
			}
			if mutation.ExpectedRevision != oldRevision {
				fail(409, "Memory revision conflict")
			}
			if old == nil && integer(s.row("SELECT count(*) AS count FROM projectMemories WHERE projectId=? AND deletedAt=''", snapshot.ProjectID)["count"]) >= 500 {
				fail(429, "Project memory is full")
			}
			originSession, originTurn, createdAt := snapshot.SessionID, snapshot.TurnID, t
			sources := []Object{}
			if old != nil {
				originSession, originTurn, createdAt = stringOf(old["originSessionId"]), stringOf(old["originTurnId"]), stringOf(old["createdAt"])
				_ = json.Unmarshal([]byte(stringOf(old["sourceSummaryJSON"])), &sources)
			}
			excerpt := snapshot.UserText
			if len(excerpt) > 1024 {
				excerpt = excerpt[:1024]
			}
			sources = append(sources, Object{"kind": "auto", "sessionId": snapshot.SessionID, "turnId": snapshot.TurnID, "sourceIds": mutation.SourceIDs, "at": snapshot.CapturedAt, "excerpt": excerpt})
			if len(sources) > 8 {
				sources = sources[len(sources)-8:]
			}
			observedAt := ""
			if m.Verification == "observed" {
				observedAt = snapshot.CapturedAt
			}
			markdown := renderMemoryMarkdown(m.Key, m.Type, m.Description, m.Body, memoryMarkdownMeta{ProjectID: snapshot.ProjectID, OriginSessionID: originSession, OriginTurnID: originTurn, Revision: oldRevision + 1, UpdatedAt: t, Verification: m.Verification, ObservedAt: observedAt})
			hash := fmt.Sprintf("%x", sha256.Sum256([]byte(m.Body)))
			s.exec(`INSERT INTO projectMemories(projectId,key,type,description,body,markdown,revision,projectRevision,contentHash,originSessionId,originTurnId,lastSourceSessionId,lastSourceTurnId,sourceIdsJSON,sourceSummaryJSON,verification,observedAt,createdAt,updatedAt)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(projectId,key) DO UPDATE SET type=excluded.type,description=excluded.description,body=excluded.body,markdown=excluded.markdown,revision=excluded.revision,projectRevision=excluded.projectRevision,contentHash=excluded.contentHash,lastSourceSessionId=excluded.lastSourceSessionId,lastSourceTurnId=excluded.lastSourceTurnId,sourceIdsJSON=excluded.sourceIdsJSON,sourceSummaryJSON=excluded.sourceSummaryJSON,verification=excluded.verification,observedAt=excluded.observedAt,updatedAt=excluded.updatedAt`, snapshot.ProjectID, m.Key, m.Type, m.Description, m.Body, markdown, oldRevision+1, nextRevision, hash, originSession, originTurn, snapshot.SessionID, snapshot.TurnID, jsonText(mutation.SourceIDs), jsonText(sources), m.Verification, observedAt, createdAt, t)
			keys = append(keys, mutation.Key)
		}
		var previous ai.Usage
		_ = json.Unmarshal([]byte(stringOf(live["usageJSON"])), &previous)
		previous.Input += usage.Input
		previous.Output += usage.Output
		previous.Total += usage.Total
		previous.Known = previous.Known || usage.Known
		status, outcome := "no_op", "no_op"
		if len(keys) > 0 {
			status, outcome = "succeeded", "applied"
			s.exec("UPDATE projectMemorySettings SET revision=revision+1,updatedAt=? WHERE projectId=?", t, snapshot.ProjectID)
			s.exec("INSERT INTO projectMemoryCommits(commitId,jobId,projectId,revision,mutationKeysJSON,sourceTurnSequence,createdAt) VALUES(?,?,?,?,?,?,?)", ident(), jobID, snapshot.ProjectID, nextRevision, jsonText(keys), job["turnSequence"], t)
		}
		s.exec("UPDATE projectMemoryJobs SET status=?,leaseToken='',leaseOwner='',leaseUntilMs=0,lastErrorCode='',usageJSON=?,updatedAt=? WHERE jobId=?", status, jsonText(previous), t, jobID)
		s.exec("UPDATE projectMemoryTurns SET outcome=?,processedAt=? WHERE sequence=?", outcome, t, job["turnSequence"])
		return len(keys) > 0
	})
	changed = result.(bool)
	if changed {
		if publishErr := s.PublishProjectMemory(snapshot.ProjectID); publishErr != nil {
			// The transaction is authoritative; startup reconciliation repairs files.
			return true, nil
		}
	}
	return changed, nil
}

func containsMemorySource(sources []string, desired string) bool {
	for _, source := range sources {
		if source == desired {
			return true
		}
	}
	return false
}

func (s *Store) RetryMemoryJob(project, jobID string, expectedRevision int) Object {
	return s.update(func() any {
		s.ensureMemorySettings(project)
		settings := s.memorySettings(project)
		if integer(settings["revision"]) != expectedRevision || settings["useEnabled"] != true || settings["extractionEnabled"] != true {
			fail(409, "Project memory changed; refresh before retry")
		}
		row := required(s.row(`SELECT j.status,t.snapshotJSON,t.sequence,t.snapshotHash FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE j.jobId=? AND t.projectId=?`, jobID, project), "Memory job")
		status := stringOf(row["status"])
		if status != "blocked" && status != "failed" && status != "skipped" {
			fail(409, "Memory job is not retryable")
		}
		var snapshot ai.MemoryTurnSnapshot
		if json.Unmarshal([]byte(stringOf(row["snapshotJSON"])), &snapshot) != nil || !ai.ValidMemorySnapshot(snapshot) {
			fail(410, "Memory snapshot expired")
		}
		snapshot.Epoch = integer(settings["epoch"])
		snapshot = ai.SealMemorySnapshot(snapshot)
		t := now()
		s.exec("UPDATE projectMemoryTurns SET epoch=?,snapshotJSON=?,snapshotHash=?,outcome='pending',processedAt='' WHERE sequence=?", snapshot.Epoch, jsonText(snapshot), snapshot.SnapshotHash, row["sequence"])
		s.exec("UPDATE projectMemoryJobs SET status='queued',attempts=0,nextAttemptAtMs=?,leaseOwner='',leaseToken='',leaseUntilMs=0,lastErrorCode='',updatedAt=? WHERE jobId=?", time.Now().UnixMilli(), t, jobID)
		return Object{"jobId": jobID, "status": "queued"}
	}).(Object)
}
