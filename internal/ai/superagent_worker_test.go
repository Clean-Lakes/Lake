package ai

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/extensions"
	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSuperWorkerResourceIndexAndOptionalTaskReferences(t *testing.T) {
	c := Config{superRole: "worker", Permissions: &Permissions{BlockUnreferencedAssets: true}, ReferencedAssets: []string{"visible"}, Assets: []Asset{
		{ID: "visible", Name: "Allowed host", Kind: "ssh", SSH: &SSH{Host: "hidden-address", IdentityFile: "never-in-context"}},
		{ID: "foreign", Name: "Hidden host", Kind: "ssh"},
	}}
	c.ProjectMCPServers = []ProjectMCPServer{{ID: "gos", Name: "GOS release catalog"}}
	index := superWorkerResourceIndex(c)
	if !strings.Contains(index, `"server_id":"gos"`) || !strings.Contains(index, "GOS release catalog") || !strings.Contains(index, assetAlias("visible")) || !strings.Contains(index, "Allowed host") || strings.Contains(index, "Hidden host") || strings.Contains(index, "hidden-address") || strings.Contains(index, "never-in-context") {
		t.Fatal("resource index lost visibility or exposed connection metadata")
	}
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	value, err := e.invokeWorkTool(t.Context(), s, c, Call{Name: "work_begin"}, map[string]any{"title": "Inspect", "items": []any{}})
	if err != nil || len(value.(WorkGoal).ResourceBindings) != 0 {
		t.Fatal("task required resources before discovery", value, err)
	}
	tools := WorkerCatalog(workTools())
	for _, tool := range tools {
		if tool.Name == "work_begin" && strings.Contains(js(tool.Parameters["required"]), "asset_refs") {
			t.Fatal("Worker schema still requires task resource selection")
		}
	}
	for _, tool := range workTools() {
		if tool.Name == "work_begin" && strings.Contains(js(tool.Parameters["required"]), "asset_refs") {
			t.Fatal("Worker schema mutated ordinary tool contract")
		}
	}
	large := Config{ProjectMCPServers: c.ProjectMCPServers}
	for i := 0; i < 300; i++ {
		large.Assets = append(large.Assets, Asset{ID: js(i), Name: strings.Repeat("界", 200), Kind: "ssh"})
	}
	bounded := superWorkerResourceIndex(large)
	if len(bounded) > 34<<10 || !strings.Contains(bounded, `"truncated":true`) || !strings.Contains(bounded, "GOS release catalog") {
		t.Fatal("resource context was not byte bounded")
	}
}

