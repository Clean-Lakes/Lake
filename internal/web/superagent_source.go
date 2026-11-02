package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

const superSessionSchema = `CREATE TABLE IF NOT EXISTS superagentSessions(sessionId TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,projectId TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL);`

func superHostID(kind, project string) string {
	sum := sha256.Sum256([]byte(kind + "\x00" + project))
	return "super_" + hex.EncodeToString(sum[:16])
}
func (s *Store) ensureSuperSession(project, id, title, kind string) Object {
	return s.update(func() any {
		s.activeProject(project)
		if row := s.row("SELECT projectId,kind FROM superagentSessions WHERE sessionId=?", id); row != nil {
			if row["projectId"] != project || row["kind"] != kind {
				fail(409, "专员身份冲突")
			}
			return s.session(id)
		}
		if s.row("SELECT id FROM sessions WHERE id=?", id) != nil {
			fail(409, "内部任务身份冲突")
		}
		t := now()
		s.exec("INSERT INTO sessions(id,projectId,title,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", id, project, title, "idle", t, t)
		s.exec("INSERT INTO superagentSessions(sessionId,projectId,kind) VALUES(?,?,?)", id, project, kind)
		s.event(id, "session")
		return s.session(id)
	}).(Object)
}
func (s *Store) superSessionKind(id string) string {
	return s.read(func() any {
		return stringOf(s.row("SELECT kind FROM superagentSessions WHERE sessionId=?", id)["kind"])
	}).(string)
}
func (b *Server) superUserSource(project, routerID string) ai.SuperSourceBinding {
	return ai.SuperSourceBinding{SourceID: superHostID("web-user", project), ProjectID: project, Kind: "user", ActorRef: "authenticated-home-owner", Revision: "web-user-v1:" + routerID}
}

// ReceiveUserEvent verifies the actual committed host message, not client or
// model claims about actor/project/message identity. Attachments stay in their
// existing private store; events carry source references, never file bytes.
func (b *Server) ReceiveUserEvent(ctx context.Context, sessionID, messageID string) (ai.SuperEvent, error) {
	session := b.Store.Session(sessionID)
	project := stringOf(session["projectId"])
	domain, enabled, err := b.Engine.SuperProject(ctx, project)
	if err != nil {
		return ai.SuperEvent{}, err
	}
	if !enabled || domain.RouterSessionID != sessionID {
		return ai.SuperEvent{}, errors.New("superagent: actual Pilot source required")
	}
	var message Object
	b.Store.read(func() any {
		message = b.Store.row("SELECT id,text,role FROM messages WHERE id=? AND sessionId=?", messageID, sessionID)
		return nil
	})
	if message == nil || message["role"] != "user" {
		return ai.SuperEvent{}, errors.New("superagent: actual user message required")
	}
	source := b.superUserSource(project, sessionID)
	if err = b.Engine.RegisterSuperSource(ctx, source); err != nil {
		return ai.SuperEvent{}, err
	}
	event, _, err := b.Engine.ReceiveSuperEvent(ctx, source, ai.SuperEventInput{SourceEventID: messageID, ThreadRef: sessionID, Kind: "message", Payload: stringOf(message["text"])})
	return event, err
}

func (b *Server) ensureSuperProject(ctx context.Context, project string) (ai.SuperProject, error) {
	if existing, ok, err := b.Engine.SuperProject(ctx, project); err != nil || ok {
		return existing, err
	}
	var sessions []Object
	b.Store.read(func() any {
		b.Store.activeProject(project)
		// Legacy SRE keeps its owner until all attempts/operations are drained.
		for _, row := range b.Store.rows("SELECT status,body FROM sreTasks WHERE projectId=?", project) {
			task := decodeSRETask(row)
			if task.Status != "completed" && task.Status != "cancelled" && task.Status != "failed" {
				fail(409, "旧 Pilot 任务仍在进行，需排空并核对原操作后切换")
			}
		}
		sessions = b.Store.rows("SELECT id FROM sessions WHERE projectId=? AND id NOT IN (SELECT sessionId FROM superagentSessions)", project)
		return nil
	})
	ids := []string{}
	for _, s := range sessions {
		ids = append(ids, stringOf(s["id"]))
	}
	routerID := superHostID("pilot", project)
	b.Store.ensureSuperSession(project, routerID, "Pilot", "router")
	return b.Engine.ActivateSuperProject(ctx, project, routerID, ids)
}

// DeliverPilotReport uses the stable outbox key as the host message ID. A crash
// after the host commit can reconcile that same row without a second message.
func (b *Server) DeliverPilotReport(ctx context.Context, project, routerID, reportID string) error {
	domain, ok, err := b.Engine.SuperProject(ctx, project)
	if err != nil {
		return err
	}
	if !ok || domain.RouterSessionID != routerID {
		return errors.New("superagent: output channel mismatch")
	}
	report, err := b.Engine.BeginPilotDelivery(ctx, project, reportID)
	if err != nil {
		return err
	}
	if report.State == "delivered" {
		return nil
	}
	if report.ChannelRef != routerID {
		return errors.New("superagent: report channel mismatch")
	}
	b.Store.update(func() any {
		b.Store.session(routerID)
		if prior := b.Store.row("SELECT sessionId,text FROM messages WHERE id=?", report.ID); prior != nil {
			if prior["sessionId"] != routerID || prior["text"] != report.Payload {
				fail(409, "回复回执内容冲突")
			}
			return nil
		}
		b.Store.exec("INSERT INTO messages(id,sessionId,role,text,createdAt) VALUES(?,?,?,?,?)", report.ID, routerID, "assistant", report.Payload, now())
		b.Store.event(routerID, "message")
		return nil
	})
	return b.Engine.AcknowledgePilotDelivery(ctx, project, report.ID, "host-message:"+report.ID)
}
