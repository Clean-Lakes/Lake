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
		if integer(settings["epoch"]) != snapshot.Epoch || settings["useEnabled"] != true || settings["extractionEnabled"] != true {
			outcome, status = "skipped", "skipped"
		}
		nowAt := now()
		s.exec("INSERT INTO projectMemoryTurns(projectId,sessionId,turnId,epoch,knowledgeBaseRevision,snapshotJSON,snapshotHash,modelRefJSON,outcome,createdAt,processedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)", snapshot.ProjectID, snapshot.SessionID, snapshot.TurnID, snapshot.Epoch, snapshot.KnowledgeBaseRevision, jsonText(snapshot), snapshot.SnapshotHash, jsonText(Object{"modelRef": snapshot.ModelRef}), outcome, nowAt, "")
		sequence := int64(integer(s.row("SELECT sequence FROM projectMemoryTurns WHERE projectId=? AND sessionId=? AND turnId=?", snapshot.ProjectID, snapshot.SessionID, snapshot.TurnID)["sequence"]))
		s.exec("INSERT INTO projectMemoryJobs(jobId,turnSequence,status,nextAttemptAtMs,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", ident(), sequence, status, time.Now().UnixMilli(), nowAt, nowAt)
		return nil
	})
	return nil
}

func (b *Server) reconcileMemoryOutboxForSession(id string) error {
	items, err := b.Engine.MemoryOutbox(id)
	if err != nil {
		return err
	}
	for _, snapshot := range items {
		if err := b.Store.EnqueueMemoryTurn(snapshot); err != nil {
			return err
		}
		if err := b.Engine.AckMemoryOutbox(id, snapshot.TurnID, snapshot.SnapshotHash); err != nil {
			return err
		}
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
			// A removed or corrupted session must not prevent other projects from starting.
			continue
		}
		if err := b.Engine.AckMemoryOutbox(snapshot.SessionID, snapshot.TurnID, snapshot.SnapshotHash); err != nil {
			continue
		}
	}
	return nil
}