func TestSuperWorkerUsesOriginalGoalAndHostConfirmation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	home := t.TempDir()
	if err := extensions.NewStore(home).SaveSkill("release-count", "Test instructions for counting releases.", true); err != nil {
		t.Fatal(err)
	}
	m, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		lastToolResult := ""
		for _, entry := range arr(input["messages"]) {
			message := obj(entry)
			if str(message["role"]) == "tool" {
				lastToolResult = str(message["content"])
			}
		}
		switch n {
		case 1:
			return response("", Call{ID: "early", Name: "load_skill", Arguments: `{"name":"release-count"}`})
		case 2:
			if !strings.Contains(lastToolResult, "work_begin") || !strings.Contains(lastToolResult, "asset_refs:[]") {
				t.Errorf("pre-plan Skill access was not declined with an actionable recovery: %s", lastToolResult)
			}
			return response("", Call{ID: "plan", Name: "work_begin", Arguments: `{"asset_refs":[],"title":"Check release counting procedure","items":[{"id":"check","title":"Read the project release counting procedure"}]}`})
		case 3:
			var goal WorkGoal
			if err := json.Unmarshal([]byte(lastToolResult), &goal); err != nil || len(goal.Items) != 1 {
				t.Errorf("missing confirmed plan item: %s", lastToolResult)
				return response("No plan to run.")
			}
			return response("", Call{ID: "start", Name: "work_update", Arguments: js(map[string]any{"item_id": goal.Items[0].ID, "status": "running"})})
		case 4:
			return response("", Call{ID: "skill", Name: "load_skill", Arguments: `{"name":"release-count"}`})
		default:
			if n == 5 && !strings.Contains(lastToolResult, "Test instructions for counting releases.") {
				t.Errorf("Worker did not receive the project Skill: %s", lastToolResult)
			}
			return response("The release counting procedure was read.")
		}
	})
	defer closeModel()
	e := managedEngineFixture(t, m)
	e.HostContext = ctx
	if err := e.SetSecurityCatalogResolver(func(_ context.Context, q SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{}, nil
	}); err != nil {
		t.Fatal(err)
	}
	policy, err := e.SecurityProjectPolicy(ctx, "project")
	if err != nil {
		t.Fatal(err)
	}
	policy.Rules = append(policy.Rules, security.Rule{Capability: "artifact.read", Effect: security.EffectAllow})
	if _, err = e.PutSecurityProjectPolicy(ctx, SecurityPolicyAction{ActorID: "user", ActionID: "allow-skills", ProjectID: "project", ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	b := SuperSourceBinding{SourceID: "user", ProjectID: "project", Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(ctx, b); err != nil {
		t.Fatal(err)
	}
	task := superCreateFixture(t, e, b, "original-message", "Check the release counting procedure", "release-count", "Check the release counting procedure")
	db, _ := e.superStore()
	var w superWorkerRow
	if err := db.First(&w, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(ctx, b, w.SourceEventID); err != nil {
		t.Fatal(err)
	}
	p := DefaultPermissions()
	if err := e.ConfigureTaskWorker(ctx, "project", w.ID, Config{Model: m, SecurityProjectID: "project", Profile: "core", MaxSteps: 12, Permissions: &p, CredentialDir: filepath.Join(home, "secrets"), AssetRef: "unrelated", Assets: []Asset{{ID: "unrelated", Kind: "ssh", Name: "Unrelated host"}}}); err != nil {
		t.Fatal(err)
	}
	questions := make(chan string, 4)
	e.Emit = func(event Event) {
		if event.Type == "question" {
			id := str(obj(event.Data)["id"])
			if q, ok := event.Data.(*QuestionRequest); ok && q != nil {
				id = q.ID
			}
			if id != "" {
				questions <- id
			}
		}
	}
	done := make(chan error, 1)
	go func() { done <- e.StartTaskWorker(ctx, "project", w.ID) }()
	select {
	case id := <-questions:
		if err := e.ReplyQuestion(w.SessionID, id, map[string][]string{"work_contract": {securityWorkConfirmLabel}}); err != nil {
			t.Fatal(err)
		}
	case err := <-done:
		t.Fatal("Worker skipped original host confirmation", err)
	case <-time.After(10 * time.Second):
		t.Fatal("Worker did not present confirmation")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("Worker did not finish bounded invocation")
	}
	_, goal, err := e.workRow(w.SessionID, w.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if goal.closure == nil || goal.OriginRootTurnID != w.OriginRootTurnID || goal.Status == "completed" || len(goal.ResourceBindings) != 0 || goal.Binding.AssetRef != "" {
		t.Fatal("goal identity or acceptance changed", goal)
	}
	var count int64
	if err = db.Model(&nativeWorkGoal{}).Where("session_id = ?", w.SessionID).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("Worker created a second task authority", count, err)
	}
	var operations []nativeOperation
	if err = db.Where("session_id = ?", w.SessionID).Find(&operations).Error; err != nil || len(operations) != 1 || operations[0].Tool != "load_skill" || operations[0].CallID != "skill" || operations[0].Status != "succeeded" || operations[0].ResourceID != "" || operations[0].AttemptID == "" {
		t.Fatal("expected exactly one project-scoped Skill operation after confirmation", len(operations), err)
	}
}

func TestSuperConfirmedTaskAddsProjectResourcesWithoutReplacingGoal(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "target-source", "Compare targets A and B", "read", "Compare targets A and B")
	c := Config{SecurityProjectID: b.ProjectID, Profile: "core", Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}, Assets: []Asset{{ID: "target-a", Name: "A", Kind: "ssh", SSH: &SSH{Host: "127.0.0.1", Port: 22, Username: "fixture"}}, {ID: "target-b", Name: "B", Kind: "ssh", SSH: &SSH{Host: "127.0.0.2", Port: 22, Username: "fixture"}}}}
	if err := e.ConfigureTaskWorker(ctx, b.ProjectID, task.WorkerID, c); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(task.SessionID)
	s.mu.Lock()
	s.state.WorkGoalID = task.TaskID
	s.state.View.RootTurnID = "original-root"
	s.mu.Unlock()
	goal, err := e.beginWork(s, "Read A", []WorkItem{{ID: "read", Title: "Review A"}}, assetAlias("target-a"))
	if err != nil || goal.ID != task.TaskID || len(goal.ResourceBindings) != 1 || goal.ResourceBindings[0].AssetRef != "target-a" {
		t.Fatal(goal, err)
	}
	contract := WorkStepContract{Required: true, VerificationMode: "manual", Criteria: []security.AcceptanceCriterion{{ID: "review", Method: "human_verified", TargetKind: security.TargetSession, Target: task.SessionID, SourceDigest: hash("actual reviewed requirement"), Expected: json.RawMessage(`"Review A"`)}}}
	if err = e.ConfigureWorkAcceptance(task.SessionID, goal.ID, b.ProjectID, "user", "confirm-original-target", goal.Revision, map[string]WorkStepContract{goal.Items[0].ID: contract}); err != nil {
		t.Fatal(err)
	}
	_, confirmed, _ := e.workRow(task.SessionID, task.TaskID)
	updated, err := e.beginWork(s, "Compare targets A and B", nil, assetAlias("target-b"))
	if err != nil || updated.ID != task.TaskID || len(updated.ResourceBindings) != 2 || updated.closure.GoalRevision != confirmed.closure.GoalRevision || updated.closure.PlanRevision != confirmed.closure.PlanRevision || !updated.DeadlineAt.Equal(confirmed.DeadlineAt) || updated.OriginRootTurnID != confirmed.OriginRootTurnID {
		t.Fatal("resource discovery replaced task or acceptance", updated, err)
	}
	db, _ := e.superStore()
	var goals, tasks int64
	if err = db.Model(&nativeWorkGoal{}).Count(&goals).Error; err != nil || goals != 1 {
		t.Fatal(goals, err)
	}
	if err = db.Model(&securityTaskRow{}).Count(&tasks).Error; err != nil || tasks != 0 {
		t.Fatal("resource proposal granted execution", tasks, err)
	}
}

func TestSuperWorkerSourceRevocationStopsNextProviderOrTool(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	if _, err := e.ActivateSuperProject(ctx, b.ProjectID, "pilot", nil); err != nil {
		t.Fatal(err)
	}
	task := superCreateFixture(t, e, b, "source-message", "Inspect orders", "orders", "Inspect orders")
	db, _ := e.superStore()
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(ctx, b, worker.SourceEventID); err != nil {
		t.Fatal(err)
	}
	if err := e.ConfigureTaskWorker(ctx, b.ProjectID, task.WorkerID, Config{SecurityProjectID: b.ProjectID, Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}}); err != nil {
		t.Fatal(err)
	}
	c, err := e.ConfigForSession(task.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := e.AcquireWorkerSlot(ctx, b.ProjectID, task.WorkerID)
	if err != nil {
		t.Fatal(err)
	}
	run := context.WithValue(ctx, superAssignmentContextKey{}, token)
	if err = e.checkSuperModelDomain(run, task.SessionID, c); err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&superSourceRow{}).Where("id = ?", b.SourceID).Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.checkSuperModelDomain(run, task.SessionID, c); err == nil {
		t.Fatal("revoked source still eligible for provider/tool dispatch")
	}
}
