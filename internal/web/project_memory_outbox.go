package web

import (
	"errors"
	"fmt"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (s *Store) EnqueueMemoryTurn(snapshot ai.MemoryTurnSnapshot) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("memory enqueue failed: %v", p)
		}
	}()
	if !ai.ValidMemorySnapshot(snapshot) || len(jsonText(snapshot)) > 128*1024 {
		return errors.New("invalid memory snapshot")
	}
	s.update(func() any {
		session := s.row("SELECT projectId FROM sessions WHERE id=?", snapshot.SessionID)
		if session == nil || session["projectId"] != snapshot.ProjectID {
			fail(409, "Memory snapshot session changed project")
		}
		if snapshot.Natural != nil {
			key := naturalCoverageKey(snapshot)
			if s.row("SELECT sourceKey FROM naturalMemoryCoverage WHERE sourceKey=?", key) != nil {
				return nil
			}
		}
		if previous := s.row("SELECT snapshotHash FROM projectMemoryTurns WHERE projectId=? AND sessionId=? AND turnId=?", snapshot.ProjectID, snapshot.SessionID, snapshot.TurnID); previous != nil {
			if previous["snapshotHash"] != snapshot.SnapshotHash {
				fail(409, "Memory snapshot conflict")
			}
			return nil
		}
		settings := Object{"useEnabled": false, "extractionEnabled": false, "epoch": snapshot.Epoch + 1}
		if s.row("SELECT id FROM projects WHERE id=? AND "+activeProjectsSQL, snapshot.ProjectID) != nil {
			s.ensureMemorySettings(snapshot.ProjectID)
			settings = s.memorySettings(snapshot.ProjectID)
		}
		outcome, status := "pending", "queued"
		code := ""
		if s.memoryV2 {
			if snapshot.SchemaVersion != 2 {
				outcome, status, code = "skipped", "skipped", "legacy_snapshot"
			}
			if integer(s.row("SELECT count(*) AS n FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.projectId=? AND j.status IN ('queued','running','retry_wait','budget_wait')", snapshot.ProjectID)["n"]) >= 100 {
				outcome, status, code = "skipped", "skipped", "queue_limit"
			}
		}
		if snapshot.Natural != nil {
			if integer(s.row("SELECT count(*) n FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.projectId=? AND j.status IN ('queued','running','retry_wait')", snapshot.ProjectID)["n"]) >= 100 {
				fail(429, "Memory outbox retained until queue space is available")
			}
			if !s.naturalSnapshotValid(snapshot) || !naturalSourceAgeValid(snapshot) {
				outcome, status, code = "skipped", "skipped", "natural_memory_disabled"
			}
		} else if integer(settings["epoch"]) != snapshot.Epoch || settings["useEnabled"] != true || settings["extractionEnabled"] != true {
			outcome, status = "skipped", "skipped"
		}
		nowAt := now()
		snapshotJSON := jsonText(snapshot)
		if snapshot.Natural != nil && status == "skipped" {
			snapshotJSON = ""
		}
		s.exec("INSERT INTO projectMemoryTurns(projectId,sessionId,turnId,epoch,knowledgeBaseRevision,snapshotJSON,snapshotHash,modelRefJSON,outcome,createdAt,processedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)", snapshot.ProjectID, snapshot.SessionID, snapshot.TurnID, snapshot.Epoch, snapshot.KnowledgeBaseRevision, snapshotJSON, snapshot.SnapshotHash, jsonText(Object{"modelRef": snapshot.ModelRef}), outcome, nowAt, "")
		sequence := int64(integer(s.row("SELECT sequence FROM projectMemoryTurns WHERE projectId=? AND sessionId=? AND turnId=?", snapshot.ProjectID, snapshot.SessionID, snapshot.TurnID)["sequence"]))
		s.exec("INSERT INTO projectMemoryJobs(jobId,turnSequence,status,nextAttemptAtMs,createdAt,updatedAt,lastErrorCode) VALUES(?,?,?,?,?,?,?)", ident(), sequence, status, time.Now().UnixMilli(), nowAt, nowAt, code)
		if snapshot.Natural != nil {
			stage := "captured"
			if status == "skipped" {
				stage = "withdrawn"
				if code == "queue_limit" {
					stage = "deferred"
				}
			}
			s.exec("INSERT INTO naturalMemoryCoverage VALUES(?,?,?,?,?,?,?,?,?)", naturalCoverageKey(snapshot), sequence, snapshot.ProjectID, snapshot.SessionID, snapshot.SourceMessageID, memoryHash(snapshot.UserText), stage, code, nowAt)
		}
		return nil
	})
	return nil
}

