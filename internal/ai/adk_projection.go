package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"gorm.io/gorm"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/artifact"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/plugin"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/compaction"
	"google.golang.org/genai"
)

const nativeProjectionKey = "lake_context_projection"

type nativeProjectionRef struct {
	Version int64  `json:"version"`
	Hash    string `json:"hash"`
	EventID string `json:"eventId"`
}
type nativeProjection struct {
	StrategyOutbox []StrategyTurnSnapshot   `json:"strategyOutbox,omitempty"`
	PromptBaseline *strategy.PromptBaseline `json:"promptBaseline,omitempty"`
	SkillSnapshots []strategy.SkillSnapshot `json:"skillSnapshots,omitempty"`
	Runtime        *RuntimeCheckpoint       `json:"runtime,omitempty"`
	References     []string                 `json:"references,omitempty"`
	Scope          *TargetScope             `json:"scope,omitempty"`
	History        []Message                `json:"history"`
	View           View                     `json:"view"`
	RootQuestion   string                   `json:"rootQuestion"`
}

// The public SDK content format cannot represent every provider's signed
// reasoning/native blocks. Store that lossless projection in the official
// session's artifact/state interfaces; the JSON file is a replaceable UI cache.
func (e *Engine) projectionDelta(ctx context.Context, s *session, runtimeID, eventID string) (map[string]any, error) {
	s.mu.Lock()
	c := s.state.Config
	raw, err := json.Marshal(nativeProjection{StrategyOutbox: s.state.StrategyOutbox, PromptBaseline: s.state.PromptBaseline, SkillSnapshots: s.state.SkillSnapshots, History: s.state.History, View: s.state.View, RootQuestion: s.state.RootQuestion, Runtime: s.state.Runtime, References: s.state.ReferencedAssetIDs, Scope: s.state.TargetScope})
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	raw = safeJSON(raw, c)
	service := &nativeArtifacts{engine: e, sessionID: runtimeID, config: c}
	saved, err := service.Save(ctx, &artifact.SaveRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID, FileName: "lake-context.json", Part: &genai.Part{Text: string(raw)}})
	if err != nil {
		return nil, err
	}
	return map[string]any{nativeProjectionKey: nativeProjectionRef{Version: saved.Version, Hash: hash(string(raw)), EventID: eventID}}, nil
}

func (e *Engine) projectionPlugin(s *session, runtimeID string) (*plugin.Plugin, error) {
	return plugin.New(plugin.Config{Name: "lake_durable_projection", OnEventCallback: func(ic agent.InvocationContext, event *adksession.Event) (*adksession.Event, error) {
		if event == nil || event.Partial {
			return event, nil
		}
		s.mu.Lock()
		c := s.state.Config
		s.mu.Unlock()
		raw, err := json.Marshal(event)
		if err != nil {
			return nil, err
		}
		var clean adksession.Event
		if err = json.Unmarshal(safeJSON(raw, c), &clean); err != nil {
			return nil, err
		}
		if err = e.persistContentImages(ic, clean.Content, runtimeID, c); err != nil {
			return nil, err
		}
		delta, err := e.projectionDelta(ic, s, runtimeID, event.ID)
		if err != nil {
			return nil, err
		}
		if clean.Actions.StateDelta == nil {
			clean.Actions.StateDelta = map[string]any{}
		}
		for k, v := range delta {
			clean.Actions.StateDelta[k] = v
		}
		return &clean, nil
	}})
}

