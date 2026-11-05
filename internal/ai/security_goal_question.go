package ai

import (
	"context"
	"encoding/json"
	"errors"
)

var errSecurityGoalChoicePending = errors.New("security: goal choice pending")

type SecurityGoalQuestion struct {
	Request                    QuestionRequest `json:"request"`
	Input                      TurnInput       `json:"input"`
	Scope                      *TargetScope    `json:"scope,omitempty"`
	ProjectID, SourceMessageID string
	SelectionRevision          int64
	Choices                    map[string]IntentGoal
	NewLabel                   string
}

func (e *Engine) installSecurityGoalQuestionLocked(s *session, c Config, input TurnInput, sourceID string, selectionRevision int64) error {
	if current := s.state.View.Question; current != nil && (s.state.PendingGoalQuestion == nil || s.state.PendingGoalQuestion.Request.ID != current.ID) {
		return errors.New("security: answer the original pending question first")
	}
	goals, err := e.WorkGoals(s.state.View.Session)
	if err != nil {
		return err
	}
	pending := &SecurityGoalQuestion{ProjectID: configSecurityProject(c), SourceMessageID: sourceID, SelectionRevision: selectionRevision, Choices: map[string]IntentGoal{}, Scope: cloneTargetScope(input.TargetScope), NewLabel: "新建目标（保留原任务和风险）"}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(safeJSON(raw, c), &pending.Input); err != nil {
		return err
	}
	pending.Input.Context = "" // Rebuild transient host context; keep the actual user message.
	pending.Input.UserText = redact(input.UserText, c)
	options := []QuestionOption{}
	for _, goal := range goals {
		if len(options) >= 7 {
			break
		}
		if workTerminal(goal.Status) || goal.closure == nil || goal.closure.ProjectID != pending.ProjectID {
			continue
		}
		label := utf8Prefix(goal.Title, 160) + " · " + utf8Prefix(goal.ID, 8)
		if _, duplicate := pending.Choices[label]; duplicate {
			continue
		}
		pending.Choices[label] = IntentGoal{ID: goal.ID, SessionID: goal.SessionID, GoalRevision: goal.closure.GoalRevision, Status: goal.Status}
		options = append(options, QuestionOption{Label: label, Description: "继续此目标，保留原步骤、失败和未决操作；执行权限仍按当前规则校验。"})
	}
	options = append(options, QuestionOption{Label: pending.NewLabel, Description: "开始新的目标，保留旧目标及尚未核实的风险。"})
	pending.Request = QuestionRequest{ID: "security-goal-" + uid(), Questions: []UserQuestion{{ID: "goal", Title: "这次请求要继续哪个目标？", Reason: "选择只确定任务归属，不授予资源或命令权限。旧目标的验收契约未确认时，可先在管理接口确认，原记录继续保留。", Options: options}}}
	s.state.PendingGoalQuestion = pending
	s.state.PendingGoalIntent = &GoalIntentResult{Intent: IntentClarifyGoal, SourceMessageID: sourceID, Reason: "GOAL_BINDING_REQUIRED"}
	s.state.View.Question = &pending.Request
	s.state.View.Status = "waiting_input"
	if err = e.save(s); err != nil {
		return err
	}
	e.notify(s, "question", s.state.View.Question)
	return errSecurityGoalChoicePending
}

// This handles only a host-created goal question. Ordinary ADK questions retain
// the official input workflow. An answer selects a goal; it cannot issue grants.
func (e *Engine) replySecurityGoalQuestion(id, requestID string, answers map[string][]string) (bool, error) {
	s, err := e.get(id)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	pending := s.state.PendingGoalQuestion
	if pending == nil || pending.Request.ID != requestID {
		s.mu.Unlock()
		return false, nil
	}
	if s.cancel != nil {
		s.mu.Unlock()
		return true, errors.New("security: session is busy")
	}
	if noQuestionAnswers(answers) {
		err := e.dismissQuestionLocked(s, &pending.Request, "dismissed")
		s.mu.Unlock()
		return true, err
	}
	if err = validateQuestionAnswers(&pending.Request, answers); err != nil {
		s.mu.Unlock()
		return true, err
	}
	values := answers["goal"]
	if len(values) != 1 {
		s.mu.Unlock()
		return true, errors.New("security: choose exactly one goal")
	}
	choice, known := pending.Choices[values[0]]
	newGoal := values[0] == pending.NewLabel
	if !newGoal && !known {
		s.mu.Unlock()
		return true, errors.New("security: select one of the original goal choices")
	}
	copy := *pending
	s.mu.Unlock()
	a := SecurityGoalSelection{ActorID: "local-user", ActionID: "goal-question:" + requestID, ProjectID: copy.ProjectID, SessionID: id, GoalID: choice.ID, ExpectedGoalRevision: choice.GoalRevision, SourceMessageID: copy.SourceMessageID, ExpectedRevision: copy.SelectionRevision, NewGoal: newGoal}
	if err = e.SelectSecurityGoal(context.Background(), a); err != nil {
		return true, err
	}
	s.mu.Lock()
	s.state.PendingGoalQuestion = nil
	s.state.PendingGoalIntent = nil
	if s.state.View.Question != nil && s.state.View.Question.ID == requestID {
		s.state.View.Question = nil
	}
	s.state.View.Status = "idle"
	err = e.save(s)
	if err == nil {
		e.notify(s, "question", nil)
	}
	s.mu.Unlock()
	if err != nil {
		return true, err
	}
	input := copy.Input
	input.StrategyMessageID = copy.SourceMessageID
	input.TargetScope = cloneTargetScope(copy.Scope)
	input.SecurityGoalID = choice.ID
	input.SecurityGoalRevision = choice.GoalRevision
	input.SecurityIntent = IntentContinueGoal
	if newGoal {
		input.SecurityIntent = IntentNewGoal
	}
	e.runMu.Lock()
	closed := e.runtimeClosed
	e.runMu.Unlock()
	if closed {
		return true, errors.New("security: runtime is closing; original goal and request remain recorded")
	}
	go func() { _ = e.ExecuteTurn(context.Background(), id, input) }()
	return true, nil
}
