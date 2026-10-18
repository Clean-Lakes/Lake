package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"google.golang.org/adk/v2/model"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"
)

type nativeHistoryMigration struct {
	ID               string `gorm:"primaryKey"`
	SessionID        string `gorm:"index"`
	RuntimeSessionID string
	SourceHash       string
	SchemaVersion    int
	Status           string
	ImportedEvents   int
	CreatedAt        time.Time
	CompletedAt      *time.Time
}

func (e *Engine) backupNativeMigration(ctx context.Context, s *session, previous []Message) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	root := filepath.Join(e.runtimeDirectory(), "migrations")
	if err = platform.MkdirAll(root, 0700); err != nil {
		return err
	}
	if err = store.Backup(ctx, filepath.Join(root, "before-native-v1.sqlite")); err != nil {
		return err
	}
	s.mu.Lock()
	copy := s.state
	c := s.state.Config
	s.mu.Unlock()
	copy.History = previous
	copy.Config.Model.Key = ""
	copy.Config.Model.Headers = nil
	raw, err := json.Marshal(copy)
	if err != nil {
		return err
	}
	raw = safeJSON(raw, c)
	path := filepath.Join(root, copy.View.Session+"-"+hash(js(previous))+".json")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(raw); err != nil {
		return err
	}
	return f.Sync()
}

// importSpikeHistory retains sessions created by the original Web-only ADK
// integration. Incomplete tool batches become explicit unknown results; they
// are never resumed or replayed during history import.
func (e *Engine) importSpikeHistory(ctx context.Context, s *session, service adksession.Service, previous []Message) ([]Message, error) {
	if len(previous) > 1 {
		return previous, nil
	}
	s.mu.Lock()
	id := s.state.View.Session
	s.mu.Unlock()
	old, err := service.Get(ctx, &adksession.GetRequest{AppName: "lake-adk-spike", UserID: "lake", SessionID: id})
	if errors.Is(err, adksession.ErrNotFound) {
		return previous, nil
	}
	if err != nil {
		return nil, err
	}
	contents := []*genai.Content{}
	for event := range old.Session.Events().All() {
		if event.Partial || event.Content == nil {
			continue
		}
		content := &genai.Content{Role: event.Content.Role}
		for _, part := range event.Content.Parts {
			if part == nil {
				continue
			}
			if part.FunctionCall != nil && part.FunctionCall.Name == toolconfirmation.FunctionCallName {
				continue
			}
			if part.FunctionResponse != nil && part.FunctionResponse.Name == toolconfirmation.FunctionCallName {
				continue
			}
			if part.FunctionResponse != nil && part.FunctionResponse.Response["approval_required"] == true {
				continue
			}
			content.Parts = append(content.Parts, part)
		}
		if len(content.Parts) > 0 {
			contents = append(contents, content)
		}
	}
	messages, _, err := ADKRequest(&model.LLMRequest{Contents: contents})
	if err != nil {
		return nil, err
	}
	imported := State{History: append(append([]Message(nil), previous...), messages...)}
	reconcile(&imported, "historical operation interrupted; inspect before retrying; never replayed")
	if err = validHistory(imported.History); err != nil {
		return nil, err
	}
	s.mu.Lock()
	current := s.state.History[len(s.state.History)-1]
	s.state.History = append(append([]Message(nil), imported.History...), current)
	err = e.save(s)
	s.mu.Unlock()
	return imported.History, err
}