func (b *Server) reconcileMemoryOutboxForSession(id string) error {
	if _, err := b.Engine.QueuePendingMemoryCaptures(id); err != nil {
		b.registerMemoryOutbox(id)
		return err
	}
	items, err := b.Engine.MemoryOutbox(id)
	if err != nil {
		return err
	}
	for _, snapshot := range items {
		if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
			b.registerMemoryOutbox(id)
			return err
		}
		if err := b.Engine.AckMemoryOutbox(id, snapshot.TurnID, snapshot.SnapshotHash); err != nil {
			return err
		}
	}
	if queued, err := b.Engine.QueuePendingMemoryCaptures(id); queued || err != nil {
		b.registerMemoryOutbox(id)
		if err != nil {
			return err
		}
		return fmt.Errorf("registered memory capture pending")
	}
	return nil
}

func (b *Server) reconcilePersistedMemoryOutboxes() error {
	items, err := b.Engine.PersistedMemoryOutboxes()
	if err != nil {
		return err
	}
	for _, snapshot := range items {
		if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
			b.registerMemoryOutbox(snapshot.SessionID)
			// A removed or corrupted session must not prevent other projects from starting.
			continue
		}
		if err := b.Engine.AckMemoryOutbox(snapshot.SessionID, snapshot.TurnID, snapshot.SnapshotHash); err != nil {
			continue
		}
	}
	return nil
}

func (b *Server) registerMemoryOutbox(id string) {
	b.memoryOutboxMu.Lock()
	defer b.memoryOutboxMu.Unlock()
	if b.memoryOutboxPending == nil {
		b.memoryOutboxPending = map[string]bool{}
	}
	b.memoryOutboxPending[id] = true
}
func (b *Server) reconcileRegisteredMemoryOutboxes() {
	b.messageMu.Lock()
	busy := len(b.runningMessages) > 0 || b.memoryForeground > 0
	b.messageMu.Unlock()
	if busy {
		return
	}
	b.memoryOutboxMu.Lock()
	ids := []string{}
	for id := range b.memoryOutboxPending {
		ids = append(ids, id)
		if len(ids) >= 8 {
			break
		}
	}
	b.memoryOutboxMu.Unlock()
	for _, id := range ids {
		if b.reconcileMemoryOutboxForSession(id) == nil {
			b.memoryOutboxMu.Lock()
			delete(b.memoryOutboxPending, id)
			b.memoryOutboxMu.Unlock()
		}
	}
}
func (b *Server) memoryForegroundModel() func() {
	b.messageMu.Lock()
	b.memoryForeground++
	b.memoryLastForeground = time.Now()
	b.PauseMemoryExtractionForForeground()
	b.messageMu.Unlock()
	return func() {
		b.messageMu.Lock()
		b.memoryForeground--
		b.memoryLastForeground = time.Now()
		b.messageMu.Unlock()
	}
}

// Host revalidation before materializing an already registered source, including
// offline compaction recovery. Never restore consent from serialized config.
func (s *Store) MemoryCaptureAllowed(snapshot ai.MemoryTurnSnapshot) bool {
	return s.read(func() any {
		if snapshot.Natural != nil {
			return s.naturalSnapshotValid(snapshot)
		}
		source := s.row("SELECT m.text FROM messages m JOIN sessions x ON x.id=m.sessionId JOIN projects ON projects.id=x.projectId WHERE m.id=? AND m.sessionId=? AND m.role='user' AND x.projectId=? AND "+activeProjectsSQL, snapshot.SourceMessageID, snapshot.SessionID, snapshot.ProjectID)
		if source == nil {
			return false
		}
		settings := s.memorySettings(snapshot.ProjectID)
		return source != nil && source["text"] == snapshot.UserText && settings["useEnabled"] == true && settings["extractionEnabled"] == true && integer(settings["epoch"]) == snapshot.Epoch
	}).(bool)
}
