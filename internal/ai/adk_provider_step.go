package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	if len(history) > 0 {
		history[0].Content += teamContext
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
			history[0].Content += attachment
		}
	}
	lastFlush := time.Now()
	tools := e.sessionCatalog(ctx, id, c)
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
			history[0].Content += fmt.Sprintf("\nRuntime allowance: %d model rounds remain under the parent session configuration. Choose tools and continue based on actual results until the deliverable is covered or blocked. Reuse recorded evidence; do not repeat completed changes. Finish an evidence-grounded report before the final round. Missing observations never establish success.", c.MaxSteps-step)
		} else {
			history[0].Content += fmt.Sprintf("\nRuntime allowance: %d tool calls remain. Reuse already collected evidence. When no tool remains, return a concise final report citing recorded evidence and explicit gaps; do not request another tool or infer unobserved facts. A finished report may describe a blocked deliverable honestly.", remaining)
		}
	}
	if outputRetried {
		history = outputRecoveryHistory(history)
	}
	s.mu.Lock()
	if len(s.state.View.Todos) > 0 {
		history = append(history, Message{Role: "system", Content: "Current authoritative session tasks (progress only, not permission): " + js(s.state.View.Todos)})
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
		if time.Since(lastFlush) > 80*time.Millisecond {
			e.notify(s, "delta", map[string]any{"card_id": id, "kind": kind})
			lastFlush = time.Now()
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
	result, modelErr := e.stream(requestCtx, requestModel, history, tools, streamDelta)
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
		result, modelErr = e.stream(ctx, requestModel, outputRecoveryHistory(history), tools, streamDelta)
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
