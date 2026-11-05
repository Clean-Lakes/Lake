package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/extensions"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func TestSuperWorkerResourceIndexAndMissingTargetCannotConfirmScope(t *testing.T) {
	c := Config{superRole: "worker", Permissions: &Permissions{BlockUnreferencedAssets: true}, ReferencedAssets: []string{"visible"}, Assets: []Asset{
		{ID: "visible", Name: "Allowed host", Kind: "ssh", SSH: &SSH{Host: "hidden-address", IdentityFile: "never-in-context"}},
		{ID: "foreign", Name: "Hidden host", Kind: "ssh"},
	}}
	c.ProjectMCPServers = []ProjectMCPServer{{ID: "gos", Name: "GOS release catalog"}}
	index := superWorkerResourceIndex(c)
	if !strings.Contains(index, `"server_id":"gos"`) || !strings.Contains(index, "GOS release catalog") || !strings.Contains(index, assetAlias("visible")) || !strings.Contains(index, "Allowed host") || strings.Contains(index, "Hidden host") || strings.Contains(index, "hidden-address") || strings.Contains(index, "never-in-context") {
		t.Fatal("resource index lost visibility or exposed connection metadata")
	}
	e := &Engine{}
	_, err := e.invokeWorkTool(t.Context(), nil, c, Call{Name: "work_begin"}, map[string]any{"title": "Inspect", "items": []any{}})
	if err == nil || !strings.Contains(err.Error(), "explicit asset_refs") {
		t.Fatal("missing target entered plan confirmation", err)
	}
	tools := WorkerCatalog(workTools())
	for _, tool := range tools {
		if tool.Name == "work_begin" && !strings.Contains(js(tool.Parameters["required"]), "asset_refs") {
			t.Fatal("Worker schema omitted explicit target selection")
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
	for _, plan := range []bool{false, true} {
		for _, paused := range []bool{false, true} {
			t.Run(fmt.Sprintf("plan_%v_paused_%v", plan, paused), func(t *testing.T) { testSuperWorkerPlan(t, plan, paused) })
		}
	}
}

func testSuperWorkerPlan(t *testing.T, plan, paused bool) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	home := t.TempDir()
	var plannedItem string
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
			plannedItem = goal.Items[0].ID
			return response("", Call{ID: "start", Name: "work_update", Arguments: js(map[string]any{"item_id": goal.Items[0].ID, "status": "running"})})
		case 4:
			return response("", Call{ID: "skill", Name: "load_skill", Arguments: `{"name":"release-count"}`})
		case 5:
			if !strings.Contains(lastToolResult, "Test instructions for counting releases.") {
				t.Errorf("Worker did not receive the project Skill: %s", lastToolResult)
			}
			return response("", Call{ID: "finish-step", Name: "work_update", Arguments: js(map[string]any{"item_id": plannedItem, "status": "completed", "evidence_ids": []string{"skill"}})})
		case 6:
			return response("", Call{ID: "finish-goal", Name: "work_finish", Arguments: `{"summary":"The release counting procedure was read."}`})
		default:
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
	if paused {
		row, goal, err := e.workRow(w.SessionID, w.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		goal.Status, goal.Summary = "paused", "模型未提交可执行的下一步，已保留任务进度"
		if err := e.writeWorkGoal(&row, &goal, false); err != nil {
			t.Fatal(err)
		}
		if err := db.Model(&superAssignmentRow{}).Where("worker_id = ?", w.ID).Update("state", "parked").Error; err != nil {
			t.Fatal(err)
		}
		channel, err := e.SpecialistChannelForWorker(ctx, b.ProjectID, w.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		event := channelEventFixture(t, e, b, channel, "retry-query", "Use the project release counting procedure now")
		if _, err := e.ApplySuperDecision(ctx, b, SuperDecision{EventID: event.ID, PartKey: "retry", Action: "followup", TaskID: w.TaskID, Quote: event.Payload, Reason: "Continue the original query"}); err != nil {
			t.Fatal(err)
		}
		if err := e.finishSuperRouting(ctx, b, event.ID); err != nil {
			t.Fatal(err)
		}
		if err := e.QueueSuperFollowup(ctx, b.ProjectID, w.ID); err != nil {
			t.Fatal(err)
		}
	}
	if plan {
		if err := db.Model(&superWorkerRow{}).Where("id = ?", w.ID).Update("conversation_mode", ModePlan).Error; err != nil {
			t.Fatal(err)
		}
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
	go func() {
		if paused {
			done <- e.ResumeTaskWorker(ctx, "project", w.ID)
		} else {
			done <- e.StartTaskWorker(ctx, "project", w.ID)
		}
	}()
	if plan {
		select {
		case id := <-questions:
			if err := e.ReplyQuestion(w.SessionID, id, map[string][]string{"work_contract": {securityPlanConfirmLabel}}); err != nil {
				t.Fatal(err)
			}
		case err := <-done:
			t.Fatal("Worker skipped Plan confirmation", err)
		case <-time.After(10 * time.Second):
			t.Fatal("Worker did not present Plan confirmation")
		}
	}

	select {
	case id := <-questions:
		t.Fatal("ordinary work or result verification asked for confirmation", id)
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
	if goal.closure == nil || goal.OriginRootTurnID != w.OriginRootTurnID || goal.Status != "completed" || len(goal.ResourceBindings) != 0 || goal.Binding.AssetRef != "" {
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

	detail, err := e.SuperTaskDetail(w.SessionID, w.TaskID)
	if err != nil || detail.Task.State != "completed" || detail.Task.AcceptanceState != "pass" {
		t.Fatalf("task did not automatically verify: %+v %v", detail.Task, err)
	}

	var humanCount int64
	if err := db.Model(&workAcceptanceRecord{}).Where("session_id = ? AND verifier_version = ?", w.SessionID, "human/1").Count(&humanCount).Error; err != nil || humanCount != 0 {
		t.Fatal("automatic work manufactured human acceptance", humanCount, err)
	}
	var confirmations int64
	if err := db.Model(&securityConfirmationQuestionRow{}).Where("session_id = ?", w.SessionID).Count(&confirmations).Error; err != nil || confirmations != int64(map[bool]int{false: 0, true: 1}[plan]) {
		t.Fatal("unexpected host confirmation history", confirmations, err)
	}
	var record workAcceptanceRecord
	if err := db.Where("goal_id = ? AND state = ? AND scope = ?", goal.ID, "pass", "step").First(&record).Error; err != nil {
		t.Fatal(err)
	}
	op := operations[0]
	cases := map[string]func(*gorm.DB) error{
		"missing receipt": func(tx *gorm.DB) error { return tx.Where("operation_id = ?", op.ID).Delete(&nativeEvidence{}).Error },
		"wrong call": func(tx *gorm.DB) error {
			return tx.Model(&nativeEvidence{}).Where("operation_id = ?", op.ID).Update("call_id", "another-call").Error
		},
		"error result": func(tx *gorm.DB) error {
			return tx.Model(&nativeEvidence{}).Where("operation_id = ?", op.ID).Update("data", `{"isError":true,"content":[{"type":"text","text":"failed"}]}`).Error
		},
		"future receipt": func(tx *gorm.DB) error {
			return tx.Model(&nativeEvidence{}).Where("operation_id = ?", op.ID).Update("at", time.Now().Add(time.Hour)).Error
		},
		"unknown operation": func(tx *gorm.DB) error {
			return tx.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("status", "unknown").Error
		},
		"substituted attempt": func(tx *gorm.DB) error {
			return tx.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("attempt_id", "another-attempt").Error
		},
		"recovered store": func(tx *gorm.DB) error {
			return tx.Model(&securityProjectPolicyRow{}).Where("project_id = ?", goal.closure.ProjectID).Update("recovery_epoch", "new-epoch").Error
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			rollback := errors.New("rollback fixture")
			err := db.Transaction(func(tx *gorm.DB) error {
				if err := mutate(tx); err != nil {
					return err
				}
				state, err := currentWorkAcceptanceTx(tx, goal, goal.Items[0].ID, record)
				if err != nil || state != security.AcceptanceInsufficient {
					t.Errorf("stale or absent receipt accepted: %s %v", state, err)
				}
				return rollback
			})
			if !errors.Is(err, rollback) {
				t.Fatal(err)
			}
		})
	}

}

func TestSuperFirstPlanBindsRealResourcesWithoutReplacingGoal(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "target-source", "Read target A only", "read", "Read target A")
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
	if _, err = e.beginWork(s, "Read B", []WorkItem{{ID: "other", Title: "Different target"}}, assetAlias("target-b")); err == nil {
		t.Fatal("confirmed scope widened")
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