func (e *Engine) hydrateNativeProjection(ctx context.Context, s *session) error {
	s.mu.Lock()
	checkpoint := s.state.Runtime
	c := s.state.Config
	if checkpoint == nil || checkpoint.Detached || s.cancel != nil {
		s.mu.Unlock()
		return nil
	}
	runtimeID := checkpoint.SessionID
	s.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	stored, err := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID})
	if err != nil {
		return err
	}
	value, err := stored.Session.State().Get(nativeProjectionKey)
	if errors.Is(err, adksession.ErrStateKeyNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var ref nativeProjectionRef
	if json.Unmarshal([]byte(js(value)), &ref) != nil || ref.Version < 1 {
		return errors.New("invalid ADK projection reference")
	}
	part, err := (&nativeArtifacts{engine: e, sessionID: runtimeID, config: c}).Load(ctx, &artifact.LoadRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID, FileName: "lake-context.json", Version: ref.Version})
	if err != nil {
		return err
	}
	if hash(part.Part.Text) != ref.Hash {
		return errors.New("ADK projection checksum mismatch")
	}
	var projection nativeProjection
	if err = json.Unmarshal([]byte(part.Part.Text), &projection); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return nil
	}
	s.state.StrategyOutbox = projection.StrategyOutbox
	s.state.PromptBaseline = projection.PromptBaseline
	s.state.SkillSnapshots = projection.SkillSnapshots
	s.state.History = projection.History
	s.state.View = projection.View
	s.state.RootQuestion = projection.RootQuestion
	return e.save(s)
}

// The SDK invokes this service for tail retention. Lake keeps its established
// budget, summary prompt and 45-second deadline; ADK records the covered range.
type nativeCompaction struct {
	engine  *Engine
	session *session
	config  Config
}

func (n *nativeCompaction) SummarizeEvents(ctx context.Context, events []*adksession.Event) (compaction.SummarizeResult, error) {
	if len(events) == 0 {
		return compaction.SummarizeResult{}, nil
	}
	n.session.mu.Lock()
	before := hash(js(n.session.state.History))
	n.session.mu.Unlock()
	// ADK's event estimate and Lake's provider-native projection differ. Share
	// the measured budget gate with normal provider requests; an SDK callback
	// must not force a second summary of an already compacted projection.
	if err := n.engine.compact(ctx, n.session, n.config, false); err != nil {
		return compaction.SummarizeResult{}, err
	}
	n.session.mu.Lock()
	defer n.session.mu.Unlock()
	if before == hash(js(n.session.state.History)) {
		return compaction.SummarizeResult{}, nil
	}
	summary := n.session.state.View.Summary
	if summary == "" {
		summary = "Earlier tool output was reduced to bounded context previews. Original operation records remain available."
	}
	return compaction.SummarizeResult{Content: &genai.Content{Role: "user", Parts: []*genai.Part{{Text: summary}}}}, nil
}

var _ compaction.Summarizer = (*nativeCompaction)(nil)

func (e *Engine) persistNativeProjection(ctx context.Context, s *session) error {
	s.mu.Lock()
	cp := s.state.Runtime
	s.mu.Unlock()
	if cp == nil {
		return nil
	}
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	stored, err := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: cp.SessionID})
	if err != nil {
		return err
	}
	id := uid()
	delta, err := e.projectionDelta(ctx, s, cp.SessionID, id)
	if err != nil {
		return err
	}
	event := &adksession.Event{ID: id, Author: nativeProjectionAuthor(cp), InvocationID: "projection_" + id, Timestamp: time.Now(), Actions: adksession.EventActions{StateDelta: delta}, LLMResponse: model.LLMResponse{}}
	if err = store.Sessions.AppendEvent(ctx, stored.Session, event); err != nil {
		return fmt.Errorf("persist ADK projection: %w", err)
	}
	return nil
}

func nativeProjectionAuthor(cp *RuntimeCheckpoint) string {
	if cp.Identity.Role != "" {
		return "lake_" + string(cp.Identity.Role)
	}
	return "lake_chat"
}

