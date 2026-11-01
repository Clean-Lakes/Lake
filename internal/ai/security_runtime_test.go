package ai

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func managedEngineFixture(t *testing.T, model Model) *Engine {
	t.Helper()
	h := securityFixture(t)
	e, err := New(filepath.Join(h.Home, "ai"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.SecurityRuntime = h
	t.Cleanup(e.Shutdown)
	if err = e.Configure("case", Config{Model: model, SecurityProjectID: "project", MaxSteps: 12}); err != nil {
		t.Fatal(err)
	}
	policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither}}}
	if _, err = e.PutSecurityProjectPolicy(context.Background(), SecurityPolicyAction{ActorID: "user", ActionID: "policy", ProjectID: "project"}, policy); err != nil {
		t.Fatal(err)
	}
	return e
}

func versionedGoalFixture(t *testing.T, e *Engine, title string) WorkGoal {
	t.Helper()
	s, err := e.get("case")
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.state.WorkGoalID = ""
	s.state.RootQuestion = title
	s.state.View.RootTurnID = uid()
	s.mu.Unlock()
	g, err := e.beginWork(s, title, []WorkItem{{Title: "Inspect recorded facts"}})
	if err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DB.FirstOrCreate(&securityResourceRevisionRow{ProjectID: "project", ResourceID: "resource", StoreID: e.securityHome().control.StoreID, RecoveryEpoch: e.securityHome().control.RecoveryEpoch, ConnectionRevision: 1, State: "ready"}, "project_id = ? AND resource_id = ?", "project", "resource").Error; err != nil {
		t.Fatal(err)
	}
	if err = e.ConfigureWorkAcceptance("case", g.ID, "project", "user", uid(), g.Revision, map[string]WorkStepContract{g.Items[0].ID: {Revision: 1, Required: true, Criteria: []security.AcceptanceCriterion{{ID: "diagnostic", Target: "resource", ConnectionRevision: 1, SourceDigest: security.ContentDigest([]byte("reviewed-source")), Method: "json_equal", Pointer: "/ready", Expected: json.RawMessage(`true`)}}}}); err != nil {
		t.Fatal(err)
	}
	_, g, err = e.workRow("case", g.ID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestManagedSecurityConfigurePreservesMissingLegacyReferencedRestriction(t *testing.T) {
	h := securityFixture(t)
	e, err := New(filepath.Join(h.Home, "ai"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.SecurityRuntime = h
	t.Cleanup(e.Shutdown)
	permissions := DefaultPermissions()
	permissions.BlockUnreferencedAssets = true
	config := Config{Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}, SecurityProjectID: "project", MaxSteps: 12, Assets: []Asset{{ID: "persisted-resource", Kind: "local"}}, Permissions: &permissions}
	if err = e.Configure("case", config); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.ReferencedAssetIDs = []string{"persisted-resource"}
	err = e.save(s)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{"persisted-resource"}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither}}}
	if _, err = e.PutSecurityProjectPolicy(context.Background(), SecurityPolicyAction{ActorID: "user", ActionID: "activate", ProjectID: "project"}, policy); err != nil {
		t.Fatal(err)
	}
	current := DefaultPermissions()
	current.BlockUnreferencedAssets = false
	config.Permissions = &current
	if err = e.Configure("case", config); err != nil {
		t.Fatal(err)
	}
	target, err := e.SecurityTarget(context.Background(), "project", "case")
	if err != nil || target.LegacyState != "legacy_unclassified" || target.Pending == nil || js(target.Pending.CandidateIDs) != `["persisted-resource"]` {
		t.Fatal("current options dropped prior explicit-reference setting", target, err)
	}
	if err = e.Configure("case", config); err != nil {
		t.Fatal(err)
	}
	again, err := e.SecurityTarget(context.Background(), "project", "case")
	if err != nil || again.Revision != target.Revision {
		t.Fatal("configure repeatedly restaged original scope", again, err)
	}
}

