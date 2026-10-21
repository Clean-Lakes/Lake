package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"path/filepath"
	"sync"
	"time"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"google.golang.org/adk/v2/model"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/genai"
)

type adkServices struct {
	once  sync.Once
	store *storage.Store
	err   error
}

func (e *Engine) adkStore() (*storage.Store, error) {
	if e.worker != nil {
		return e.worker.parent.adkStore()
	}
	e.adkMu.Lock()
	if e.adk == nil {
		e.adk = &adkServices{}
	}
	services := e.adk
	e.adkMu.Unlock()
	services.once.Do(func() {
		services.store, services.err = storage.Open(filepath.Join(e.runtimeDirectory(), "sessions.sqlite"))
		if services.err == nil {
			services.err = services.store.DB.AutoMigrate(&nativeApproval{}, &nativeOperation{}, &nativeEvidence{}, &nativeArtifact{}, &nativeHistoryMigration{}, &nativeCorrection{})
			if services.err == nil {
				services.err = services.store.DB.Model(&nativeOperation{}).Where("status = ?", "dispatched").Update("status", "unknown").Error
			}
			if services.err == nil {
				services.err = recoverOnlineCorrections(services.store.DB)
			}
			if services.err == nil {
				var sessions []string
				services.err = services.store.DB.Model(&nativeCorrection{}).Distinct("session_id").Pluck("session_id", &sessions).Error
				for _, id := range sessions {
					e.onlineSessions.Store(id, true)
				}
			}
		}
	})
	return services.store, services.err
}

func adkContent(m Message) (*genai.Content, error) {
	content := &genai.Content{Role: "user"}
	if m.Role == "assistant" {
		content.Role = "model"
	}
	if m.Content != "" && m.Role != "tool" {
		content.Parts = append(content.Parts, &genai.Part{Text: m.Content})
	}
	if m.Reasoning != "" {
		content.Parts = append(content.Parts, &genai.Part{Text: m.Reasoning, Thought: true})
	}
	for _, img := range m.Images {
		data, err := base64.StdEncoding.DecodeString(img.Base64)
		if err != nil {
			return nil, err
		}
		content.Parts = append(content.Parts, &genai.Part{InlineData: &genai.Blob{MIMEType: img.MimeType, Data: data}})
	}
	for _, call := range m.Calls {
		var a map[string]any
		if err := json.Unmarshal([]byte(call.Arguments), &a); err != nil {
			return nil, err
		}
		content.Parts = append(content.Parts, &genai.Part{FunctionCall: &genai.FunctionCall{ID: call.ID, Name: call.Name, Args: a}})
	}
	if m.Role == "tool" {
		var value any
		if json.Unmarshal([]byte(m.Content), &value) != nil {
			value = m.Content
		}
		response, ok := value.(map[string]any)
		if !ok {
			response = map[string]any{"result": value}
		}
		content.Parts = append(content.Parts, &genai.Part{FunctionResponse: &genai.FunctionResponse{ID: m.CallID, Name: m.Name, Response: response}})
	}
	return content, nil
}

