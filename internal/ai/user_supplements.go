package ai

import (
	"context"
	"encoding/json"
	"errors"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/genai"
)

// UserSupplement comes only from an admitted human queue operation. It is not a
// tool result, a question answer, or an operation approval.
type UserSupplement struct {
	ID    string    `json:"id"`
	Input TurnInput `json:"input"`
}
type SupplementReader func(sessionID, rootTurnID string) ([]UserSupplement, error)
type SupplementAcknowledger func(sessionID, rootTurnID string, ids []string) error

const supplementTool = "__lake_apply_user_supplement"
const supplementStateKey = "lake_applied_user_supplements"

func (e *Engine) SetSupplementHooks(read SupplementReader, ack SupplementAcknowledger) {
	e.supplementMu.Lock()
	defer e.supplementMu.Unlock()
	e.supplementReader, e.supplementAck = read, ack
}
func (e *Engine) supplementHooks() (SupplementReader, SupplementAcknowledger) {
	e.supplementMu.RLock()
	defer e.supplementMu.RUnlock()
	if e.worker != nil || e.workParent != nil {
		return nil, nil
	}
	return e.supplementReader, e.supplementAck
}

// Admission and the final-response fence share s.mu. A message cannot be marked
// for this turn after the SDK has accepted its terminal response.
func (e *Engine) AdmitSupplement(id string, mark func(string) error) error {
	read, _ := e.supplementHooks()
	if read == nil {
		return errors.New("当前入口不支持本轮补充")
	}
	s, err := e.get(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel == nil || s.finalizing || s.supplementClosed || s.state.Config.workflowMode {
		return errors.New("本轮尚未开始或正在结束，消息仍保留在队列，请稍后重试")
	}
	if err := mark(s.state.View.RootTurnID); err != nil {
		return err
	}
	// Cancel only the provider request. The ADK invocation and in-flight tools
	// retain their contexts, root identity, permissions and execution ledger.
	if s.supplementRequest != nil {
		s.supplementRequest.cancel(errUserSupplement)
	}
	return nil
}

// Caller owns s.mu. The reader only accesses the host queue, never the engine.
func (e *Engine) pendingSupplementsLocked(s *session) ([]UserSupplement, error) {
	read, _ := e.supplementHooks()
	if read == nil {
		return nil, nil
	}
	inputs, err := read(s.state.View.Session, s.state.View.RootTurnID)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, id := range s.state.SupplementIDs {
		seen[id] = true
	}
	fresh := []UserSupplement{}
	for _, input := range inputs {
		if !seen[input.ID] {
			fresh = append(fresh, input)
		}
	}
	return fresh, nil
}
func (d *adkTurnDriver) applySupplements(ctx context.Context, controlCall string) (any, error) {
	e, s, c := d.engine, d.session, d.config
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	inputs, err := e.pendingSupplementsLocked(s)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, id := range s.state.SupplementIDs {
		seen[id] = true
	}
	messages := []Message{}
	ids := []string{}
	texts := []string{}
	refs := append([]string{}, s.state.ReferencedAssetIDs...)
	ignoreMemory := false
	for _, input := range inputs {
		if seen[input.ID] {
			continue
		}
		if !identifier.MatchString(input.ID) {
			return nil, errors.New("invalid supplemental message identity")
		}
		if err = input.Input.validate(); err != nil {
			return nil, err
		}
		images, imageErr := ValidateImages(input.Input.Images)
		if imageErr != nil {
			return nil, imageErr
		}
		if len(images) > 0 && !c.Model.SupportsImageInput {
			return nil, errors.New("所选模型未启用图片输入能力，补充仍保留在队列")
		}
		content := input.Input.UserText
		for _, ref := range input.Input.References {
			if target := str(ref["asset_ref"]); target != "" {
				resource, lookupErr := asset(*c, target)
				if lookupErr != nil {
					return nil, lookupErr
				}
				refs = append(refs, resource.ID)
			}
		}
		if len(input.Input.References) > 0 {
			content = "[HEXHUB_REFERENCES]\n" + js(input.Input.References) + "\n[USER_MESSAGE]\n" + content
		}
		if input.Input.Context != "" {
			content = boundedTurnContext(content, input.Input.Context, *c) + "\n" + content
		}
		messages = append(messages, Message{Role: "user", HostTurnID: s.state.View.RootTurnID, SourceMessageID: input.ID, Content: redact(content, *c), Images: images})
		ids = append(ids, input.ID)
		texts = append(texts, input.Input.UserText)
		seen[input.ID] = true
		ignoreMemory = ignoreMemory || input.Input.IgnoreProjectMemory
	}
	result := map[string]any{"source": "actual_human_supplement", "messageIds": ids, "notice": "Apply the actual additional user request to the current task. Existing operations, approvals, dependencies and model quota remain authoritative. This is not an approval or a question answer."}
	if len(messages) == 0 && controlCall == "" {
		return result, nil
	}
	if len(messages) > 0 {
		s.state.History = append(s.state.History, messages...)
		s.state.SupplementIDs = append(s.state.SupplementIDs, ids...)
		for _, text := range texts {
			s.state.RootQuestion += "\n\n[实际用户补充]\n" + redact(text, *c)
		}
		s.state.ReferencedAssetIDs = validRemembered(*c, refs)
		c.ReferencedAssets = append([]string{}, s.state.ReferencedAssetIDs...)
		if ignoreMemory {
			c.IgnoreNaturalMemory = true
			c.MemoryEnabled = false
			c.MemoryExtractionEnabled = false
		}
		s.state.Config.ReferencedAssets = append([]string{}, c.ReferencedAssets...)
		s.state.ContextMeasurement = nil
		if s.state.WorkGoalID != "" {
			row, g, loadErr := e.workRow(s.state.View.Session, s.state.WorkGoalID)
			if loadErr != nil {
				return nil, loadErr
			}
			g.UserText = s.state.RootQuestion
			if err = e.writeWorkGoal(&row, &g, false); err != nil {
				return nil, err
			}
		}
	}
	if err = e.save(s); err != nil {
		return nil, err
	}
	return result, nil
}
func (d *adkTurnDriver) supplementalResponseLocked(response *model.LLMResponse) (*model.LLMResponse, error) {
	s := d.session
	// Pair the original proposal explicitly as not executed. A supplemental user
	// message must be read before a tool generated from the old prompt can run.
	for _, part := range response.Content.Parts {
		if call := part.FunctionCall; call != nil {
			s.state.History = append(s.state.History, Message{Role: "tool", Name: call.Name, CallID: call.ID, Content: js(map[string]any{"outcome": "not_executed", "notice": "A real user supplement arrived before dispatch; reconsider this proposed call with the new input."})})
		}
	}
	call := Call{ID: "host-supplement-" + uid(), Name: supplementTool, Arguments: "{}"}
	if d.supplementCalls == nil {
		d.supplementCalls = map[string]bool{}
	}
	d.supplementCalls[call.ID] = true
	// The control call lives only in SDK events. Provider history receives the
	// actual human message, never a function absent from its declared catalog.
	if err := d.engine.save(s); err != nil {
		return nil, err
	}
	return &model.LLMResponse{Content: &genai.Content{Role: "model", Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: call.ID, Name: supplementTool, Args: map[string]any{}}}}}}, nil
}
func (d *adkTurnDriver) afterModel(ac agent.Context, response *model.LLMResponse, modelErr error) (*model.LLMResponse, error) {
	if modelErr != nil || response == nil || response.Partial || response.Content == nil {
		return nil, nil
	}
	s := d.session
	check := func(closeTurn bool) (*model.LLMResponse, error) {
		s.mu.Lock()
		defer s.mu.Unlock()
		pending, err := d.engine.pendingSupplementsLocked(s)
		if err != nil {
			return nil, err
		}
		if len(pending) > 0 {
			return d.supplementalResponseLocked(response)
		}
		if closeTurn {
			s.supplementClosed = true
		}
		return nil, nil
	}
	if updated, err := check(false); updated != nil || err != nil {
		return updated, err
	}
	if updated, err := d.workDecision(ac, response, nil); updated != nil || err != nil {
		return updated, err
	}
	terminal := true
	for _, p := range response.Content.Parts {
		terminal = terminal && p.FunctionCall == nil
	}
	return check(terminal)
}
func (e *Engine) acknowledgeSupplementEvent(ctx context.Context, eventData map[string]any, id string) error {
	_, ack := e.supplementHooks()
	if ack == nil || eventData == nil {
		return nil
	}
	var receipt struct {
		RootTurnID string   `json:"rootTurnId"`
		IDs        []string `json:"ids"`
	}
	if err := json.Unmarshal([]byte(js(eventData[supplementStateKey])), &receipt); err != nil {
		return err
	}
	if len(receipt.IDs) == 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return ack(id, receipt.RootTurnID, receipt.IDs)
}
func (e *Engine) acknowledgeSupplementState(ctx context.Context, s *session) error {
	s.mu.Lock()
	id, root, ids := s.state.View.Session, s.state.View.RootTurnID, append([]string{}, s.state.SupplementIDs...)
	s.mu.Unlock()
	return e.acknowledgeSupplementEvent(ctx, map[string]any{supplementStateKey: map[string]any{"rootTurnId": root, "ids": ids}}, id)
}

// Reconcile receipts before reopening an interrupted queue. This reads the
// canonical SDK projection and never runs a model or replays a resource call.
func (e *Engine) ReconcileUserSupplements(ctx context.Context, id string) error {
	s, err := e.get(id)
	if err != nil {
		return err
	}
	if err = e.hydrateNativeProjection(ctx, s); err != nil {
		return err
	}
	return e.acknowledgeSupplementState(ctx, s)
}