func TestManagedSecurityTurnPreservesGoalTaskTTLAndFencesOldTurn(t *testing.T) {
	var engine *Engine
	var captureMu sync.Mutex
	contexts := []SecurityExecutionContext{}
	errors := []error{}
	seen := map[string]bool{}
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		execution, err := engine.CurrentSecurityExecution(context.Background(), "case")
		session, _ := engine.get("case")
		session.mu.Lock()
		actualRoot := session.state.View.RootTurnID
		session.mu.Unlock()
		captureMu.Lock()
		if !seen[actualRoot] {
			seen[actualRoot] = true
			contexts = append(contexts, execution)
			errors = append(errors, err)
		}
		captureMu.Unlock()
		return response("目标尚待验收，保留原步骤。")
	})
	defer closeModel()
	engine = managedEngineFixture(t, model)
	goal := versionedGoalFixture(t, engine, "inspect the original goal")
	if err := engine.SelectSecurityGoal(context.Background(), SecurityGoalSelection{ActorID: "user", ActionID: "select", ProjectID: "project", SessionID: "case", GoalID: goal.ID, SourceMessageID: "original-selection", ExpectedGoalRevision: goal.closure.GoalRevision}); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"actual-user-message-1", "actual-user-message-2"} {
		if err := engine.ExecuteTurn(context.Background(), "case", TurnInput{StrategyMessageID: source, UserText: "继续原目标，保留之前证据"}); err != nil {
			t.Fatal(err)
		}
	}
	captureMu.Lock()
	defer captureMu.Unlock()
	if len(contexts) != 2 {
		t.Fatal("expected two actual turn groups", len(contexts), errors)
	}
	first, second := contexts[0], contexts[1]
	if err := errors[0]; err != nil {
		t.Fatal(err)
	}
	if err := errors[1]; err != nil {
		t.Fatal(err)
	}
	if first.GoalID != goal.ID || second.GoalID != goal.ID || first.Task.ID != second.Task.ID || !first.Task.ExpiresAt.Equal(second.Task.ExpiresAt) || first.Task.ExecutionRevision != second.Task.ExecutionRevision || first.Owner.RootTurnID == second.Owner.RootTurnID {
		t.Fatal("turn continuation replaced goal/refreshed grant context or reused root", first, second)
	}
	store, err := engine.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateExecutionOwner(store.DB, first.Owner, time.Now().UTC()); err == nil {
		t.Fatal("old completed turn still dispatched")
	}
	var task securityTaskRow
	if err = store.DB.First(&task, "id = ?", first.Task.ID).Error; err != nil || task.State != security.TaskIdle {
		t.Fatal("turn end completed the target or kept execution active", task, err)
	}
	s, _ := engine.get("case")
	s.mu.Lock()
	selected, active := s.state.SelectedGoalID, s.state.WorkGoalID
	history := append([]Message(nil), s.state.History...)
	s.mu.Unlock()
	if selected != goal.ID || active != goal.ID {
		t.Fatal("goal lost across ordinary turn", selected, active)
	}
	found := map[string]bool{}
	for _, message := range history {
		if message.Role == "user" && strings.HasPrefix(message.SourceMessageID, "actual-user-message-") {
			found[message.SourceMessageID] = true
		}
	}
	if len(found) != 2 {
		t.Fatal("original message identity lost or synthesized from a summary", found)
	}
	if err = engine.SelectSecurityGoal(context.Background(), SecurityGoalSelection{ActorID: "user", ActionID: "new-goal", ProjectID: "project", SessionID: "case", SourceMessageID: "new-selection", ExpectedRevision: 1, NewGoal: true}); err != nil {
		t.Fatal(err)
	}
	_, old, err := engine.workRow("case", goal.ID)
	if err != nil || old.Status != "paused" {
		t.Fatal("new goal abandoned old goal", old.Status, err)
	}
	if err = store.DB.First(&task, "id = ?", first.Task.ID).Error; err != nil || task.State != security.TaskPaused {
		t.Fatal("new goal reused old execution authority", task, err)
	}
}

