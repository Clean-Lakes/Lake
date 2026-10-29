package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"google.golang.org/adk/v2/artifact"
	"google.golang.org/genai"
	"time"
)

// next performs one provider request. Only the official LlmAgent decides when
// to request another model response or invoke a function tool.
func (d *adkTurnDriver) next(ctx context.Context) (modelResult, error) {
	e, s, c := d.engine, d.session, *d.config
	s.mu.Lock()
	id := s.state.View.Session
	waiting := len(s.state.View.PendingApprovals) > 0
	s.mu.Unlock()
	if waiting {
		return modelResult{}, errADKApprovalPending
	}
	if _, err := e.resolveTurnStrategies(ctx, s, c); err != nil {
		return modelResult{}, err
	}
	step := d.round
	if step >= c.MaxSteps {
		return modelResult{}, errors.New("agent step budget reached")
	}
	d.round++
	resume := d.resume
	outputRetried := d.outputRetried
	defer func() { d.outputRetried = outputRetried }()
	requestModel := c.Model
	var memoryLive map[string]any
	if c.MemorySchemaVersion == 2 && e.Bridge != nil && e.worker == nil {
		live, err := e.bridgeCall(ctx, id, "project_memory_status", nil, false)
		memoryLive = obj(live)
		if err != nil || obj(live)["useEnabled"] != true {
			c.MemoryEnabled = false
			c.MemoryExtractionEnabled = false
		}
	}
	var err error
	cancel := d.cancel
	if err = ctx.Err(); err != nil {
		return modelResult{}, err
	}
	if e.worker != nil {
		e.worker.mu.Lock()
		if !e.worker.sreReportAt.IsZero() && !time.Now().Before(e.worker.sreReportAt) || !fullSREAgent(c) && c.sre != nil && c.sre.Role == SREInvestigator && e.worker.calls >= agentCallLimit(c) {
			e.worker.finalizing = true
		}
		e.worker.mu.Unlock()
	}
	if c.MemorySchemaVersion == 2 {
		s.mu.Lock()
		before := historyCost(s.state.History)
		filterMemoryHistory(s.state.History, memoryLive)
		if historyCost(s.state.History) != before {
			s.state.ContextMeasurement = nil
			_ = e.save(s)
		}
		s.mu.Unlock()
	}
	if err = e.compactForTurn(ctx, s, c, resume && step == 0); err != nil {
		return modelResult{}, err
	}
	teamContext := e.sreTeamContext(c)
	sreTurnContext := ""
	if c.sreCoordinator {
		sreTurnContext = e.sreCurrentTurnContext(s)
	}
	s.mu.Lock()
	history := append([]Message(nil), s.state.History...)
	if c.MemorySchemaVersion == 2 {
		filterMemoryHistory(history, memoryLive)
	}
	requestHistoryCost := historyCost(history)
	textID, thinkID := uid(), uid()
	d.textID = textID
	textType := "message"
	s.state.View.Cards = append(s.state.View.Cards, Card{ID: thinkID, Type: "thinking", Status: "running", At: timestamp()}, Card{ID: textID, Type: textType, Status: "running", At: timestamp()})
	if s.state.Runtime != nil {
		s.state.Runtime.ModelRounds = d.round
	}
	saveErr := e.save(s)
	s.mu.Unlock()
	if saveErr != nil {
		return modelResult{}, saveErr
	}
	fragments, compositionMatched := d.basePromptFragments(history)
	appendSystem := func(layer strategy.PromptLayer, source, text string) {
		if len(history) > 0 {
			history[0].Content += text
			fragments = appendPromptFragment(fragments, layer, source, text)
		}
	}
	appendSystem(strategy.TaskContext, "team-context", teamContext)
	appendSystem(strategy.TaskContext, "sre-current-turn-facts", sreTurnContext)
	tools := e.sessionCatalog(ctx, id, c)
	if c.sreCoordinator && d.terminalRecovery {
		tools = []Tool{sreReplyTool(), sreCoordinationTool()}
		requestModel = terminalDecisionModel(requestModel)
		appendSystem(strategy.FixedRules, "sre-terminal-recovery", "\nSubmit exactly one terminal function call now: sre_reply with the complete actual answer, or sre_collaborate with the contextual work request. This is the existing one-time decision correction, not a new resource execution or permission. Plain prose cannot finish this coordination turn.")
	}
	if !c.MemoryEnabled {
		for i := range history {
			if history[i].Role == "tool" && memoryTool(history[i].Name) {
				history[i].Content = "[project memory disabled]"
				history[i].Native = nil
			}
		}
	} else if len(history) > 0 {
		memoryBudget := max(0, (c.Model.ContextWindow-c.Model.MaxOutput)*2-historyCost(history)-len(js(tools)))
		attachment := e.requestMemoryContext(ctx, id, c, memoryBudget)
		if historyCost(history)+len(attachment) <= (c.Model.ContextWindow-c.Model.MaxOutput)*2 {
			appendSystem(strategy.TaskContext, "project-memory", attachment)
		}
	}
	lastFlush := map[string]time.Time{}
	if e.worker != nil {
		e.worker.mu.Lock()
		remaining := max(0, agentCallLimit(c)-e.worker.calls)
		if e.worker.finalizing {
			remaining = 0
		}
		e.worker.mu.Unlock()
		if step == c.MaxSteps-1 {
			tools = nil
			remaining = 0
			e.worker.mu.Lock()
			e.worker.finalizing = true
			e.worker.mu.Unlock()
		}
		if fullSREAgent(c) {
			allowance := fmt.Sprintf("\nRuntime allowance: %d model rounds remain under the parent session configuration. Choose tools and continue based on actual results until the deliverable is covered or blocked. Reuse recorded evidence; do not repeat completed changes. Finish an evidence-grounded report before the final round. Missing observations never establish success.", c.MaxSteps-step)
			appendSystem(strategy.FixedRules, "runtime-allowance", allowance)
		} else {
			allowance := fmt.Sprintf("\nRuntime allowance: %d tool calls remain. Reuse already collected evidence. When no tool remains, return a concise final report citing recorded evidence and explicit gaps; do not request another tool or infer unobserved facts. A finished report may describe a blocked deliverable honestly.", remaining)
			appendSystem(strategy.FixedRules, "runtime-allowance", allowance)
		}
	}
	if outputRetried {
		history = outputRecoveryHistory(history)
		fragments = appendPromptFragment(fragments, strategy.FixedRules, "output-recovery", "\n"+outputRecoveryNotice)
	}
	s.mu.Lock()
	if len(s.state.View.Todos) > 0 {
		todoContext := "Current authoritative session tasks (progress only, not permission): " + js(s.state.View.Todos)
		history = append(history, Message{Role: "system", Content: todoContext})
		fragments = appendPromptFragment(fragments, strategy.TaskContext, "todos", todoContext)
	}
	s.mu.Unlock()
	streamDelta := func(kind, delta string) {
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
		if time.Since(lastFlush[kind]) > 16*time.Millisecond {
			// Include the redacted cumulative text: SRE parents cannot take a
			// child Snapshot here because this callback holds the child lock.
			content, at := "", ""
			for i := len(s.state.View.Cards) - 1; i >= 0; i-- {
				if s.state.View.Cards[i].ID == id {
					content = s.state.View.Cards[i].Content
					at = s.state.View.Cards[i].At
					break
				}
			}
			e.notify(s, "delta", map[string]any{"card_id": id, "kind": kind, "content": content, "at": at, "rootTurnId": s.state.View.RootTurnID})
			lastFlush[kind] = time.Now()
		}
	}
	requestCtx := ctx
	cancelRequest := func() {}
	if e.worker != nil && c.sre != nil && c.sre.Role == SREInvestigator {
		e.worker.mu.Lock()
		if !e.worker.finalizing && !e.worker.sreReportAt.IsZero() {
			requestCtx, cancelRequest = context.WithDeadline(ctx, e.worker.sreReportAt)
		}
		e.worker.mu.Unlock()
	}
	result, modelErr := d.streamWithManifest(requestCtx, requestModel, history, tools, fragments, compositionMatched, "", streamDelta)
	cancelRequest()
	if errors.Is(modelErr, context.DeadlineExceeded) && ctx.Err() == nil && e.worker != nil && c.sre != nil && c.sre.Role == SREInvestigator {
		e.worker.mu.Lock()
		reportNow := !e.worker.finalizing && !e.worker.sreReportAt.IsZero()
		if reportNow {
			e.worker.finalizing = true
		}
		e.worker.mu.Unlock()
		if reportNow {
			s.mu.Lock()
			addUsage(&s.state.View.Usage, result.Usage)
			kept := s.state.View.Cards[:0]
			for _, card := range s.state.View.Cards {
				if card.ID != textID && card.ID != thinkID {
					kept = append(kept, card)
				}
			}
			s.state.View.Cards = kept
			s.mu.Unlock()
			return d.next(ctx)
		}
	}
	if errors.Is(modelErr, ErrModelOutputLimit) && !outputRetried && ctx.Err() == nil {
		outputRetried = true
		requestModel = outputRecoveryModel(c.Model)
		s.mu.Lock()
		addUsage(&s.state.View.Usage, result.Usage)
		kept := s.state.View.Cards[:0]
		for _, card := range s.state.View.Cards {
			if card.ID != textID && card.ID != thinkID {
				kept = append(kept, card)
			}
		}
		s.state.View.Cards = kept
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "notice", Content: "模型回复达到单次输出上限，正在缩短回复后重试；已完成的操作保留", Status: "completed", At: timestamp()})
		textID, thinkID = uid(), uid()
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: thinkID, Type: "thinking", Status: "running", At: timestamp()}, Card{ID: textID, Type: "message", Status: "running", At: timestamp()})
		err = e.save(s)
		e.notify(s, "compact", nil)
		s.mu.Unlock()
		if err != nil {
			return modelResult{}, err
		}
		result, modelErr = d.streamWithManifest(ctx, requestModel, outputRecoveryHistory(history), tools, appendPromptFragment(append([]strategy.PromptFragment(nil), fragments...), strategy.FixedRules, "output-recovery", "\n"+outputRecoveryNotice), compositionMatched, d.lastRequestID, streamDelta)
	}
	if errors.Is(modelErr, ErrInvalidModelToolCall) && !d.invalidToolRetried && ctx.Err() == nil {
		// The provider validates the entire batch before returning it to ADK.
		// Regenerate that rejected response once; no tool from it was dispatched.
		d.invalidToolRetried = true
		s.mu.Lock()
		addUsage(&s.state.View.Usage, result.Usage)
		kept := s.state.View.Cards[:0]
		for _, card := range s.state.View.Cards {
			if card.ID != textID && card.ID != thinkID {
				kept = append(kept, card)
			}
		}
		s.state.View.Cards = kept
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: uid(), Type: "notice", Content: "模型返回的工具调用格式无效，正在重新生成；已有调查结果保留", Status: "completed", At: timestamp()})
		textID, thinkID = uid(), uid()
		d.textID = textID
		s.state.View.Cards = append(s.state.View.Cards, Card{ID: thinkID, Type: "thinking", Status: "running", At: timestamp()}, Card{ID: textID, Type: "message", Status: "running", At: timestamp()})
		err = e.save(s)
		e.notify(s, "compact", nil)
		s.mu.Unlock()
		if err != nil {
			return modelResult{}, err
		}
		recoveryHistory := append([]Message(nil), history...)
		if len(recoveryHistory) > 0 && recoveryHistory[0].Role == "system" {
			recoveryHistory[0].Content += "\n" + toolCallRecoveryNotice
		}
		result, modelErr = d.streamWithManifest(ctx, requestModel, recoveryHistory, tools, appendPromptFragment(append([]strategy.PromptFragment(nil), fragments...), strategy.FixedRules, "tool-call-recovery", "\n"+toolCallRecoveryNotice), compositionMatched, d.lastRequestID, streamDelta)
	}
	if modelErr != nil {
		s.mu.Lock()
		addUsage(&s.state.View.Usage, result.Usage)
		s.mu.Unlock()
		return modelResult{}, modelErr
	}
	s.mu.Lock()
	result.Message.Content = redact(result.Message.Content, c)
	result.Message.Reasoning = redact(result.Message.Reasoning, c)
	resolveCallIDs(&result.Message, s.state.History)
	for i := range result.Message.Calls {
		call := &result.Message.Calls[i]
		clean := redact(call.Arguments, c)
		if clean != call.Arguments {
			if d.denied == nil {
				d.denied = map[string]bool{}
			}
			d.denied[call.ID] = true
			call.Arguments = clean
		}
	}
	for i, raw := range result.Message.Native {
		result.Message.Native[i] = safeJSON(raw, c)
	}

	s.state.History = append(s.state.History, result.Message)
	addUsage(&s.state.View.Usage, result.Usage)
	latest := result.Usage
	s.state.LastRequest = &latest
	s.state.LastRequestAt = timestamp()
	s.state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(c.Model), HistoryCost: requestHistoryCost, ToolsCost: len(js(tools))}
	for i := range s.state.View.Cards {
		if s.state.View.Cards[i].ID == textID || s.state.View.Cards[i].ID == thinkID {
			s.state.View.Cards[i].Status = "completed"
		}
	}
	err = e.save(s)
	e.notify(s, "historyMessage", result.Message)
	s.mu.Unlock()
	if err != nil {
		return modelResult{}, err
	}

	return result, nil
}