// prepareADKHistory imports a validated snapshot only when the projected
// history changed through restore/clear/rollback/compaction. Original sessions
// remain available as audit history; a failed import never becomes active.
func (e *Engine) prepareADKHistory(ctx context.Context, s *session, service adksession.Service, author string) (string, *genai.Content, error) {
	s.mu.Lock()
	history := append([]Message(nil), s.state.History...)
	checkpoint := s.state.Runtime
	id := s.state.View.Session
	identity := RunIdentity{SessionID: id, RootTurnID: s.state.View.RootTurnID}
	if c := s.state.Config.sre; c != nil {
		identity.TaskID = c.TaskID
		identity.PlanRevisionID = c.PlanRevisionID
		identity.PlanRunID = c.PlanRunID
		identity.StepID = c.Step.ID
		identity.AttemptID = c.AttemptID
		identity.Role = c.Role
	}
	s.mu.Unlock()
	if e.worker != nil {
		identity.ScopeID = id
		identity.SessionID = e.worker.parentID
		identity.RootTurnID = e.worker.turnID
	}
	if len(history) == 0 || history[len(history)-1].Role != "user" {
		return "", nil, errors.New("missing current user event")
	}
	current, err := adkContent(history[len(history)-1])
	if err != nil {
		return "", nil, err
	}
	previous := history[:len(history)-1]
	if checkpoint == nil {
		previous, err = e.importSpikeHistory(ctx, s, service, previous)
		if err != nil {
			return "", nil, err
		}
		if len(previous) > 1 {
			if err = e.backupNativeMigration(ctx, s, previous); err != nil {
				return "", nil, err
			}
		}
	}
	digest := hash(js(previous))
	if checkpoint != nil && !checkpoint.Detached && checkpoint.HistoryHash == digest {
		if _, err = service.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: checkpoint.SessionID}); err == nil {
			s.mu.Lock()
			s.state.Runtime.Identity = identity
			s.state.Runtime.ModelRounds = 0
			saveErr := e.save(s)
			s.mu.Unlock()
			return checkpoint.SessionID, current, saveErr
		} else if !errors.Is(err, adksession.ErrNotFound) {
			return "", nil, err
		}
	}
	// Preserve source JSON before the first import. It is already redacted and
	// atomically persisted by the host; backups use the same private directory.
	importedID := id + "_" + uid()
	store, err := e.adkStore()
	if err != nil {
		return "", nil, err
	}
	migration := nativeHistoryMigration{ID: hash(id + digest + identity.RootTurnID), SessionID: id, RuntimeSessionID: importedID, SourceHash: digest, SchemaVersion: 1, Status: "importing", CreatedAt: time.Now()}
	var prior nativeHistoryMigration
	lookup := store.DB.First(&prior, "id = ?", migration.ID)
	if lookup.Error == nil && prior.Status == "complete" {
		stored, getErr := service.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: prior.RuntimeSessionID})
		if getErr != nil {
			return "", nil, getErr
		}
		if stored.Session.Events().Len() != prior.ImportedEvents {
			return "", nil, errors.New("migration already used by a runtime; restore its checkpoint before continuing")
		}
		s.mu.Lock()
		s.state.Runtime = &RuntimeCheckpoint{SchemaVersion: 1, SessionID: prior.RuntimeSessionID, HistoryHash: digest, Identity: identity}
		saveErr := e.save(s)
		s.mu.Unlock()
		return prior.RuntimeSessionID, current, saveErr
	} else if lookup.Error == nil {
		err = store.DB.Model(&nativeHistoryMigration{}).Where("id = ? AND status = ?", migration.ID, "importing").Updates(map[string]any{"runtime_session_id": importedID, "created_at": migration.CreatedAt}).Error
	} else if errors.Is(lookup.Error, gorm.ErrRecordNotFound) {
		err = store.DB.Create(&migration).Error
	} else {
		err = lookup.Error
	}
	if err != nil {
		return "", nil, err
	}
	created, err := service.Create(ctx, &adksession.CreateRequest{AppName: "lake", UserID: "lake", SessionID: importedID, State: map[string]any{"lake_schema_version": 1, "lake_source_hash": digest}})
	if err != nil {
		return "", nil, err
	}
	for _, message := range previous {
		if message.Role == "system" {
			continue
		}
		content, err := adkContent(message)
		if err != nil {
			return "", nil, err
		}
		s.mu.Lock()
		c := s.state.Config
		s.mu.Unlock()
		if err = e.persistContentImages(ctx, content, importedID, c); err != nil {
			return "", nil, err
		}
		who := author
		if message.Role == "user" || message.Role == "tool" {
			who = "user"
		}
		event := &adksession.Event{ID: uid(), InvocationID: "import_" + id, Author: who, Timestamp: time.Now(), LLMResponse: model.LLMResponse{Content: content}}
		if err = service.AppendEvent(ctx, created.Session, event); err != nil {
			return "", nil, err
		}
	}
	finished := time.Now()
	if err = store.DB.Model(&nativeHistoryMigration{}).Where("id = ? AND status = ?", migration.ID, "importing").Updates(map[string]any{"status": "complete", "completed_at": finished, "imported_events": created.Session.Events().Len()}).Error; err != nil {
		return "", nil, err
	}
	s.mu.Lock()
	s.state.Runtime = &RuntimeCheckpoint{SchemaVersion: 1, SessionID: importedID, HistoryHash: digest, Identity: identity}
	err = e.save(s)
	s.mu.Unlock()
	return importedID, current, err
}
