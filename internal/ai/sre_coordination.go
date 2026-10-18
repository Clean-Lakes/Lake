package ai

import (
	"context"
	"errors"
	"strings"
)

// SREHandoff is a model-requested orchestration choice, never an operation approval.
// It is consumed only after the parent conversation has released its session lock.
type SREHandoff struct {
	RootTurnID  string       `json:"rootTurnId,omitempty"`
	Action      string       `json:"action"`
	TaskID      string       `json:"task_id,omitempty"`
	Goal        string       `json:"goal,omitempty"`
	ResourceIDs []string     `json:"asset_refs,omitempty"`
	Mode        string       `json:"mode,omitempty"`
	Role        SREAgentRole `json:"role,omitempty"`
}

type sreReply struct {
	RootTurnID string
	Text       string
}

const sreDecisionReminder = "No terminal decision was submitted. Your previous text is not an executed action. Continue this same turn: for actual inspection or specialist work, call sre_collaborate with the resolved goal and target; to give a finished answer or ask a necessary clarification, call sre_reply with the actual response. Do not finish with a promise such as 'I will check'. Do not invent results. You decide which path fits the conversation; no resource operation has been performed by this reminder."

func sreReplyTool() Tool {
	return Tool{Name: "sre_reply", Description: "Finish this conversation turn with an actual answer or a necessary clarification. text is the complete user-facing reply. Use kind=answer for an explanation or answer based on available facts, and clarification for a focused request for missing information. A promise to inspect or work later is not a final answer: use sre_collaborate to actually begin specialist work. This tool performs no resource operation and grants no permission. Choose exactly one terminal decision: sre_reply or sre_collaborate.", Parameters: objectSchema(map[string]any{
		"kind": map[string]any{"type": "string", "enum": []string{"answer", "clarification"}}, "text": stringSchema(),
	}, "kind", "text")}
}

