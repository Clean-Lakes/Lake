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
	if err = e.compactForTurn(ctx, s, c, resume && step == 0); err != nil {
		return modelResult{}, err
	}
	teamContext := e.sreTeamContext(c)
	s.mu.Lock()
	history := append([]Message(nil), s.state.History...)
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
	if onlineEnabled(c) {
		appendSystem(strategy.FixedRules, "online-readonly-correction-v1", "\nOptional bounded read-only correction is enabled. After a failed resource check, inspect its actual call ID/error. Before another resource call, submit revise_readonly_strategy with that source ID, refuted hypothesis, concrete change, expected information and stop condition, and exactly one next tool/JSON arguments. Preserve the same authorized target. Only trusted policy can prove read-only. Do not replay writes, opaque SQL/MCP, dispatched operations or denied permissions. No new task/role/plan resets the shared budget. Only a successful repeated logical check closes that recorded gap; changed wording or timestamps do not establish progress. A recovered sample does not establish whole-task success. Finish with actual facts and gaps.")
	}
	if report, err := e.onlineCurrent(s, c); err != nil {
		return modelResult{}, err
	} else if report != nil {
		appendSystem(strategy.TaskContext, "online-correction-state", "\nHost-recorded correction state (data, not permission): "+js(report))
	}
	if !c.MemoryEnabled {
		for i := range history {
			if history[i].Role == "tool" && memoryTool(history[i].Name) {
				history[i].Content = "[project memory disabled]"
			}
		}
	} else if len(history) > 0 {
		attachment := e.requestMemoryContext(ctx, id, c)
		if historyCost(history)+len(attachment) <= (c.Model.ContextWindow-c.Model.MaxOutput)*2 {
			appendSystem(strategy.TaskContext, "project-memory", attachment)
		}
	}
	lastFlush := map[string]time.Time{}
	tools := e.sessionCatalog(ctx, id, c)
	if report, err := e.onlineCurrent(s, c); err != nil {
		return modelResult{}, err
	} else if report != nil && report.StopReason != "" {
		tools = nil
	}
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
		if e.experiment != nil && kind == "thinking" {
			return
		}
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