const toolCallRecoveryNotice = "The previous response was rejected before tool dispatch because a tool call was malformed or duplicated. None of that response's tool calls were executed. Regenerate the response using valid JSON objects matching the tool schemas and distinct call IDs. If awaiting a user decision, use ask_user_question once with the required questions; never assume an answer. Reuse previous successful tool results and do not repeat completed operations. Preserve the current conversation mode, target scope and all permission restrictions."

// streamWithManifest prepares the live request. Historical fingerprint recording
// is host-only opt-in and best effort; ADK/session/operation writes remain mandatory.
func (d *adkTurnDriver) streamWithManifest(ctx context.Context, m Model, history []Message, tools []Tool, fragments []strategy.PromptFragment, matched bool, retryOf string, delta func(string, string)) (modelResult, error) {
	e, s, c := d.engine, d.session, *d.config
	history, fragments, selection, strategyErr := d.strategyRequest(ctx, history, fragments, tools)
	if strategyErr != nil {
		return modelResult{}, strategyErr
	}
	var recallText string
	var recallErr error
	history, recallText, recallErr = e.naturalRecallRequest(ctx, s, c, history, tools)
	if recallErr != nil {
		return modelResult{}, recallErr
	}
	if recallText != "" {
		fragments = appendPromptFragment(fragments, strategy.UserStrategy, "natural-memory-preferences", recallText)
	}
	s.mu.Lock()
	if s.state.Runtime == nil {
		s.mu.Unlock()
		return modelResult{}, errors.New("ADK runtime identity unavailable")
	}
	s.state.Runtime.PromptManifest = nil
	d.lastRequestID = ""
	if !e.RecordPromptDiagnostics {
		s.mu.Unlock()
		return e.stream(ctx, m, history, tools, delta)
	}
	runID, turnID := s.state.Runtime.SessionID, s.state.View.RootTurnID
	skills := []strategy.SkillSnapshot{}
	present := map[string]string{}
	for _, msg := range history {
		if msg.Role == "tool" {
			present[msg.CallID] = strategy.ContentHash(msg.Content)
		}
	}
	for _, skill := range s.state.SkillSnapshots {
		if present[skill.CallID] == skill.ResultHash {
			skills = append(skills, skill)
		}
	}
	s.mu.Unlock()
	modelHash, err := promptModelHash(c, m)
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	toolsHash, err := promptFingerprint(tools)
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	permissionsHash, err := promptFingerprint(c.Permissions)
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	// Explicit allowlist: no Asset objects, connection settings, credentials,
	// directories or terminal contents enter this target fingerprint.
	scopeHash, err := promptFingerprint(struct {
		Runtime, Asset, Container, Terminal string
		References                          []string
		Scope                               *TargetScope
	}{c.Runtime, c.AssetRef, c.Container, c.TerminalID, c.ReferencedAssets, c.targetScope})
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	requestHash, err := promptFingerprint(struct {
		Model   string
		History []Message
		Tools   []Tool
	}{modelHash, history, tools})
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	systems := []string{}
	for _, msg := range history {
		if msg.Role == "system" {
			systems = append(systems, msg.Content)
		}
	}
	systemHash, err := promptFingerprint(systems)
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	commit, dirty := promptBuild()
	profile := c.Profile
	if profile == "" {
		profile = "core"
	}
	if c.workflowMode {
		profile = "workflow"
	}
	if c.sreCoordinator {
		profile = "sre-coordination"
	}
	manifest := strategy.PromptManifest{
		SchemaVersion: strategy.SchemaVersion, RequestID: uid(), RunID: runID, TurnID: turnID, Round: d.round, RetryOf: retryOf,
		BuildCommit: commit, BuildDirty: dirty, Profile: profile, Role: c.agentRole,
		FixedRulesHash: strategy.FragmentLayerHash(fragments, strategy.FixedRules), BuiltinStrategyHash: strategy.FragmentLayerHash(fragments, strategy.BuiltinStrategy), Fragments: fragments,
		SelectedAssets: selection.Selected, OmittedAssets: selection.Omitted, SkillSnapshots: skills, AssetSelectionReasons: selection.Reasons,
		SettingsRevision: selection.SettingsRevision, ProjectSettingsRevision: selection.ProjectSettingsRevision, Epoch: selection.GlobalEpoch, ProjectEpoch: selection.ProjectEpoch,
		ModelConfigHash: modelHash, ToolCatalogHash: toolsHash, PermissionPolicyVersion: promptPermissionPolicyVersion, PermissionSettingsHash: permissionsHash, TargetScopeHash: scopeHash,
		InputBudget: strategy.PromptInputBudget{ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput, MaxSteps: c.MaxSteps, HistoryCost: historyCost(history), ToolsCost: len(js(tools))},
		SystemHash:  systemHash, RequestHash: requestHash, CompositionMatched: matched, PreparedAt: timestamp(),
	}
	raw, err := manifest.CanonicalJSON()
	if err != nil {
		return e.stream(ctx, m, history, tools, delta)
	}
	// Labels and logical IDs are allowlisted, but fail closed if a configured
	// secret coincides with one. Sanitizing after hashing would break integrity.
	if redact(string(raw), c) != string(raw) {
		return e.stream(ctx, m, history, tools, delta)
	}
	name := "prompt-manifest-" + manifest.RequestID + ".json"
	saved, err := (&nativeArtifacts{engine: e, sessionID: runID, config: c}).Save(ctx, &artifact.SaveRequest{AppName: "lake", UserID: "lake", SessionID: runID, FileName: name, Version: 1, Part: &genai.Part{Text: string(raw)}})
	if err != nil {
		if ctx.Err() != nil {
			return modelResult{}, ctx.Err()
		}
		return e.stream(ctx, m, history, tools, delta)
	}
	ref := &strategy.ManifestRef{RequestID: manifest.RequestID, FileName: name, Version: saved.Version, ContentHash: strategy.ContentHash(string(raw))}
	s.mu.Lock()
	s.state.Runtime.PromptManifest = ref
	s.mu.Unlock()
	d.lastRequestID = manifest.RequestID
	return e.stream(ctx, m, history, tools, delta)
}