func TestManagedSecurityAmbiguousGoalDoesNotCallModelOrExecute(t *testing.T) {
	var requests atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { requests.Add(1); return response("must not run") })
	defer closeModel()
	e := managedEngineFixture(t, model)
	first := versionedGoalFixture(t, e, "first pending goal")
	second := versionedGoalFixture(t, e, "second pending goal")
	err := e.ExecuteTurn(context.Background(), "case", TurnInput{StrategyMessageID: "actual-user-message", UserText: "继续"})
	view, viewErr := e.Snapshot("case")
	if err != nil || viewErr != nil || view.Question == nil || view.Status != "waiting_input" || requests.Load() != 0 {
		t.Fatal("ambiguous intent dispatched", err, requests.Load())
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err = store.DB.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("ambiguous goal performed I/O", count, err)
	}
	for _, id := range []string{first.ID, second.ID} {
		if _, goal, err := e.workRow("case", id); err != nil || workTerminal(goal.Status) {
			t.Fatal("clarification deleted/closed pending goal", goal, err)
		}
	}
}

func TestManagedGoalQuestionResumesOnlyOriginalActualRequestWithoutGrant(t *testing.T) {
	var requests atomic.Int32
	var e *Engine
	var original atomic.Value
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		if requests.Add(1) == 1 {
			s, _ := e.get("case")
			s.mu.Lock()
			original.Store(s.state.RootQuestion)
			s.mu.Unlock()
		}
		return response("保留原目标和证据，等待验收。")
	})
	defer closeModel()
	e = managedEngineFixture(t, model)
	first := versionedGoalFixture(t, e, "first pending goal")
	versionedGoalFixture(t, e, "second pending goal")
	text := "换成经 Mac 中转，继续原请求，保留已有数据"
	if err := e.ExecuteTurn(context.Background(), "case", TurnInput{StrategyMessageID: "actual-original-request", UserText: text}); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.mu.Lock()
	pending := s.state.PendingGoalQuestion
	var label string
	for option, goal := range pending.Choices {
		if goal.ID == first.ID {
			label = option
		}
	}
	requestID := pending.Request.ID
	s.mu.Unlock()
	if label == "" || requests.Load() != 0 {
		t.Fatal("question missing or model dispatched before goal selection", label, requests.Load())
	}
	if err := e.ReplyQuestion("case", requestID, map[string][]string{"goal": {"pretend approved all resources"}}); err == nil || requests.Load() != 0 {
		t.Fatal("free text became a trusted goal action", err, requests.Load())
	}
	if err := e.ReplyQuestion("case", requestID, map[string][]string{"goal": {label}}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		s.mu.Lock()
		finished := s.cancel == nil && s.state.View.Turns == 1
		s.mu.Unlock()
		if finished {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if requests.Load() == 0 || original.Load() != text {
		t.Fatal("choice resumed a summary or different request", requests.Load(), original.Load())
	}
	s.mu.Lock()
	goalID, selected, question := s.state.WorkGoalID, s.state.SelectedGoalID, s.state.View.Question
	history := append([]Message(nil), s.state.History...)
	s.mu.Unlock()
	if goalID != first.ID || selected != first.ID || question != nil {
		t.Fatal("selected goal was not linked to the resumed request", goalID, selected, question)
	}
	actual := 0
	for _, message := range history {
		if message.Role == "user" && message.SourceMessageID == "actual-original-request" {
			actual++
			if message.Content != text {
				t.Fatal("original content replaced", message.Content)
			}
		}
	}
	if actual != 1 {
		t.Fatal("actual user source duplicated or lost", actual)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var grants, approvals int64
	if err = store.DB.Model(&securityTaskGrantRow{}).Count(&grants).Error; err != nil {
		t.Fatal(err)
	}
	if err = store.DB.Model(&nativeApproval{}).Count(&approvals).Error; err != nil {
		t.Fatal(err)
	}
	if grants != 0 || approvals != 0 {
		t.Fatal("goal choice created execution authority", grants, approvals)
	}
}