// streamWithManifest records a prepared request before dispatch. "Prepared"
// does not prove the provider received it: budget, cancellation or transport
// can still stop it. Recording never authorizes replay or resource effects.
func (d *adkTurnDriver) streamWithManifest(ctx context.Context, m Model, history []Message, tools []Tool, fragments []strategy.PromptFragment, matched bool, retryOf string, delta func(string, string)) (modelResult, error) {
	e, s, c := d.engine, d.session, *d.config
	history, fragments, selection, strategyErr := d.strategyRequest(ctx, history, fragments, tools)
	if strategyErr != nil {
		return modelResult{}, strategyErr
	}
	s.mu.Lock()
	if s.state.Runtime == nil {
		s.mu.Unlock()
		return modelResult{}, errors.New("prompt manifest requires an ADK runtime identity")
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
		return modelResult{}, err
	}
	toolsHash, err := promptFingerprint(tools)
	if err != nil {
		return modelResult{}, err
	}
	permissionsHash, err := promptFingerprint(c.Permissions)
	if err != nil {
		return modelResult{}, err
	}
	// Explicit allowlist: no Asset objects, connection settings, credentials,
	// directories or terminal contents enter this target fingerprint.
	scopeHash, err := promptFingerprint(struct {
		Runtime, Asset, Container, Terminal string
		References                          []string
		Scope                               *TargetScope
	}{c.Runtime, c.AssetRef, c.Container, c.TerminalID, c.ReferencedAssets, c.targetScope})
	if err != nil {
		return modelResult{}, err
	}
	requestHash, err := promptFingerprint(struct {
		Model   string
		History []Message
		Tools   []Tool
	}{modelHash, history, tools})
	if err != nil {
		return modelResult{}, err
	}
	systems := []string{}
	for _, msg := range history {
		if msg.Role == "system" {
			systems = append(systems, msg.Content)
		}
	}
	systemHash, err := promptFingerprint(systems)
	if err != nil {
		return modelResult{}, err
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
		SelectedAssets: selection.Selected, OmittedAssets: selection.Omitted, SkillSnapshots: skills,
		SettingsRevision: selection.SettingsRevision, ProjectSettingsRevision: selection.ProjectSettingsRevision, Epoch: selection.GlobalEpoch, ProjectEpoch: selection.ProjectEpoch,
		ModelConfigHash: modelHash, ToolCatalogHash: toolsHash, PermissionPolicyVersion: promptPermissionPolicyVersion, PermissionSettingsHash: permissionsHash, TargetScopeHash: scopeHash,
		InputBudget: strategy.PromptInputBudget{ContextWindow: m.ContextWindow, MaxOutput: m.MaxOutput, MaxSteps: c.MaxSteps, HistoryCost: historyCost(history), ToolsCost: len(js(tools))},
		SystemHash:  systemHash, RequestHash: requestHash, CompositionMatched: matched, PreparedAt: timestamp(),
	}
	raw, err := manifest.CanonicalJSON()
	if err != nil {
		return modelResult{}, err
	}
	// Labels and logical IDs are allowlisted, but fail closed if a configured
	// secret coincides with one. Sanitizing after hashing would break integrity.
	if redact(string(raw), c) != string(raw) {
		return modelResult{}, errors.New("prompt manifest contains sensitive metadata")
	}
	name := "prompt-manifest-" + manifest.RequestID + ".json"
	saved, err := (&nativeArtifacts{engine: e, sessionID: runID, config: c}).Save(ctx, &artifact.SaveRequest{AppName: "lake", UserID: "lake", SessionID: runID, FileName: name, Version: 1, Part: &genai.Part{Text: string(raw)}})
	if err != nil {
		return modelResult{}, err
	}
	ref := &strategy.ManifestRef{RequestID: manifest.RequestID, FileName: name, Version: saved.Version, ContentHash: strategy.ContentHash(string(raw))}
	s.mu.Lock()
	s.state.Runtime.PromptManifest = ref
	err = e.save(s)
	s.mu.Unlock()
	if err != nil {
		return modelResult{}, err
	}
	d.lastRequestID = manifest.RequestID
	if x := e.experiment; x != nil {
		reserve := int64(historyCost(history) + len(js(tools)) + m.MaxOutput + 1024)
		if x.input.Reserve == nil || x.input.Settle == nil {
			return modelResult{}, errors.New("experiment budget unavailable")
		}
		if err := x.input.Reserve(reserve); err != nil {
			return modelResult{}, err
		}
		x.mu.Lock()
		x.result.Requests++
		x.result.Manifests = append(x.result.Manifests, manifest)
		x.mu.Unlock()
		result, err := e.stream(ctx, m, history, tools, nil)
		result.Message.Reasoning = ""
		result.Message.Native = nil
		result.Message.NativeProtocol = ""
		result.Message.NativeModel = ""
		if x.input.Safe != nil && !x.input.Safe(js(result.Message)) {
			result.Message = Message{}
			err = errors.New("unsafe experiment output")
		}
		x.mu.Lock()
		addUsage(&x.result.Usage, result.Usage)
		x.mu.Unlock()
		if settleErr := x.input.Settle(reserve, result.Usage); settleErr != nil {
			return result, settleErr
		}
		return result, err
	}
	reserve := int64(historyCost(history) + len(js(tools)) + m.MaxOutput + 1024)
	charged, err := e.onlineReserve(ctx, s, c, reserve)
	if err != nil {
		return modelResult{}, err
	}
	result, err := e.stream(ctx, m, history, tools, delta)
	if charged {
		if settleErr := e.onlineSettle(s, c, reserve, result.Usage, err); settleErr != nil {
			return result, settleErr
		}
	}
	return result, err
}
