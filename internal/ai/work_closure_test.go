package ai

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func managedGoalFixture(t *testing.T, e *Engine, sessionID string, manual ...bool) WorkGoal {
	t.Helper()
	s, err := e.get(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.state.View.RootTurnID = "turn-" + sessionID
	s.state.RootQuestion = "同步两个service及1442个tiles，逐条对比且保留已有记录"
	s.mu.Unlock()
	g, err := e.beginWork(s, "同步并核验", []WorkItem{{ID: "copy", Title: "同步与逐条校验"}})
	if err != nil {
		t.Fatal(err)
	}
	criteria := []security.AcceptanceCriterion{
		{ID: "services", Method: "json_equal", Target: "target-db", ConnectionRevision: 1, SourceDigest: security.ObservationSourceDigest("execute_sql", hash("trusted query"), "target-db", 1), Pointer: "/service", Expected: json.RawMessage(`2`)},
		{ID: "tiles", Method: "json_equal", Target: "target-db", ConnectionRevision: 1, SourceDigest: security.ObservationSourceDigest("execute_sql", hash("trusted query"), "target-db", 1), Pointer: "/tiles", Expected: json.RawMessage(`1442`)},
		{ID: "equal", Method: "json_equal", Target: "target-db", ConnectionRevision: 1, SourceDigest: security.ObservationSourceDigest("execute_sql", hash("trusted query"), "target-db", 1), Pointer: "/differences", Expected: json.RawMessage(`0`)},
		{ID: "preserved", Method: "json_equal", Target: "target-db", ConnectionRevision: 1, SourceDigest: security.ObservationSourceDigest("execute_sql", hash("trusted query"), "target-db", 1), Pointer: "/existingPreserved", Expected: json.RawMessage(`true`)},
	}
	store, storeErr := e.adkStore()
	if storeErr != nil {
		t.Fatal(storeErr)
	}
	if err = store.DB.FirstOrCreate(&securityResourceRevisionRow{ProjectID: "project", ResourceID: "target-db", StoreID: "fixture-store", RecoveryEpoch: "fixture-epoch", ConnectionRevision: 1, ConnectionDigest: hash("connection"), State: "ready"}, "project_id = ? AND resource_id = ?", "project", "target-db").Error; err != nil {
		t.Fatal(err)
	}
	mode := "automatic"
	if len(manual) > 0 && manual[0] {
		mode = "manual"
	}
	if err = e.ConfigureWorkAcceptance(sessionID, g.ID, "project", "local-user", "contract-"+sessionID, g.Revision, map[string]WorkStepContract{g.Items[0].ID: {VerificationMode: mode, Required: true, Criteria: criteria}}); err != nil {
		t.Fatal(err)
	}
	_, g, err = e.workRow(sessionID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func managedAttemptFixture(t *testing.T, e *Engine, g WorkGoal, retry string) (WorkGoal, string) {
	t.Helper()
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var task security.SecurityTask
	now := time.Now().UTC()
	root := "turn-" + g.SessionID
	err = store.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		task, err = beginSecurityTask(tx, "fixture-store", "fixture-epoch", SecurityTaskStart{Action: SecurityTaskAction{ActorID: "user", ActionID: uid(), SessionID: g.SessionID, GoalID: g.ID, ProjectID: "project"}, SourceMessageID: "source", ExpectedGoalRevision: g.closure.GoalRevision, ExpiresAt: now.Add(time.Hour)}, now)
		if err != nil {
			return err
		}
		_, err = bindSecurityTaskTurn(tx, task.ID, task.StoreID, task.RecoveryEpoch, root, "", task.ExecutionRevision, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := e.BeginWorkAttempt(g.SessionID, g.ID, g.Items[0].ID, task.ID, root, retry, "via verified relay", g.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, g, err = e.workRow(g.SessionID, g.ID)
	if err != nil {
		t.Fatal(err)
	}
	return g, attempt
}

func managedProofFixture(t *testing.T, e *Engine, g WorkGoal, attempt, status, body string) nativeOperation {
	t.Helper()
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var attemptRow workExecutionAttempt
	if err = store.DB.First(&attemptRow, "id = ?", attempt).Error; err != nil {
		t.Fatal(err)
	}
	var task securityTaskRow
	if err = store.DB.First(&task, "id = ?", attemptRow.SecurityTaskID).Error; err != nil {
		t.Fatal(err)
	}
	op := nativeOperation{Tool: "execute_sql", ArgsHash: hash("trusted query"), SecurityTaskID: attemptRow.SecurityTaskID, RootTurnID: attemptRow.RootTurnID, OwnerID: "fixture-committed-owner", OwnerGeneration: 1, ID: uid(), SessionID: g.SessionID, GoalID: g.ID, GoalRevision: g.closure.GoalRevision, PlanRevision: g.closure.PlanRevision, StepID: g.Items[0].ID, StepRevision: g.closure.Steps[g.Items[0].ID].Revision, AttemptID: attempt, ResourceID: "target-db", ResourceConnectionRevision: 1, Status: status, Risk: "write", StartedAt: time.Now().UTC()}
	op.ProjectID = "project"
	descriptor := security.PreparedOperation{FormatVersion: 1, PolicyRevision: 1, ID: op.ID, Tool: op.Tool, Actor: "agent", RegistryVersion: security.RegistryVersion, StoreID: "fixture-store", RecoveryEpoch: "fixture-epoch", ProjectID: op.ProjectID, SessionID: op.SessionID, GoalID: op.GoalID, GoalRevision: op.GoalRevision, PlanRevision: op.PlanRevision, StepID: op.StepID, StepRevision: op.StepRevision, AttemptID: op.AttemptID, TaskID: op.SecurityTaskID, RootTurnID: op.RootTurnID, CallID: uid(), ExecutionRevision: 1, OwnerID: op.OwnerID, OwnerGeneration: op.OwnerGeneration, ArgumentsDigest: op.ArgsHash, PreviewDigest: hash("preview"), TargetKind: security.TargetResource, Capabilities: []string{"db.read"}, Proof: security.ProofOpaque, Resources: []security.ResourceRevision{{ID: "target-db", ConnectionRevision: 1, ConnectionDigest: hash("connection"), State: "ready"}}}
	var descriptorErr error
	descriptor.StoreID, descriptor.RecoveryEpoch = task.StoreID, task.RecoveryEpoch
	op.DescriptorDigest, descriptorErr = security.OperationDigest(descriptor)
	if descriptorErr != nil {
		t.Fatal(descriptorErr)
	}
	op.SecurityDescriptor = js(descriptor)
	op.CallID = descriptor.CallID
	op.StoreID = descriptor.StoreID
	op.RecoveryEpoch = descriptor.RecoveryEpoch
	if err = store.DB.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	if status == "succeeded" {
		if err = store.DB.Create(&nativeEvidence{OperationID: op.ID, SessionID: g.SessionID, Status: "completed", Data: body, At: time.Now().UTC()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	return op
}

func TestWorkClosureDirectFailureRelaySuccessPreservesHistory(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	g := managedGoalFixture(t, e, "sync", true)
	g, direct := managedAttemptFixture(t, e, g, "")
	failed := managedProofFixture(t, e, g, direct, "failed", "")
	if _, err := e.VerifyWorkStep(g.SessionID, g.ID, g.Items[0].ID, g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Items[0].Status != "blocked" {
		t.Fatal("failed direct attempt was hidden", g)
	}
	g, relay := managedAttemptFixture(t, e, g, direct)
	managedProofFixture(t, e, g, relay, "succeeded", `{"service":2,"tiles":1442,"differences":0,"existingPreserved":true}`)
	acceptance, err := e.VerifyWorkStep(g.SessionID, g.ID, g.Items[0].ID, g.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Items[0].Status == "completed" {
		t.Fatal("raw SQL result was accepted without human verification")
	}
	acceptance, err = e.RecordHumanWorkAcceptance(g.SessionID, g.ID, g.Items[0].ID, "local-user", "verify-relay", "human-source", g.Revision, []string{"services", "tiles", "equal", "preserved"}, "人工逐条核验通过")
	if err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Items[0].Status != "completed" || g.Status == "completed" {
		t.Fatal("step acceptance confused with goal closure", g)
	}
	if _, err = e.VerifyWorkGoal(g.SessionID, g.ID, g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Status == "completed" {
		t.Fatal("failed attempt closed without an explicit equivalent coverage link")
	}
	if err = e.CoverWorkAttempt(g.SessionID, g.ID, direct, relay, acceptance, "同一数据契约，通过中转等价实现", g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if _, err = e.VerifyWorkGoal(g.SessionID, g.ID, g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Status != "completed" {
		t.Fatal("verified goal did not close", g)
	}
	store, _ := e.adkStore()
	var op nativeOperation
	var attempt workExecutionAttempt
	var links int64
	if err = store.DB.First(&op, "id = ?", failed.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = store.DB.First(&attempt, "id = ?", direct).Error; err != nil {
		t.Fatal(err)
	}
	store.DB.Model(&workCoverageLink{}).Count(&links)
	if op.Status != "failed" || attempt.State != "failed" || attempt.ClosureState != "covered" || links != 1 {
		t.Fatal("historical failure rewritten", op.Status, attempt, links)
	}
	var projected map[string]any
	if err = json.Unmarshal([]byte(js(g)), &projected); err != nil {
		t.Fatal(err)
	}
	if projected["closure"] != nil || projected["goalRevision"] != nil || projected["activeAttempts"] != nil {
		t.Fatal("private contract leaked to original UI projection", projected)
	}
}

func TestWorkClosureRejectsChangedTargetAndSubstitutedQuery(t *testing.T) {
	for _, testCase := range []string{"connection", "query"} {
		t.Run(testCase, func(t *testing.T) {
			e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
			g := managedGoalFixture(t, e, "binding")
			g, attempt := managedAttemptFixture(t, e, g, "")
			op := managedProofFixture(t, e, g, attempt, "succeeded", `{"service":2,"tiles":1442,"differences":0,"existingPreserved":true}`)
			store, _ := e.adkStore()
			if testCase == "query" {
				if err := store.DB.Model(&nativeOperation{}).Where("id = ?", op.ID).Update("args_hash", hash("SELECT 1442 AS tiles")).Error; err != nil {
					t.Fatal(err)
				}
			} else {
				if err := store.DB.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", "project", "target-db").Update("connection_revision", 2).Error; err != nil {
					t.Fatal(err)
				}
			}
			if _, err := e.VerifyWorkStep(g.SessionID, g.ID, g.Items[0].ID, g.Revision); err != nil {
				t.Fatal(err)
			}
			_, g, _ = e.workRow(g.SessionID, g.ID)
			if g.Items[0].Status == "completed" {
				t.Fatal("old connection or constant query impersonated reviewed observation")
			}
		})
	}
}

func TestWorkClosureUnknownCannotBeCoveredByOtherGoal(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	g1 := managedGoalFixture(t, e, "g1-session")
	g1, attempt := managedAttemptFixture(t, e, g1, "")
	unknown := managedProofFixture(t, e, g1, attempt, "unknown", "")
	if _, err := e.VerifyWorkStep(g1.SessionID, g1.ID, g1.Items[0].ID, g1.Revision); err != nil {
		t.Fatal(err)
	}
	_, g1, _ = e.workRow(g1.SessionID, g1.ID)
	store, _ := e.adkStore()
	if err := store.DB.Model(&workExecutionAttempt{}).Where("id = ?", attempt).Update("state", "failed").Error; err != nil {
		t.Fatal(err)
	}
	// Even a stale/misclassified attempt row cannot override original unknown I/O.
	if _, err := e.BeginWorkAttempt(g1.SessionID, g1.ID, g1.Items[0].ID, "task", "root", attempt, "retry", g1.Revision); err == nil {
		t.Fatal("unknown allowed retry")
	}
	g2 := managedGoalFixture(t, e, "g2-session", true)
	g2, a2 := managedAttemptFixture(t, e, g2, "")
	managedProofFixture(t, e, g2, a2, "succeeded", `{"service":2,"tiles":1442,"differences":0,"existingPreserved":true}`)
	accepted, err := e.VerifyWorkStep(g2.SessionID, g2.ID, g2.Items[0].ID, g2.Revision)
	if err != nil {
		t.Fatal(err)
	}
	_, g2, _ = e.workRow(g2.SessionID, g2.ID)
	accepted, err = e.RecordHumanWorkAcceptance(g2.SessionID, g2.ID, g2.Items[0].ID, "local-user", "verify-g2", "human-source", g2.Revision, []string{"services", "tiles", "equal", "preserved"}, "人工核验")
	if err != nil {
		t.Fatal(err)
	}
	_, g2, _ = e.workRow(g2.SessionID, g2.ID)
	if err = e.CoverWorkAttempt(g1.SessionID, g1.ID, attempt, a2, accepted, "new goal success", g1.Revision); err == nil {
		t.Fatal("G2 covered G1 unknown")
	}
	if _, err = e.VerifyWorkGoal(g2.SessionID, g2.ID, g2.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = e.VerifyWorkGoal(g1.SessionID, g1.ID, g1.Revision); err != nil {
		t.Fatal(err)
	}
	_, g1, _ = e.workRow(g1.SessionID, g1.ID)
	if g1.Status == "completed" {
		t.Fatal("G2 cleared G1")
	}
	var original nativeOperation
	store.DB.First(&original, "id = ?", unknown.ID)
	if original.Status != "unknown" {
		t.Fatal("unknown operation lost")
	}
}

func TestWorkClosureRejectsFakeCompletionAndStaleCAS(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	g := managedGoalFixture(t, e, "fake")
	row, g, _ := e.workRow(g.SessionID, g.ID)
	g.Items[0].Status = "completed"
	g.Status = "completed"
	if err := e.writeWorkGoal(&row, &g, false); err == nil {
		t.Fatal("model completion bypassed acceptance")
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if _, err := e.VerifyWorkGoal(g.SessionID, g.ID, g.Revision-1); err == nil {
		t.Fatal("stale progress accepted")
	}
	g, attempt := managedAttemptFixture(t, e, g, "")
	managedProofFixture(t, e, g, attempt, "succeeded", `{"exitCode":0}`)
	if _, err := e.VerifyWorkStep(g.SessionID, g.ID, g.Items[0].ID, g.Revision); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow(g.SessionID, g.ID)
	if g.Items[0].Status == "completed" {
		t.Fatal("exit status accepted as business verification")
	}
}
