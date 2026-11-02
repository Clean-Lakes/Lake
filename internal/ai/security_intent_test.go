package ai

import "testing"

func TestGoalIntentRequiresOriginalTrustedAssociation(t *testing.T) {
	base := GoalIntentInput{SessionID: "session", SourceMessageID: "actual-message", UserText: "换成经 Mac 中转，继续原来的数据同步", Goals: []IntentGoal{{ID: "goal1", SessionID: "session", GoalRevision: 3, Status: "blocked"}, {ID: "goal2", SessionID: "session", GoalRevision: 1, Status: "running"}}}
	if got := ResolveGoalIntent(base); got.Intent != IntentClarifyGoal {
		t.Fatal("unbound text guessed historical goal", got)
	}
	base.Interaction = &GoalInteraction{ID: "original-interaction", SessionID: "session", GoalID: "goal1", SourceMessageID: "actual-message", GoalRevision: 3, State: "active"}
	got := ResolveGoalIntent(base)
	if got.Intent != IntentContinueGoal || got.GoalID != "goal1" || got.GoalRevision != 3 {
		t.Fatal("content followup lost original goal", got)
	}
	for _, mutate := range []func(*GoalIntentInput){
		func(in *GoalIntentInput) { in.SourceMessageID = "summary-instead" },
		func(in *GoalIntentInput) { in.Interaction.GoalRevision = 2 },
		func(in *GoalIntentInput) { in.Interaction.State = "closed" },
		func(in *GoalIntentInput) { in.Interaction.SessionID = "other-session" },
	} {
		copy := base
		binding := *base.Interaction
		copy.Interaction = &binding
		mutate(&copy)
		if got := ResolveGoalIntent(copy); got.Intent != IntentClarifyGoal {
			t.Fatal("invalid interaction continued", got)
		}
	}
}

func TestGoalIntentExplicitNewSelectAndNoPhraseGuess(t *testing.T) {
	base := GoalIntentInput{SessionID: "session", SourceMessageID: "message", UserText: "开始吧", Goals: []IntentGoal{{ID: "goal", SessionID: "session", GoalRevision: 2, Status: "paused"}}}
	if got := ResolveGoalIntent(base); got.Intent != IntentClarifyGoal {
		t.Fatal("phrase guessed an unbound old goal", got)
	}
	base.ExplicitIntent, base.RequestedGoalID, base.ExpectedGoalRevision = IntentSelectGoal, "goal", 2
	if got := ResolveGoalIntent(base); got.Intent != IntentSelectGoal || got.GoalID != "goal" {
		t.Fatal(got)
	}
	base.ExpectedGoalRevision = 1
	if got := ResolveGoalIntent(base); got.Intent != IntentClarifyGoal {
		t.Fatal("stale contract selected", got)
	}
	base.ExplicitIntent, base.RequestedGoalID, base.ExpectedGoalRevision = IntentNewGoal, "", 0
	if got := ResolveGoalIntent(base); got.Intent != IntentNewGoal || got.GoalID != "" {
		t.Fatal("new goal reused old identity", got)
	}
	base.ExplicitIntent, base.Goals = "", nil
	if got := ResolveGoalIntent(base); got.Intent != IntentNewGoal {
		t.Fatal("first goal blocked", got)
	}
}
