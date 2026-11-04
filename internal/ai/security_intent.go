package ai

import "strings"

type GoalIntent string

const (
	IntentContinueGoal GoalIntent = "continue_goal"
	IntentNewGoal      GoalIntent = "new_goal"
	IntentSelectGoal   GoalIntent = "select_goal"
	IntentClarifyGoal  GoalIntent = "clarify"
)

type IntentGoal struct {
	ID, SessionID, Status string
	GoalRevision          int64
}

// GoalInteraction is loaded by the host from the original question, selected
// goal or resume action. The model may suggest a goal, but cannot create this
// binding or turn a summary into an original user message.
type GoalInteraction struct {
	ID, SessionID, GoalID, SourceMessageID string
	GoalRevision                           int64
	State                                  string
}

type GoalIntentInput struct {
	SessionID, SourceMessageID, UserText string
	ExplicitIntent                       GoalIntent
	RequestedGoalID                      string
	ExpectedGoalRevision                 int64
	Goals                                []IntentGoal
	Interaction                          *GoalInteraction
}

type GoalIntentResult struct {
	Intent          GoalIntent
	GoalID          string
	GoalRevision    int64
	SourceMessageID string
	Reason          string
}

// ResolveGoalIntent is deliberately independent of text classifiers: spelling
// "continue" does not authorize a guessed historical goal. Arbitrary follow-up
// content works through the same trusted current interaction binding.
func ResolveGoalIntent(in GoalIntentInput) GoalIntentResult {
	out := GoalIntentResult{Intent: IntentClarifyGoal, SourceMessageID: in.SourceMessageID, Reason: "GOAL_BINDING_REQUIRED"}
	if in.SessionID == "" || in.SourceMessageID == "" || strings.TrimSpace(in.UserText) == "" {
		return out
	}
	goals := map[string]IntentGoal{}
	for _, goal := range in.Goals {
		if goal.ID == "" || goal.SessionID != in.SessionID {
			continue
		}
		if _, duplicate := goals[goal.ID]; duplicate {
			return out
		}
		goals[goal.ID] = goal
	}
	if in.ExplicitIntent == IntentNewGoal {
		if in.RequestedGoalID != "" || in.ExpectedGoalRevision != 0 {
			return out
		}
		out.Intent, out.Reason = IntentNewGoal, "NEW_GOAL_CONFIRMED"
		return out
	}
	if in.ExplicitIntent == IntentContinueGoal || in.ExplicitIntent == IntentSelectGoal {
		goal, ok := goals[in.RequestedGoalID]
		if !ok || goal.GoalRevision < 1 || goal.GoalRevision != in.ExpectedGoalRevision || goal.Status == "completed" || goal.Status == "cancelled" {
			return out
		}
		out.Intent, out.GoalID, out.GoalRevision, out.Reason = in.ExplicitIntent, goal.ID, goal.GoalRevision, "GOAL_ACTION_CONFIRMED"
		return out
	}
	if in.ExplicitIntent != "" {
		return out
	}
	if binding := in.Interaction; binding != nil {
		goal, ok := goals[binding.GoalID]
		if !ok || binding.ID == "" || binding.SessionID != in.SessionID || binding.SourceMessageID != in.SourceMessageID || binding.State != "active" || binding.GoalRevision < 1 || goal.GoalRevision != binding.GoalRevision || goal.Status == "completed" || goal.Status == "cancelled" {
			return out
		}
		out.Intent, out.GoalID, out.GoalRevision, out.Reason = IntentContinueGoal, goal.ID, goal.GoalRevision, "GOAL_INTERACTION_BOUND"
		return out
	}
	if len(goals) == 0 {
		out.Intent, out.Reason = IntentNewGoal, "FIRST_GOAL"
	}
	return out
}
