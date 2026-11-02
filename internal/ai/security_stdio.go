package ai

import (
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"strings"
	"time"
)

// SecurityStdioHost resolves host configure frames through the same Home's
// actual asset/session catalog. No model tool can construct this adapter.
type SecurityStdioHost interface {
	BindConfig(context.Context, string, string, Config) (Config, error)
	Close() error
}

// Managed bridges remain inside the actual Home host; the registered permit
// stays in context and is never serialized into an external callback frame.
type SecurityStdioBridgeHost interface {
	Bridge(context.Context, string, string, map[string]any, bool) (any, error)
}
type SecurityStdioHostFactory func(context.Context, *SecurityHome, *Engine) (SecurityStdioHost, error)

// SetSecurityEntrySource binds provenance once at host startup. A callback
// Bridge describes transport and is not evidence that the entrypoint is Web.
func (e *Engine) SetSecurityEntrySource(source string) error {
	if source != "web" && source != "standalone" {
		return errors.New("security: invalid host entry source")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.sessions) != 0 || e.securityEntrySource != "" && e.securityEntrySource != source {
		return errors.New("security: entry source already initialized")
	}
	e.securityEntrySource = source
	return nil
}
func (e *Engine) configureSecurityStdio(ctx context.Context, host SecurityStdioHost, frame Frame) (any, error) {
	if strings.TrimSpace(frame.Session) == "" {
		return nil, errors.New("stdio configure requires actual session identity")
	}
	var config Config
	if json.Unmarshal(frame.Data, &config) != nil {
		return nil, errors.New("invalid request data")
	}
	if host != nil {
		actual, err := host.BindConfig(ctx, frame.Session, frame.HostProjectID, config)
		if err != nil {
			return nil, err
		}
		config = actual
	} else if frame.HostProjectID != "" {
		return nil, errors.New("security: trusted Home catalog adapter required for project binding")
	}
	if err := e.Configure(frame.Session, config); err != nil {
		return nil, err
	}
	if host != nil {
		return nil, e.recordSecurityStdioEntry(ctx, configSecurityProject(config), frame.Session, frame.ID)
	}
	return nil, nil
}

func (e *Engine) recordSecurityStdioEntry(ctx context.Context, projectID, sessionID, frameID string) error {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		var snapshot securityLegacySessionPolicyRow
		if err := tx.First(&snapshot, "project_id = ? AND session_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, sessionID, storeID, epoch).Error; err != nil {
			return err
		}
		result := map[string]any{"project_id": projectID, "session_id": sessionID, "entry_source": "standalone", "original_source": snapshot.Source, "permissions_revision": snapshot.Revision}
		action := "stdio-entry:" + hash(frameID)
		request := js(result)
		var old map[string]any
		if replay, err := securityActionReplay(tx, storeID, epoch, "host:stdio", action, request, &old); replay || err != nil {
			return err
		}
		return securityActionRecord(tx, storeID, epoch, "host:stdio", action, "session.entry", sessionID, request, snapshot.Revision, snapshot.Revision, result, time.Now().UTC(), projectID)
	})
}
