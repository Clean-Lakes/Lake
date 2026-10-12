package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type session struct {
	mu       sync.Mutex
	state    State
	cancel   context.CancelFunc
	decision chan bool
}
type Engine struct {
	agentMu          sync.Mutex
	agentWorkers     map[string]*agentWorker
	agentSlots       chan struct{}
	modelSlots       chan struct{}
	childModelSlots  chan struct{}
	agentsClosed     bool
	worker           *agentWorker
	observationSlots sync.Map
	mu               sync.Mutex
	sessions         map[string]*session
	Dir              string
	Bridge           Bridge
	Emit             func(Event)
	tunnels          sync.Map
	shells           sync.Map
	shellMu          sync.Mutex
	shellsClosed     bool
}

func New(dir string, bridge Bridge, emit func(Event)) (*Engine, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	return &Engine{sessions: map[string]*session{}, Dir: dir, Bridge: bridge, Emit: emit, agentWorkers: map[string]*agentWorker{}, agentSlots: make(chan struct{}, 6), modelSlots: make(chan struct{}, 4), childModelSlots: make(chan struct{}, 3)}, nil
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

func (e *Engine) get(id string) (*session, error) {
	if !identifier.MatchString(id) {
		return nil, errors.New("invalid session id")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if s := e.sessions[id]; s != nil {
		return s, nil
	}
	s := &session{state: State{View: View{Session: id, Status: "idle", Cards: []Card{}, Profile: "core"}, History: []Message{}}}
	b, err := os.ReadFile(filepath.Join(e.Dir, id+".json"))
	if err == nil {
		if json.Unmarshal(b, &s.state) != nil {
			return nil, errors.New("AI state is invalid")
		}
		if s.state.View.Status == "running" || s.state.View.Status == "waiting_approval" {
			s.state.View.Status = "interrupted"
			s.state.View.Pending = nil
			reconcile(&s.state, "interrupted; inspect before retrying")
			for i := range s.state.View.Cards {
				if s.state.View.Cards[i].Status == "running" || s.state.View.Cards[i].Status == "pending" {
					s.state.View.Cards[i].Status = "interrupted"
				}
			}
			for i := range s.state.View.AgentRuns {
				run := &s.state.View.AgentRuns[i]
				if agentActive(run.Status) {
					run.Status, run.Summary, run.FinishedAt = "interrupted", "调查因服务重启中断；未自动重放。", timestamp()
					run.Pending, run.CanCancel = nil, false
				}
			}
			if err := e.save(s); err != nil {
				return nil, err
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	e.sessions[id] = s
	return s, nil
}
func redact(text string, c Config) string {
	for _, secret := range append(append([]string{c.Model.Key}, headerValues(c.Model.Headers)...), c.AuthSecrets...) {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[REDACTED]")
			encoded, _ := json.Marshal(secret)
			if len(encoded) > 2 {
				text = strings.ReplaceAll(text, string(encoded[1:len(encoded)-1]), "[REDACTED]")
			}
		}
	}
	text = privateKey.ReplaceAllString(text, "[PRIVATE KEY REDACTED]")
	text = jsonSecret.ReplaceAllString(text, "${1}[REDACTED]${2}")
	return lineSecret.ReplaceAllString(text, "${1} [REDACTED]")
}
func headerValues(headers map[string]string) []string {
	out := []string{}
	for _, v := range headers {
		out = append(out, v)
	}
	return out
}

var privateKey = regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)`)
var secretField = regexp.MustCompile(`(?i)^(?:api[_-]?key|password|secret|token|private[_-]?key)$`)
var jsonSecret = regexp.MustCompile(`(?i)("(?:api[_-]?key|password|secret|token|private[_-]?key)"\s*:\s*")(?:\\.|[^"\\])*(")`)
var lineSecret = regexp.MustCompile(`(?im)^([ \t]*(?:api[_-]?key|password|secret|token|private[_-]?key)[ \t]*[=:])[ \t]*[^\n]+$`)

func sanitize(v any, c Config) any {
	switch x := v.(type) {
	case string:
		return redact(x, c)
	case map[string]any:
		for k, v := range x {
			if text, ok := v.(string); ok && secretField.MatchString(k) {
				x[k] = "[REDACTED]"
				_ = text
			} else {
				x[k] = sanitize(v, c)
			}
		}
		return x
	case []any:
		for i, v := range x {
			x[i] = sanitize(v, c)
		}
		return x
	}
	return v
}
func safeJSON(b []byte, c Config) []byte {
	var v any
	if json.Unmarshal(b, &v) != nil {
		return []byte(`null`)
	}
	out, _ := json.Marshal(sanitize(v, c))
	return out
}
func (e *Engine) save(s *session) error {
	copy := s.state
	copy.Config.Model.Key = ""
	copy.Config.Model.Headers = nil
	b, err := json.Marshal(copy)
	if err != nil {
		return err
	}
	b = safeJSON(b, s.state.Config)
	path := filepath.Join(e.Dir, s.state.View.Session+".json")
	tmp, err := os.CreateTemp(e.Dir, ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(b)
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
func (e *Engine) notify(s *session, kind string, v any) {
	if e.Emit != nil {
		data := v
		b, _ := json.Marshal(v)
		_ = json.Unmarshal(safeJSON(b, s.state.Config), &data)
		e.Emit(Event{s.state.View.Session, kind, data})
	}
}
func (e *Engine) Configure(id string, c Config) error {
	if c.MultiAgentMode != "" && c.MultiAgentMode != "off" && c.MultiAgentMode != "auto" {
		return errors.New("invalid multi-agent mode")
	}
	c.AuthSecrets = nil
	for _, asset := range c.Assets {
		if asset.SSH != nil && asset.SSH.CredentialRef != "" {
			secret, err := sshSecret(asset.SSH.CredentialRef, c.CredentialDir)
			if err != nil {
				return err
			}
			c.AuthSecrets = append(c.AuthSecrets, secret)
		}
	}
	if c.Permissions != nil {
		permissions := *c.Permissions
		c.Permissions = &permissions
	}
	if c.Profile == "" {
		c.Profile = "core"
	}
	if c.Profile != "core" && c.Profile != "terminal2" && c.Profile != "db-query-editor" {
		return errors.New("invalid tool profile")
	}
	if c.Runtime == "" {
		c.Runtime = "local"
	}
	if c.Runtime != "local" && c.Runtime != "ssh" && c.Runtime != "container" {
		return errors.New("invalid runtime")
	}
	if c.MaxSteps <= 0 || c.MaxSteps > 500 {
		c.MaxSteps = 500
	}
	if c.Model.ContextWindow == 0 {
		c.Model.ContextWindow = 64000
	}
	if c.Model.ContextWindow < 2048 {
		return errors.New("context window must be at least 2048")
	}
	if c.Model.MaxOutput <= 0 {
		c.Model.MaxOutput = 8192
	}
	if c.Model.MaxOutput >= c.Model.ContextWindow {
		c.Model.MaxOutput = c.Model.ContextWindow / 4
	}
	if _, _, err := modelPayload(c.Model, []Message{}, nil); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, a := range c.Assets {
		if a.ID == "" || seen[a.ID] {
			return errors.New("invalid or duplicate asset id")
		}
		seen[a.ID] = true
		for _, k := range []string{"password", "key", "privateKey", "apiKey", "token"} {
			if a.Settings[k] != nil {
				return errors.New("asset credentials must use credentialRef")
			}
		}
	}
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return errors.New("session busy")
	}
	if ModelIdentity(s.state.Config.Model) != ModelIdentity(c.Model) {
		s.state.LastRequest = nil
		s.state.LastRequestAt = ""
	}
	s.state.ReferencedAssetIDs = validRemembered(c, s.state.ReferencedAssetIDs)
	c.ReferencedAssets = append([]string(nil), s.state.ReferencedAssetIDs...)
	s.state.Config = c
	s.state.View.Profile = c.Profile
	return e.save(s)
}
func (e *Engine) Snapshot(id string) (View, error) { return e.SnapshotPage(id, 0, 300) }
func (e *Engine) SnapshotPage(id string, before, limit int) (View, error) {
	s, err := e.get(id)
	if err != nil {
		return View{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	view := s.state.View
	view.Context = contextUsage(s.state)
	view.TotalCards = len(view.Cards)
	end := len(view.Cards)
	if before > 0 {
		end = min(before, end)
	}
	limit = bounded(limit, 1, 300)
	start := end
	bytes := 0
	for start > 0 && end-start < limit {
		size := len(js(view.Cards[start-1]))
		if end > start && bytes+size > 4<<20 {
			break
		}
		bytes += size
		start--
	}
	view.Cards = append([]Card{}, view.Cards[start:end]...)
	view.CardsOffset = start
	b, _ := json.Marshal(view)
	var snapshot View
	_ = json.Unmarshal(safeJSON(b, s.state.Config), &snapshot)
	return snapshot, nil
}
func (e *Engine) History(id string) ([]Message, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var h []Message
	b, _ := json.Marshal(s.state.History)
	_ = json.Unmarshal(safeJSON(b, s.state.Config), &h)
	return h, nil
}
func (e *Engine) Abort(id string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	return nil
}
func (e *Engine) Decision(id, approval string, accept bool, confirmation string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.state.View.Pending
	if p == nil || p.ID != approval || s.decision == nil {
		return errors.New("approval expired or already decided")
	}
	if accept && p.Confirmation != "" && confirmation != p.Confirmation {
		return errors.New("explicit target confirmation required")
	}
	select {
	case s.decision <- accept:
		s.decision = nil
		return nil
	default:
		return errors.New("approval already decided")
	}
}
func reconcile(st *State, why string) {
	pending := map[string]Call{}
	for _, m := range st.History {
		for _, c := range m.Calls {
			pending[c.ID] = c
		}
		if m.Role == "tool" {
			delete(pending, m.CallID)
		}
	}
	for _, m := range st.History {
		for _, c := range m.Calls {
			if _, ok := pending[c.ID]; ok {
				st.History = append(st.History, Message{Role: "tool", CallID: c.ID, Name: c.Name, Content: js(map[string]any{"error": why, "outcome": "unknown; not replayed"})})
				delete(pending, c.ID)
			}
		}
	}
}
func (e *Engine) Chat(ctx context.Context, id, text string, refs []map[string]any) error {
	return e.ChatImages(ctx, id, text, refs, nil)
}
func (e *Engine) ChatImages(ctx context.Context, id, text string, refs []map[string]any, images []ImageAttachment) (err error) {
	return e.ChatImagesWithPrelude(ctx, id, text, refs, images, nil)
}

// ChatImagesWithPrelude gathers read-only host context through the normal tool
// pipeline before asking the model for its first response.
func (e *Engine) ChatImagesWithPrelude(ctx context.Context, id, text string, refs []map[string]any, images []ImageAttachment, prelude []Call) error {
	return e.ChatTurn(ctx, id, TurnInput{UserText: text, References: refs, Images: images, Prelude: prelude})
}
func (e *Engine) ChatTurn(ctx context.Context, id string, input TurnInput) (err error) {
	if err = input.validate(); err != nil {
		return err
	}
	text, refs, images, prelude := input.UserText, input.References, input.Images, input.Prelude
	images, err = ValidateImages(images)
	if err != nil {
		return err
	}
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return errors.New("session busy")
	}
	c := s.state.Config
	prelude = append([]Call(nil), prelude...)
	for i := range prelude {
		if prelude[i].Name != "inspect_host" {
			s.mu.Unlock()
			return errors.New("only read-only host inspection is allowed in the turn prelude")
		}
		a, parseErr := args(prelude[i])
		if parseErr != nil {
			s.mu.Unlock()
			return parseErr
		}
		if ref := str(a["asset_ref"]); ref != "" {
			as, assetErr := asset(c, ref)
			if assetErr != nil {
				s.mu.Unlock()
				return assetErr
			}
			a["asset_ref"] = assetAlias(as.ID)
			prelude[i].Arguments = js(a)
		}
	}
	if len(images) > 0 && !c.Model.SupportsImageInput {
		s.mu.Unlock()
		return errors.New("所选模型未启用图片输入能力")
	}
	if c.Model.Name == "" {
		s.mu.Unlock()
		return errors.New("model not configured")
	}
	message := text
	c.ReferencedAssets = validRemembered(c, s.state.ReferencedAssetIDs)
	if len(refs) > 0 {
		for _, r := range refs {
			if ref := str(r["asset_ref"]); ref != "" {
				found := false
				for _, a := range c.Assets {
					if ref == a.ID || ref == assetAlias(a.ID) {
						r["asset_ref"] = assetAlias(a.ID)
						c.ReferencedAssets = append(c.ReferencedAssets, a.ID)
						found = true
					}
				}
				if !found {
					s.mu.Unlock()
					return errors.New("reference outside session")
				}
			}
		}
		message = "[HEXHUB_REFERENCES]\n" + js(refs) + "\n[USER_MESSAGE]\n" + text
	}
	if input.Context != "" {
		message = boundedTurnContext(message, input.Context, c) + "\n" + message
	}
	c.ReferencedAssets = validRemembered(c, c.ReferencedAssets)
	s.state.ReferencedAssetIDs = append([]string(nil), c.ReferencedAssets...)
	ctx, cancel := context.WithCancel(ctx)
	ctx = boundedShellPolling(ctx)
	s.cancel = cancel
	s.state.Config.ReferencedAssets = append([]string(nil), c.ReferencedAssets...)
	s.state.View.Status = "running"
	s.state.View.RootTurnID = uid()
	s.state.RootQuestion = redact(input.UserText, c)
	s.state.View.TurnStartedAt = timestamp()
	s.state.View.TurnFinishedAt = ""
	s.state.View.Pending = nil
	s.state.Checkpoints = append(s.state.Checkpoints, len(s.state.History))
	s.state.View.Turns++
	if s.state.View.StartedAt == "" {
		s.state.View.StartedAt = timestamp()
	}
	if len(s.state.History) == 0 {
		s.state.History = append(s.state.History, Message{Role: "system", Content: Prompt(c)})
	} else {
		s.state.History[0] = Message{Role: "system", Content: Prompt(c)}
	}
	s.state.History = append(s.state.History, Message{Role: "user", Content: redact(message, c), Images: images})
	err = e.save(s)
	s.mu.Unlock()
	if err != nil {
		cancel()
		s.mu.Lock()
		s.cancel = nil
		s.mu.Unlock()
		return err
	}
	defer func() {
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		s.cancel = nil
		s.decision = nil
		s.state.View.Pending = nil
		status := "completed"
		if err != nil {
			status = "failed"
			if errors.Is(err, context.Canceled) {
				status = "cancelled"
			}
			reconcile(&s.state, "turn "+status+"; no replay")
			s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "error", Content: redact(err.Error(), c), Status: status, At: timestamp()})
		}
		s.state.View.Status = status
		s.state.View.TurnFinishedAt = timestamp()
		for i := range s.state.View.Cards {
			card := &s.state.View.Cards[i]
			if card.Status == "running" || card.Status == "pending" {
				card.Status = status
			}
		}
		if saveErr := e.save(s); saveErr != nil && err == nil {
			err = saveErr
		}
		e.notify(s, "done", map[string]any{"status": status})
	}()
	if len(prelude) > 0 {
		s.mu.Lock()
		m := Message{Role: "assistant", Calls: prelude}
		resolveCallIDs(&m, s.state.History)
		s.state.History = append(s.state.History, m)
		err = e.save(s)
		e.notify(s, "historyMessage", m)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		if err = e.invokeCalls(ctx, s, &c, m.Calls); err != nil {
			return err
		}
	}
	for step := 0; step < c.MaxSteps; step++ {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = e.compact(ctx, s, c, false); err != nil {
			return err
		}
		s.mu.Lock()
		history := append([]Message(nil), s.state.History...)
		textID, thinkID := uid(), uid()
		textType := "message"
		if e.worker == nil {
			hasInvestigation, hasReview := false, false
			for _, run := range s.state.View.AgentRuns {
				if run.RootTurnID == s.state.View.RootTurnID {
					hasInvestigation = true
					hasReview = hasReview || run.Role == "verify"
				}
			}
			if hasInvestigation && !hasReview {
				textType = "draft"
			}
		}
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: thinkID, Type: "thinking", Status: "running", At: timestamp()}, Card{ID: textID, Type: textType, Status: "running", At: timestamp()})
		s.mu.Unlock()
		lastFlush := time.Now()
		tools := e.sessionCatalog(ctx, id, c)
		result, modelErr := e.stream(ctx, c.Model, history, tools, func(kind, delta string) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if kind == "image" {
				var img ImageAttachment
				if json.Unmarshal([]byte(delta), &img) == nil {
					s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "image", Data: img, Status: "completed", At: timestamp()})
					e.notify(s, "image", nil)
				}
				return
			}
			id := textID
			if kind == "thinking" {
				id = thinkID
			}
			for i := len(s.state.View.Cards) - 1; i >= 0; i-- {
				card := &s.state.View.Cards[i]
				if card.ID == id {
					card.Content += redact(delta, c)
					if len(card.Content) > 2<<20 {
						cancel()
					}
					break
				}
			}
			if time.Since(lastFlush) > 80*time.Millisecond {
				e.notify(s, "delta", map[string]any{"card_id": id, "kind": kind})
				lastFlush = time.Now()
			}
		})
		if modelErr != nil {
			return modelErr
		}
		s.mu.Lock()
		result.Message.Content = redact(result.Message.Content, c)
		result.Message.Reasoning = redact(result.Message.Reasoning, c)
		resolveCallIDs(&result.Message, s.state.History)
		s.state.History = append(s.state.History, result.Message)
		addUsage(&s.state.View.Usage, result.Usage)
		latest := result.Usage
		s.state.LastRequest = &latest
		s.state.LastRequestAt = timestamp()
		for i := range s.state.View.Cards {
			if s.state.View.Cards[i].ID == textID || s.state.View.Cards[i].ID == thinkID {
				s.state.View.Cards[i].Status = "completed"
			}
		}
		err = e.save(s)
		e.notify(s, "historyMessage", result.Message)
		s.mu.Unlock()
		if err != nil {
			return err
		}
		if len(result.Message.Calls) == 0 {
			if e.needsAgentVerification(s) {
				// Keep the candidate private until an independent evidence review has finished.
				s.mu.Lock()
				for i := range s.state.View.Cards {
					if s.state.View.Cards[i].ID == textID {
						s.state.View.Cards[i].Type = "draft"
					}
				}
				s.mu.Unlock()
				if _, err = e.runInvestigations(ctx, s, c, []investigationSpec{{Role: "verify", Task: "独立验证本轮调查证据"}}); err != nil {
					return err
				}
				m := Message{Role: "assistant", Calls: []Call{{ID: uid(), Name: "read_investigation", Arguments: `{}`}}}
				s.mu.Lock()
				s.state.History = append(s.state.History, m)
				s.mu.Unlock()
				if err = e.invokeCalls(ctx, s, &c, m.Calls); err != nil {
					return err
				}
				continue
			}
			return nil
		}
		if err = e.invokeCalls(ctx, s, &c, result.Message.Calls); err != nil {
			if pause, ok := err.(*pollingPause); ok {
				return e.finishPolling(s, pause)
			}
			return err
		}
	}
	return errors.New("agent step budget reached")
}

