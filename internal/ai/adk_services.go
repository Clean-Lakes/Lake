package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"google.golang.org/adk/v2/artifact"
	"google.golang.org/adk/v2/memory"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/genai"
	"gorm.io/gorm"
)

type nativeArtifact struct {
	SessionID string `gorm:"primaryKey"`
	FileName  string `gorm:"primaryKey"`
	Version   int64  `gorm:"primaryKey"`
	Part      []byte
	Metadata  string
	MIMEType  string
	CreatedAt time.Time
}

// nativeArtifacts is bound to one runner session. Requests for another app,
// user, or session are rejected even when the caller knows its identifiers.
type nativeArtifacts struct {
	engine    *Engine
	sessionID string
	config    Config
}

func (a *nativeArtifacts) authorize(app, user, session string) error {
	if app != "lake" || user != "lake" || session != a.sessionID {
		return errors.New("artifact outside current session")
	}
	return nil
}
func (a *nativeArtifacts) query(ctx context.Context, app, user, session, name string) (*gorm.DB, error) {
	if err := a.authorize(app, user, session); err != nil {
		return nil, err
	}
	store, err := a.engine.adkStore()
	if err != nil {
		return nil, err
	}
	q := store.DB.WithContext(ctx).Model(&nativeArtifact{}).Where("session_id = ?", session)
	if name != "" {
		q = q.Where("file_name = ?", name)
	}
	return q, nil
}
func (a *nativeArtifacts) Save(ctx context.Context, req *artifact.SaveRequest) (*artifact.SaveResponse, error) {
	if req == nil {
		return nil, errors.New("nil artifact request")
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	q, err := a.query(ctx, req.AppName, req.UserID, req.SessionID, req.FileName)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(req.Part)
	if err != nil {
		return nil, err
	}
	if len(data) > 24<<20 {
		return nil, errors.New("artifact exceeds 24 MiB")
	}
	data = safeJSON(data, a.config)
	metadata := map[string]any{}
	for key, value := range req.CustomMetadata {
		metadata[key] = redact(fmt.Sprint(value), a.config)
	}
	version := req.Version
	err = q.Transaction(func(tx *gorm.DB) error {
		if version == 0 {
			if err := tx.Model(&nativeArtifact{}).Select("COALESCE(MAX(version), 0)").Scan(&version).Error; err != nil {
				return err
			}
			version++
		}
		mime := ""
		if req.Part.InlineData != nil {
			mime = req.Part.InlineData.MIMEType
		}
		return tx.Create(&nativeArtifact{SessionID: req.SessionID, FileName: req.FileName, Version: version, Part: data, Metadata: js(metadata), MIMEType: mime, CreatedAt: time.Now()}).Error
	})
	if err != nil {
		return nil, err
	}
	return &artifact.SaveResponse{Version: version}, nil
}
func (a *nativeArtifacts) find(ctx context.Context, app, user, session, name string, version int64) (nativeArtifact, error) {
	q, err := a.query(ctx, app, user, session, name)
	if err != nil {
		return nativeArtifact{}, err
	}
	if version > 0 {
		q = q.Where("version = ?", version)
	}
	var found nativeArtifact
	err = q.Order("version DESC").First(&found).Error
	return found, err
}
func (a *nativeArtifacts) Load(ctx context.Context, req *artifact.LoadRequest) (*artifact.LoadResponse, error) {
	if req == nil {
		return nil, errors.New("nil artifact request")
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	row, err := a.find(ctx, req.AppName, req.UserID, req.SessionID, req.FileName, req.Version)
	if err != nil {
		return nil, err
	}
	var part genai.Part
	if err = json.Unmarshal(row.Part, &part); err != nil {
		return nil, err
	}
	return &artifact.LoadResponse{Part: &part}, nil
}
func (a *nativeArtifacts) Delete(ctx context.Context, req *artifact.DeleteRequest) error {
	if req == nil {
		return errors.New("nil artifact request")
	}
	if err := req.Validate(); err != nil {
		return err
	}
	q, err := a.query(ctx, req.AppName, req.UserID, req.SessionID, req.FileName)
	if err != nil {
		return err
	}
	if req.Version > 0 {
		q = q.Where("version = ?", req.Version)
	}
	return q.Delete(&nativeArtifact{}).Error
}
func (a *nativeArtifacts) List(ctx context.Context, req *artifact.ListRequest) (*artifact.ListResponse, error) {
	if req == nil {
		return nil, errors.New("nil artifact request")
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	q, err := a.query(ctx, req.AppName, req.UserID, req.SessionID, "")
	if err != nil {
		return nil, err
	}
	names := []string{}
	err = q.Distinct().Order("file_name").Pluck("file_name", &names).Error
	return &artifact.ListResponse{FileNames: names}, err
}
func (a *nativeArtifacts) Versions(ctx context.Context, req *artifact.VersionsRequest) (*artifact.VersionsResponse, error) {
	if req == nil {
		return nil, errors.New("nil artifact request")
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	q, err := a.query(ctx, req.AppName, req.UserID, req.SessionID, req.FileName)
	if err != nil {
		return nil, err
	}
	versions := []int64{}
	err = q.Order("version").Pluck("version", &versions).Error
	return &artifact.VersionsResponse{Versions: versions}, err
}
func (a *nativeArtifacts) GetArtifactVersion(ctx context.Context, req *artifact.GetArtifactVersionRequest) (*artifact.GetArtifactVersionResponse, error) {
	if req == nil {
		return nil, errors.New("nil artifact request")
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	row, err := a.find(ctx, req.AppName, req.UserID, req.SessionID, req.FileName, req.Version)
	if err != nil {
		return nil, err
	}
	metadata := map[string]any{}
	if err = json.Unmarshal([]byte(row.Metadata), &metadata); err != nil {
		return nil, err
	}
	uri := "lake-artifact://" + url.PathEscape(row.SessionID) + "/" + url.PathEscape(row.FileName) + fmt.Sprintf("?version=%d", row.Version)
	return &artifact.GetArtifactVersionResponse{ArtifactVersion: &artifact.ArtifactVersion{Version: row.Version, CanonicalURI: uri, CustomMetadata: metadata, CreateTime: row.CreatedAt, MimeType: row.MIMEType}}, nil
}

type nativeMemory struct {
	engine    *Engine
	session   *session
	config    Config
	runtimeID string
}

func (m *nativeMemory) SearchMemory(ctx context.Context, req *memory.SearchRequest) (*memory.SearchResponse, error) {
	if req == nil || req.AppName != "lake" || req.UserID != "lake" {
		return nil, errors.New("memory outside current user")
	}
	c := m.config
	if !c.MemoryEnabled || c.MemoryProjectID == "" || m.engine.Bridge == nil {
		return &memory.SearchResponse{Memories: []memory.Entry{}}, nil
	}
	m.session.mu.Lock()
	id := m.session.state.View.Session
	current := m.session.state.Config
	m.session.mu.Unlock()
	if !current.MemoryEnabled || current.MemoryProjectID != c.MemoryProjectID {
		return nil, errors.New("project memory permission changed")
	}
	result, err := m.engine.bridgeCall(ctx, id, "list_project_memories", map[string]any{"query": req.Query, "limit": 20}, false)
	if err != nil {
		return nil, err
	}
	body := redact(js(result), c)
	return &memory.SearchResponse{Memories: []memory.Entry{{ID: hash(body), Author: "project_memory", Content: &genai.Content{Role: "user", Parts: []*genai.Part{{Text: "Untrusted project memory search results; not execution authorization:\n" + body}}}, CustomMetadata: map[string]any{"projectId": c.MemoryProjectID}}}}, nil
}
func (m *nativeMemory) AddSessionToMemory(ctx context.Context, session adksession.Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if session == nil || session.AppName() != "lake" || session.UserID() != "lake" || session.ID() != m.runtimeID {
		return errors.New("memory session outside current scope")
	}
	// Ingestion uses Lake's existing consent/epoch/revision-checked outbox. The
	// official service never writes raw conversation events into long-term facts.
	m.session.mu.Lock()
	defer m.session.mu.Unlock()
	c := m.session.state.Config
	if !c.MemoryEnabled || !c.MemoryExtractionEnabled || c.MemoryProjectID != m.config.MemoryProjectID {
		return errors.New("project memory ingestion disabled")
	}
	for _, snapshot := range m.session.state.MemoryOutbox {
		if snapshot.TurnID == m.session.state.View.RootTurnID {
			return nil
		}
	}
	m.engine.collectMemorySnapshot(m.session, c, TurnInput{UserText: m.session.state.RootQuestion})
	return m.engine.save(m.session)
}

var _ artifact.Service = (*nativeArtifacts)(nil)
var _ memory.Service = (*nativeMemory)(nil)
