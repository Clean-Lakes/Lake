package ai

import (
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityParentAuthorityTracksExactOwnerScopeAndPolicy(t *testing.T) {
	db, now, o, root, _ := permitFixture(t)
	if err := db.AutoMigrate(securityCatalogModels()...); err != nil {
		t.Fatal(err)
	}
	row := securityParentRestrictionRow{ProjectID: o.ProjectID, SessionID: o.SessionID, GoalID: o.GoalID, GoalRevision: o.GoalRevision, PlanRevision: o.PlanRevision, StepID: o.StepID, StepRevision: o.StepRevision, AttemptID: o.AttemptID, TaskID: o.TaskID, ScopeID: "child", StoreID: o.StoreID, RecoveryEpoch: o.RecoveryEpoch, ParentOwner: js(root), ResourceIDs: js([]string{"r1"}), RoleCapabilities: js([]string{"file.read"}), AuthorityKind: "project_policy", AuthorityID: o.ProjectID, AuthorityRevision: 1, Revision: 1}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	o.Actor = "child"
	o.ChildScopeID = "child"
	restriction, err := loadCatalogParentRestriction(db, o, now)
	if err != nil {
		t.Fatal(err)
	}
	o.Parents = security.FreezeParentBindings([]security.ParentRestriction{restriction})
	if ok, err := runningParentAuthorityValid(db, o, now); err != nil || !ok {
		t.Fatalf("live source %v %v", ok, err)
	}
	if ok, _ := runningParentAuthorityValid(db, o, now.Add(time.Hour+time.Second)); ok {
		t.Fatal("expired root lease accepted")
	}
	if err = db.Model(&securityTaskBinding{}).Where("id = ?", root.BindingID).Update("owner_generation", root.Generation+1).Error; err != nil {
		t.Fatal(err)
	}
	if ok, _ := runningParentAuthorityValid(db, o, now); ok {
		t.Fatal("replacement owner accepted")
	}
	if err = db.Model(&securityTaskBinding{}).Where("id = ?", root.BindingID).Update("owner_generation", root.Generation).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityProjectPolicyRow{}).Where("project_id = ?", o.ProjectID).Update("revision", 2).Error; err != nil {
		t.Fatal(err)
	}
	if ok, _ := runningParentAuthorityValid(db, o, now); ok {
		t.Fatal("old policy source accepted")
	}
}

func TestSecurityChildScopeKeepsOwnReadyTupleAcrossPeerSelector(t *testing.T) {
	db, now, o, root, _ := permitFixture(t)
	if err := db.AutoMigrate(securityCatalogModels()...); err != nil {
		t.Fatal(err)
	}
	var row nativeWorkGoal
	if err := db.First(&row, "id = ?", o.GoalID).Error; err != nil {
		t.Fatal(err)
	}
	var goal WorkGoal
	if err := decodeWorkGoal(row, &goal); err != nil {
		t.Fatal(err)
	}
	goal.Items = append(goal.Items, WorkItem{ID: "peer", Title: "Independent peer", Status: "running"})
	goal.closure.Steps["peer"] = WorkStepContract{Revision: 1}
	goal.closure.ActiveAttempts["peer"] = "peer-attempt"
	goal.ActiveItemID = "peer"
	goal.Status = "blocked"
	if err := db.Model(&nativeWorkGoal{}).Where("id = ?", goal.ID).Updates(map[string]any{"data": js(goal), "closure_contract": js(goal.closure)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&workExecutionAttempt{ID: "peer-attempt", SessionID: o.SessionID, ProjectID: o.ProjectID, GoalID: o.GoalID, GoalRevision: 1, PlanRevision: 1, StepID: "peer", StepRevision: 1, SecurityTaskID: o.TaskID, RootTurnID: o.RootTurnID, State: "running", Revision: 1, CreatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	o.Actor = "child"
	o.ChildScopeID = "child-own-step"
	scope := securityParentRestrictionRow{ProjectID: o.ProjectID, SessionID: o.SessionID, GoalID: o.GoalID, GoalRevision: o.GoalRevision, PlanRevision: o.PlanRevision, StepID: o.StepID, StepRevision: o.StepRevision, AttemptID: o.AttemptID, TaskID: o.TaskID, ScopeID: o.ChildScopeID, StoreID: o.StoreID, RecoveryEpoch: o.RecoveryEpoch, ParentOwner: js(root), ResourceIDs: js([]string{"r1"}), RoleCapabilities: js([]string{"file.read"}), AuthorityKind: "project_policy", AuthorityID: o.ProjectID, AuthorityRevision: 1, Revision: 1}
	if err := db.Create(&scope).Error; err != nil {
		t.Fatal(err)
	}
	if ready, err := securityOperationGoalReady(db, o); err != nil || !ready {
		t.Fatalf("independent peer selector blocked own scope %v %v", ready, err)
	}
	if _, err := loadCatalogParentRestriction(db, o, now); err != nil {
		t.Fatal("peer progress invalidated parent source", err)
	}
	other := o
	other.StepID = "peer"
	other.AttemptID = "peer-attempt"
	if ready, err := securityOperationGoalReady(db, other); err != nil || ready {
		t.Fatalf("scope adopted peer tuple %v %v", ready, err)
	}
	goal.closure.ActiveAttempts[o.StepID] = "replacement"
	if err := db.Model(&nativeWorkGoal{}).Where("id = ?", goal.ID).Update("closure_contract", js(goal.closure)).Error; err != nil {
		t.Fatal(err)
	}
	if ready, err := securityOperationGoalReady(db, o); err != nil || ready {
		t.Fatalf("obsolete own attempt resumed %v %v", ready, err)
	}
}