func (e *Engine) prepareSREReply(s *session, c Config, call Call) (any, error) {
	if !c.sreCoordinator || e.worker != nil {
		return nil, errors.New("conversation replies belong to the parent conversation")
	}
	var input struct {
		Kind string `json:"kind"`
		Text string `json:"text"`
	}
	if err := decodeSREJSON(call.Arguments, &input); err != nil {
		return nil, err
	}
	if (input.Kind != "answer" && input.Kind != "clarification") || strings.TrimSpace(input.Text) == "" || len(input.Text) > 128<<10 {
		return nil, errors.New("sre_reply requires an answer or clarification with nonempty text of at most 128 KiB")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sreReply != nil || s.state.SREHandoff != nil {
		return nil, errors.New("a terminal conversation decision is already prepared")
	}
	s.sreReply = &sreReply{RootTurnID: s.state.View.RootTurnID, Text: redact(input.Text, c)}
	return map[string]any{"status": "reply_prepared", "kind": input.Kind}, nil
}

// Finalize only after the whole tool batch has matching results in history.
// The model's formal reply replaces this request's provisional streamed text.
func (e *Engine) finishSREReply(s *session, textID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.sreReply
	if r == nil || r.RootTurnID != s.state.View.RootTurnID {
		return false, nil
	}
	for i := range s.state.View.Cards {
		if s.state.View.Cards[i].ID == textID {
			s.state.View.Cards[i].Content = r.Text
		}
	}
	// A formal answer replaces this turn's provisional conversational promises,
	// including a handoff that was rejected before anything started. Preserve
	// tool/decision history and all earlier turns for audit and model context.
	kept := s.state.View.Cards[:0]
	for _, card := range s.state.View.Cards {
		if card.Type == "message" && card.ID != textID && card.At >= s.state.View.TurnStartedAt {
			continue
		}
		kept = append(kept, card)
	}
	s.state.View.Cards = kept
	s.state.History = append(s.state.History, Message{Role: "assistant", Content: r.Text})
	s.sreReply = nil
	err := e.save(s)
	e.notify(s, "historyMessage", Message{Role: "assistant", Content: r.Text})
	return true, err
}

func sreCoordinationTool() Tool {
	return Tool{Name: "sre_collaborate", Description: "Choose an SRE collaboration handoff using the conversation and recorded task context. Use only when specialist work, a Plan, a task change, or a specialist answer is actually needed. Plain conversation and clarifications are normal replies, not tool calls. Resolve targets from context and resource discovery; @ selection is not mandatory unless current permissions require it. new_task needs a concrete goal and 1..8 known asset_refs and no unfinished task. If the user explicitly asks to start over, restart_task atomically ends a paused read-only investigation and creates a fresh one with its exact goal and scope, retaining all prior evidence; it never bypasses an unresolved operation or restarts a change task. continue_task resumes the current plan; eligible legacy read-only investigations first get a model-planned collaboration revision with completed evidence retained; revise_plan supplies the user's contextual clarification as goal. ask_role asks a named specialist about recorded facts. mode=plan_only saves a draft without running steps. This call grants no execution permission. Call once; the runtime hands off after this reply, so do not claim a result before recorded execution.", Parameters: objectSchema(map[string]any{
		"action":  map[string]any{"type": "string", "enum": []string{"new_task", "restart_task", "continue_task", "revise_plan", "ask_role", "pause_task", "cancel_task"}},
		"task_id": stringSchema(), "goal": stringSchema(), "asset_refs": arraySchema(stringSchema()),
		"mode": map[string]any{"type": "string", "enum": []string{"assist", "plan_only"}},
		"role": map[string]any{"type": "string", "enum": []string{"coordinator", "investigator", "executor", "verifier"}},
	}, "action")}
}

func (e *Engine) sreCoordinationCatalog(c Config) []Tool {
	allowed := map[string]bool{"list_assets": true, "list_resource_groups": true, "ask_user_question": true, "read_session_context": true, "load_skill": true, "preview_resource_import": true, "import_resources": true}
	out := []Tool{sreCoordinationTool(), sreReplyTool()}
	for _, tool := range Catalog("core") {
		if allowed[tool.Name] {
			out = append(out, tool)
		}
	}
	if c.MemoryEnabled && e.Bridge != nil {
		for _, tool := range projectMemoryTools() {
			if tool.Name == "project_memory_index" || tool.Name == "list_project_memories" || tool.Name == "read_project_memory" {
				out = append(out, tool)
			}
		}
	}
	return out
}

func (e *Engine) validateSREHandoff(sessionID string, c Config, h SREHandoff) (SREHandoff, error) {
	if e.sreRepository == nil {
		return h, errors.New("SRE task repository unavailable")
	}
	if len(h.Goal) > 4000 {
		return h, errors.New("collaboration goal exceeds 4000 bytes")
	}
	if h.Mode == "" {
		h.Mode = "assist"
	}
	if h.Mode != "assist" && h.Mode != "plan_only" {
		return h, errors.New("unsupported collaboration mode")
	}
	switch h.Action {
	case "new_task":
		existing, err := e.sreRepository.ListSRETasks(sessionID, 50, "")
		if err != nil {
			return h, err
		}
		for _, task := range existing {
			if SRETaskActive(task.Status) {
				return h, errors.New("当前会话仍有未结束任务，本轮没有新建任务。请根据上下文选择 continue_task，用户明确要求重新开始只读调查时选择 restart_task，或明确要求结束旧任务时选择 cancel_task；不要承诺已重新开始，也不要通过新任务绕过待核实操作。无法继续时用 sre_reply 说明实际阻塞。")
			}
		}
		if strings.TrimSpace(h.Goal) == "" || len(h.ResourceIDs) < 1 || len(h.ResourceIDs) > 8 {
			return h, errors.New("new_task requires a contextual goal and 1..8 resolved assets; clarify missing information before requesting a handoff")
		}
		if h.TaskID != "" {
			return h, errors.New("new_task cannot replace an existing task")
		}
		seen := map[string]bool{}
		for i, ref := range h.ResourceIDs {
			as, err := asset(c, ref)
			if err != nil {
				return h, err
			}
			if seen[as.ID] {
				return h, errors.New("duplicate collaboration asset")
			}
			seen[as.ID] = true
			if !assetVisible(c, as.ID) {
				return h, errors.New("current permissions require an authorized resource reference for this target")
			}
			if c.Permissions != nil && c.Permissions.DenyLocalExecution && as.Kind == "local" {
				return h, errors.New("current permissions prohibit local execution")
			}
			if c.targetScope != nil {
				allowed := false
				for _, id := range c.targetScope.ResourceIDs {
					allowed = allowed || as.ID == id
				}
				if c.targetScope.NeedsClarification || !allowed {
					return h, errors.New("collaboration target is outside the resolved scope or still needs clarification")
				}
			}
			h.ResourceIDs[i] = as.ID
		}
	case "restart_task", "continue_task", "revise_plan", "ask_role", "pause_task", "cancel_task":
		if h.TaskID == "" {
			return h, errors.New("existing task handoff requires task_id")
		}
		task, err := e.sreRepository.LoadSRETask(sessionID, h.TaskID)
		if err != nil {
			return h, err
		}
		if h.Action != "ask_role" && !SRETaskActive(task.Status) {
			return h, errors.New("task already ended")
		}
		if h.Action == "restart_task" {
			if task.Status != "paused" && task.Status != "waiting_input" && task.Status != "draft" {
				return h, errors.New("只能重新开始已暂停的只读调查")
			}
			if plan := task.LatestPlan(); plan != nil {
				if plan.TaskType != "investigation" && plan.TaskType != "query" {
					return h, errors.New("变更任务不能自动重新开始")
				}
				for _, step := range plan.Steps {
					if step.Kind == "act" {
						return h, errors.New("含变更步骤的任务不能自动重新开始")
					}
				}
			}
			if h.Goal != "" {
				return h, errors.New("restart_task retains the original goal and exact scope")
			}
		}
		if h.Action == "continue_task" || h.Action == "revise_plan" || h.Action == "restart_task" {
			for _, a := range task.Attempts {
				for _, op := range a.Operations {
					if SREOperationBlocksResume(op) {
						return h, sreOperationBlockError(op)
					}
				}
			}
		}
		if h.Action == "ask_role" && (!ValidSRERole(h.Role) || strings.TrimSpace(h.Goal) == "") {
			return h, errors.New("ask_role requires role and a contextual question")
		}
		if h.Action == "revise_plan" && strings.TrimSpace(h.Goal) == "" {
			return h, errors.New("revise_plan requires the contextual plan change")
		}
		if len(h.ResourceIDs) > 0 {
			return h, errors.New("an existing task retains its recorded resource scope")
		}
	default:
		return h, errors.New("unknown collaboration handoff")
	}
	return h, nil
}

func (e *Engine) prepareSREHandoff(s *session, c Config, call Call) (any, error) {
	if !c.sreCoordinator || e.worker != nil {
		return nil, errors.New("collaboration decisions belong to the parent conversation")
	}
	var h SREHandoff
	if err := decodeSREJSON(call.Arguments, &h); err != nil {
		return nil, err
	}
	s.mu.Lock()
	id := s.state.View.Session
	c.ReferencedAssets = validRemembered(c, s.state.ReferencedAssetIDs)
	s.mu.Unlock()
	h, err := e.validateSREHandoff(id, c, h)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.SREHandoff != nil {
		return nil, errors.New("a collaboration handoff is already prepared for this turn")
	}
	h.RootTurnID = s.state.View.RootTurnID
	s.state.SREHandoff = &h
	if err = e.save(s); err != nil {
		s.state.SREHandoff = nil
		return nil, err
	}
	return map[string]any{"status": "handoff_prepared", "action": h.Action, "next": "runtime will begin the requested handoff after this parent reply; no resource operation has been executed or approved"}, nil
}

func (e *Engine) TakeSREHandoff(sessionID string) (*SREHandoff, error) {
	s, err := e.get(sessionID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		return nil, errors.New("parent conversation is still running")
	}
	h := s.state.SREHandoff
	if h == nil || h.RootTurnID != s.state.View.RootTurnID || s.state.View.Status != "completed" {
		return nil, nil
	}
	s.state.SREHandoff = nil
	if err = e.save(s); err != nil {
		return nil, err
	}
	copy := *h
	copy.ResourceIDs = append([]string(nil), h.ResourceIDs...)
	return &copy, nil
}

func (e *Engine) ValidateSREHandoff(sessionID string, h SREHandoff) (SREHandoff, error) {
	s, err := e.get(sessionID)
	if err != nil {
		return h, err
	}
	s.mu.Lock()
	c := s.state.Config
	c.ReferencedAssets = validRemembered(c, s.state.ReferencedAssetIDs)
	c.targetScope = cloneTargetScope(s.state.TargetScope)
	s.mu.Unlock()
	return e.validateSREHandoff(sessionID, c, h)
}

func (e *Engine) sreHandoffPrepared(s *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.SREHandoff != nil && s.state.SREHandoff.RootTurnID == s.state.View.RootTurnID
}

// An earlier handoff consumes the batch; remaining calls get explicit tool
// results so provider history stays complete without dispatching extra work.
func (e *Engine) invokeAfterSREHandoff(ctx context.Context, s *session, c Config, call Call) (any, error) {
	s.mu.Lock()
	replyPrepared := s.sreReply != nil && s.sreReply.RootTurnID == s.state.View.RootTurnID
	s.mu.Unlock()
	if replyPrepared || e.sreHandoffPrepared(s) {
		return nil, errors.New("terminal conversation decision prepared; this remaining call was not executed")
	}
	return e.invoke(ctx, s, c, call)
}
