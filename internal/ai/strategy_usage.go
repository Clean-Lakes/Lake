package ai

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"google.golang.org/genai"
	"gorm.io/gorm"
)

// Read existing durable prepared manifests through the runtime-owned store.
// No new foreground writes, business/ADK schema or model loop are introduced.
func (e *Engine) StrategyUsageHistory(ctx context.Context, id, before string, limit int) ([]strategy.PromptManifest, error) {
	if limit < 1 || limit > 50 {
		return nil, errors.New("invalid history page")
	}
	if _, err := e.get(id); err != nil {
		return nil, err
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	q := store.DB.WithContext(ctx).Model(&nativeArtifact{}).Where("session_id IN (SELECT runtime_session_id FROM native_history_migrations WHERE session_id=? AND status='complete') AND file_name LIKE 'prompt-manifest-%.json' AND version=1", id)
	if before != "" {
		if !identifier.MatchString(before) {
			return nil, errors.New("invalid history cursor")
		}
		var cursor nativeArtifact
		if err := q.Session(&gorm.Session{}).Where("file_name=?", "prompt-manifest-"+before+".json").First(&cursor).Error; err != nil {
			return nil, err
		}
		q = q.Where("(created_at,file_name)<(?,?)", cursor.CreatedAt, cursor.FileName)
	}
	var rows []nativeArtifact
	if err = q.Order("created_at DESC,file_name DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := []strategy.PromptManifest{}
	for _, row := range rows {
		var part genai.Part
		var m strategy.PromptManifest
		if json.Unmarshal(row.Part, &part) != nil || json.Unmarshal([]byte(part.Text), &m) != nil || row.FileName != "prompt-manifest-"+m.RequestID+".json" || m.RunID != row.SessionID {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

func (e *Engine) StrategyUsageRequest(ctx context.Context, id, requestID string) (strategy.PromptManifest, error) {
	if !identifier.MatchString(requestID) {
		return strategy.PromptManifest{}, errors.New("invalid request id")
	}
	if _, err := e.get(id); err != nil {
		return strategy.PromptManifest{}, err
	}
	store, err := e.adkStore()
	if err != nil {
		return strategy.PromptManifest{}, err
	}
	var row nativeArtifact
	err = store.DB.WithContext(ctx).Where("session_id IN (SELECT runtime_session_id FROM native_history_migrations WHERE session_id=? AND status='complete') AND file_name=? AND version=1", id, "prompt-manifest-"+requestID+".json").First(&row).Error
	if err != nil {
		return strategy.PromptManifest{}, err
	}
	var part genai.Part
	var m strategy.PromptManifest
	if json.Unmarshal(row.Part, &part) != nil || json.Unmarshal([]byte(part.Text), &m) != nil || m.RequestID != requestID || m.RunID != row.SessionID {
		return m, errors.New("invalid manifest")
	}
	return m, nil
}