func (e *Engine) invokeCalls(ctx context.Context, s *session, c *Config, calls []Call) error {
	for _, call := range calls {
		value, toolErr := e.invoke(ctx, s, *c, call)
		if call.Name == "import_resources" && toolErr == nil {
			s.mu.Lock()
			sessionID := s.state.View.Session
			s.mu.Unlock()
			fresh, err := e.bridgeCall(ctx, sessionID, "resource_import_assets", nil, false)
			if err != nil {
				return err
			}
			if assets, ok := fresh.([]Asset); ok {
				c.Assets = assets
				for _, as := range assets {
					if as.SSH != nil && as.SSH.CredentialRef != "" {
						if secret, err := sshSecret(as.SSH.CredentialRef, c.CredentialDir); err == nil {
							c.AuthSecrets = append(c.AuthSecrets, secret)
						}
					}
				}
				s.mu.Lock()
				s.state.Config.Assets = assets
				s.state.Config.AuthSecrets = c.AuthSecrets
				s.mu.Unlock()
			}
		}
		if errors.Is(toolErr, context.Canceled) || errors.Is(toolErr, context.DeadlineExceeded) {
			return toolErr
		}
		payload := js(value)
		if toolErr != nil {
			payload = js(map[string]any{"error": toolErr.Error()})
		}
		payload = redact(payload, *c)
		if len(payload) > 100000 {
			payload = payload[:100000] + "\n[TRUNCATED]"
		}
		s.mu.Lock()
		if call.Name == "inspect_host" && toolErr == nil {
			data := obj(value)
			if as, assetErr := asset(*c, str(data["asset_ref"])); assetErr == nil && (as.ID == c.AssetRef || assetAlias(as.ID) == c.AssetRef || c.AssetRef == "" && data["bound"] == true) {
				c.AssetRef = as.ID
				c.Runtime = as.Kind
				s.state.Config.AssetRef = c.AssetRef
				s.state.Config.Runtime = c.Runtime
				c.TerminalID = str(data["terminal_id"])
				s.state.Config.TerminalID = c.TerminalID
			}
		}
		s.state.History = append(s.state.History, Message{Role: "tool", CallID: call.ID, Name: call.Name, Content: payload})
		err := e.save(s)
		e.notify(s, "toolResult", map[string]any{"call_id": call.ID})
		s.mu.Unlock()
		if err != nil {
			return err
		}
		if toolErr == nil {
			if err := shellPollingProgress(ctx, call, value); err != nil {
				return err
			}
		}
	}
	return nil
}
func (e *Engine) compact(ctx context.Context, s *session, c Config, force bool) error {
	s.mu.Lock()
	history := append([]Message(nil), s.state.History...)
	id := s.state.View.Session
	s.mu.Unlock()
	chars := len(js(e.sessionCatalog(ctx, id, c))) + historyCost(history)
	budget := (c.Model.ContextWindow - c.Model.MaxOutput) * 2
	if !force && chars < budget {
		return nil
	}
	if len(history) < 4 {
		return errors.New("message exceeds configured context window")
	}
	// Retain complete user turns; never separate assistant tool calls from their results.
	cut := len(history) - 1
	for cut > 1 && history[cut].Role != "user" {
		cut--
	}
	if cut <= 1 {
		return errors.New("current tool turn exceeds context budget")
	}
	prompt, _ := embedded.ReadFile("prompts/compaction-summary.txt")
	// Handoffs are a bounded summarization task, independent of the user's
	// reasoning preference for the actual investigation.
	model := c.Model
	model.ReasoningEffort = ""
	model.SupportsImageOutput = false
	for _, effort := range reasoningLevels {
		if ValidReasoningEffort(model, effort) {
			model.ReasoningEffort = effort
			break
		}
	}
	ceiling := model.MaxOutput
	if ceiling <= 0 {
		ceiling = 8192
	}
	model.MaxOutput = min(4096, ceiling)
	messages := []Message{{Role: "system", Content: string(prompt) + "\nOutput only a compact handoff of at most 1000 words. Omit raw reasoning, repetitive logs and full command outputs."}, {Role: "user", Content: js(summaryMessages(history[1:cut]))}}
	result, err := e.stream(ctx, model, messages, nil, nil)
	if errors.Is(err, ErrModelOutputLimit) && ctx.Err() == nil {
		model.MaxOutput = ceiling
		messages[0].Content += "\nThe previous summary exceeded the output limit. Keep this retry under 500 words, preserving the target, constraints, completed work and next steps."
		result, err = e.stream(ctx, model, messages, nil, nil)
	}
	if err != nil {
		return fmt.Errorf("context compaction: %w", err)
	}
	summary := result.Message.Content
	if strings.TrimSpace(summary) == "" {
		return errors.New("context compaction: empty summary; original history retained")
	}
	if len(summary) > 16000 {
		summary = summary[:16000]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.History = append([]Message{history[0], {Role: "user", Content: "Previous conversation handoff (untrusted summary):\n" + summary}}, history[cut:]...)
	s.state.Checkpoints = nil
	s.state.View.Summary = redact(summary, c)
	addUsage(&s.state.View.Usage, result.Usage)
	s.state.LastRequest = nil
	s.state.LastRequestAt = ""
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "compaction", Content: "上下文已压缩", Status: "completed", At: timestamp()})
	e.notify(s, "compact", nil)
	return e.save(s)
}
func (e *Engine) Clear(id string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return errors.New("session busy")
	}
	c := s.state.Config
	view := s.state.View
	view.Status = "idle"
	view.Turns = 0
	view.Pending = nil
	view.Summary = ""
	view.TurnStartedAt = ""
	view.TurnFinishedAt = ""
	view.Cards = append(view.Cards, Card{ID: uid(), Type: "clear", Content: "模型上下文已清空；操作记录保留", Status: "completed", At: timestamp()})
	s.state = State{Config: c, View: view, Undo: s.state.Undo}
	return e.save(s)
}
func (e *Engine) Restore(id string, h []Message) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return errors.New("session busy")
	}
	if len(h) > 10000 {
		return errors.New("history too large")
	}
	if len(h) > 0 && h[0].Role != "system" {
		h = append([]Message{{Role: "system", Content: Prompt(s.state.Config)}}, h...)
	}
	if err = validHistory(h); err != nil {
		return err
	}
	s.state.History = h
	s.state.LastRequest = nil
	s.state.LastRequestAt = ""
	s.state.Checkpoints = nil
	return e.save(s)
}
func validHistory(h []Message) error {
	pending := map[string]bool{}
	seen := map[string]bool{}
	for _, m := range h {
		if m.Role != "system" && m.Role != "user" && m.Role != "assistant" && m.Role != "tool" {
			return errors.New("invalid message role")
		}
		if m.Role != "tool" && len(pending) > 0 {
			return errors.New("tool result batch incomplete")
		}
		if m.Role == "tool" {
			if !pending[m.CallID] {
				return errors.New("orphan tool result")
			}
			delete(pending, m.CallID)
		}
		for _, c := range m.Calls {
			if m.Role != "assistant" || c.ID == "" || seen[c.ID] {
				return errors.New("invalid tool call id")
			}
			seen[c.ID] = true
			pending[c.ID] = true
		}
	}
	if len(pending) > 0 {
		return errors.New("tool result batch incomplete")
	}
	return nil
}
func (e *Engine) Rollback(id string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return errors.New("session busy")
	}
	if len(s.state.Checkpoints) == 0 {
		return errors.New("no turn checkpoint available after compaction")
	}
	n := s.state.Checkpoints[len(s.state.Checkpoints)-1]
	s.state.Checkpoints = s.state.Checkpoints[:len(s.state.Checkpoints)-1]
	s.state.History = s.state.History[:n]
	s.state.LastRequest = nil
	s.state.LastRequestAt = ""
	s.state.View.Turns--
	s.state.View.Status = "idle"
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "rollback", Content: "模型历史已回退一轮；已执行操作不会自动撤销", Status: "completed", At: timestamp()})
	return e.save(s)
}
func hash(v string) string                   { s := sha256.Sum256([]byte(v)); return hex.EncodeToString(s[:]) }
func (e *Engine) Presets() ([]Preset, error) { e.mu.Lock(); defer e.mu.Unlock(); return e.presets() }
func (e *Engine) presets() ([]Preset, error) {
	b, err := os.ReadFile(filepath.Join(e.Dir, "presets.json"))
	if os.IsNotExist(err) {
		return []Preset{}, nil
	}
	if err != nil {
		return nil, err
	}
	var p []Preset
	err = json.Unmarshal(b, &p)
	return p, err
}
func (e *Engine) SavePreset(p Preset, remove bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !remove {
		for _, session := range e.sessions {
			session.mu.Lock()
			safe := redact(p.Content, session.state.Config) == p.Content && redact(p.Title, session.state.Config) == p.Title
			session.mu.Unlock()
			if !safe {
				return errors.New("preset cannot contain credentials")
			}
		}
	}
	list, err := e.presets()
	if err != nil {
		return err
	}
	if p.ID == "" {
		p.ID = uid()
	}
	if !remove && (p.Title == "" || p.Content == "" || len(p.Content) > 30000) {
		return errors.New("invalid preset")
	}
	out := []Preset{}
	for _, old := range list {
		if old.ID != p.ID {
			out = append(out, old)
		}
	}
	if !remove {
		out = append(out, p)
	}
	b, _ := json.Marshal(out)
	return os.WriteFile(filepath.Join(e.Dir, "presets.json"), b, 0600)
}
func (e *Engine) ExtractPreset(ctx context.Context, id string) (Preset, error) {
	s, err := e.get(id)
	if err != nil {
		return Preset{}, err
	}
	s.mu.Lock()
	c := s.state.Config
	h := append([]Message(nil), s.state.History...)
	s.mu.Unlock()
	r, err := e.stream(ctx, c.Model, []Message{{Role: "system", Content: "Extract a reusable operations prompt from this conversation. Exclude credentials and internal IDs. Return only JSON {\"title\":\"...\",\"content\":\"...\"}. Do not execute tools."}, {Role: "user", Content: js(h)}}, nil, nil)
	if err != nil {
		return Preset{}, err
	}
	var p Preset
	r.Message.Content = redact(r.Message.Content, c)
	err = json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(r.Message.Content), "```json"), "```")), &p)
	p.ID = uid()
	if err == nil {
		err = e.SavePreset(p, false)
	}
	return p, err
}
func (e *Engine) Shutdown() {
	agentDone := e.stopAgentWorkers()
	// 退出或更新时先关闭后台任务准入，等待最终卡片持久化，避免退出后仍写数据目录。
	e.shellMu.Lock()
	e.shellsClosed = true
	e.cancelShells("")
	var shellDone []<-chan struct{}
	e.shells.Range(func(_, value any) bool {
		shellDone = append(shellDone, value.(*shellJob).done)
		return true
	})
	e.shellMu.Unlock()
	e.mu.Lock()
	for _, s := range e.sessions {
		s.mu.Lock()
		if s.cancel != nil {
			s.cancel()
		}
		s.mu.Unlock()
	}
	e.mu.Unlock()
	e.tunnels.Range(func(_, v any) bool {
		if cancel, ok := v.(context.CancelFunc); ok {
			cancel()
		}
		return true
	})
	for _, done := range shellDone {
		<-done
	}
	for _, done := range agentDone {
		<-done
	}
}

func (e *Engine) Compact(ctx context.Context, id string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return errors.New("session busy")
	}
	ctx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	c := s.state.Config
	s.mu.Unlock()
	defer func() { cancel(); s.mu.Lock(); s.cancel = nil; s.mu.Unlock() }()
	return e.compact(ctx, s, c, true)
}