func (e *Engine) persistContentImages(ctx context.Context, content *genai.Content, runtimeID string, c Config) error {
	if content == nil {
		return nil
	}
	service := &nativeArtifacts{engine: e, sessionID: runtimeID, config: c}
	for _, part := range content.Parts {
		if part == nil || part.InlineData == nil {
			continue
		}
		name := "media-" + hash(base64.StdEncoding.EncodeToString(part.InlineData.Data))
		saved, err := service.Save(ctx, &artifact.SaveRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID, FileName: name, Part: &genai.Part{InlineData: part.InlineData}})
		if err != nil {
			return err
		}
		mime := part.InlineData.MIMEType
		part.InlineData = nil
		part.FileData = &genai.FileData{MIMEType: mime, FileURI: fmt.Sprintf("lake-artifact://%s/%s?version=%d", runtimeID, name, saved.Version)}
	}
	return nil
}

// The migration index identifies the active official session when the local
// context cache is missing. No credential is recovered from this projection.
func (e *Engine) recoverMissingNativeState(ctx context.Context, id string) (*State, error) {
	if _, err := os.Stat(filepath.Join(e.runtimeDirectory(), "sessions.sqlite")); os.IsNotExist(err) {
		return nil, nil
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	var migration nativeHistoryMigration
	if err = store.DB.Where("session_id = ? AND status = ?", id, "complete").Order("created_at DESC").First(&migration).Error; errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	stored, err := store.Sessions.Get(ctx, &adksession.GetRequest{AppName: "lake", UserID: "lake", SessionID: migration.RuntimeSessionID})
	if err != nil {
		return nil, err
	}
	value, err := stored.Session.State().Get(nativeProjectionKey)
	if errors.Is(err, adksession.ErrStateKeyNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ref nativeProjectionRef
	if err = json.Unmarshal([]byte(js(value)), &ref); err != nil {
		return nil, err
	}
	loaded, err := (&nativeArtifacts{engine: e, sessionID: migration.RuntimeSessionID}).Load(ctx, &artifact.LoadRequest{AppName: "lake", UserID: "lake", SessionID: migration.RuntimeSessionID, FileName: "lake-context.json", Version: ref.Version})
	if err != nil {
		return nil, err
	}
	if hash(loaded.Part.Text) != ref.Hash {
		return nil, errors.New("ADK projection checksum mismatch")
	}
	var projection nativeProjection
	if err = json.Unmarshal([]byte(loaded.Part.Text), &projection); err != nil {
		return nil, err
	}
	if projection.View.Session != id {
		return nil, errors.New("ADK projection outside requested session")
	}
	checkpoint := projection.Runtime
	if checkpoint == nil {
		checkpoint = &RuntimeCheckpoint{SchemaVersion: 1, SessionID: migration.RuntimeSessionID, HistoryHash: hash(js(projection.History)), Identity: RunIdentity{SessionID: id, RootTurnID: projection.View.RootTurnID}}
	}
	state := &State{StrategyOutbox: projection.StrategyOutbox, PromptBaseline: projection.PromptBaseline, SkillSnapshots: projection.SkillSnapshots, Runtime: checkpoint, History: projection.History, View: projection.View, RootQuestion: projection.RootQuestion, ReferencedAssetIDs: projection.References, TargetScope: projection.Scope}
	if len(state.View.PendingApprovals) == 0 && !nativeQuestionReady(state.View.Question) && state.View.Status == "running" {
		state.View.Status = "interrupted"
		reconcile(state, "cache recovered after interrupted invocation; inspect recorded outcomes, no replay")
	}
	return state, nil
}

// The caller owns s.mu; reserve the idle session while publishing an intentional
// context edit so a new turn cannot race its canonical ADK state transition.
func (e *Engine) saveNativeMutationLocked(s *session) error {
	done, err := e.admitRuntime()
	if err != nil {
		return err
	}
	defer done()
	if err = e.save(s); err != nil {
		return err
	}
	s.cancel = func() {}
	s.mu.Unlock()
	work, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	err = e.persistNativeProjection(work, s)
	cancel()
	s.mu.Lock()
	s.cancel = nil
	return err
}
