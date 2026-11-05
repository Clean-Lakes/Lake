package ai

import (
	"context"
	"encoding/json"

	"github.com/Clean-Lakes/Lake/internal/security"
	"strings"
	"testing"
	"time"
)

func superComparisonEvidenceFixture(t *testing.T) (*Engine, SuperSourceBinding, SuperRouteResult, SuperRouteResult, SuperRouteResult, *SecurityCatalogResource, nativeEvidence) {
	t.Helper()
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "unused"})
	b := SuperSourceBinding{SourceID: "user", ProjectID: "project", Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(t.Context(), b); err != nil {
		t.Fatal(err)
	}
	resource := SecurityCatalogResource{ProjectID: b.ProjectID, ID: "host-a", Kind: "ssh", MetadataDigest: hash("endpoint-a")}
	if err := e.SetSecurityCatalogResolver(func(_ context.Context, q SecurityCatalogQuery) (SecurityCatalogView, error) {
		if !q.All && len(q.ResourceIDs) == 0 {
			return SecurityCatalogView{}, nil
		}
		return SecurityCatalogView{Resources: []SecurityCatalogResource{resource}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.BootstrapSecurityCatalog(t.Context()); err != nil {
		t.Fatal(err)
	}
	policyBefore, err := e.SecurityProjectPolicy(t.Context(), b.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	policyBefore.ResourceIDs = []string{resource.ID}
	if _, err := e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "evidence-read-scope", ProjectID: b.ProjectID, ExpectedRevision: policyBefore.Revision}, policyBefore); err != nil {
		t.Fatal(err)
	}
	preview, err := e.PreviewSecurityCatalogReconciliation(t.Context(), b.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	confirmedPolicy, err := e.SecurityProjectPolicy(t.Context(), b.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.ConfirmSecurityCatalogReconciliation(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "confirm-fixture-catalog", ProjectID: b.ProjectID, ExpectedRevision: confirmedPolicy.Revision}, preview.Digest); err != nil {
		t.Fatal(err)
	}
	currentResources, err := e.SecurityCatalogResources(t.Context(), b.ProjectID)
	if err != nil || len(currentResources) != 1 {
		t.Fatal(currentResources, err)
	}
	connection := currentResources[0].ConnectionRevision
	a := superCreateFixture(t, e, b, "a", "Check host A", "a", "Check host A")
	other := superCreateFixture(t, e, b, "b", "Check host B", "b", "Check host B")
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "compare", Kind: "message", Payload: "Compare A and B"})
	if err != nil {
		t.Fatal(err)
	}
	comparison, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "comparison", Action: "create", Title: "Compare A and B", RoleKey: "investigator", Quote: event.Payload, Reason: "Historical comparison", EvidenceTaskIDs: []string{a.TaskID, other.TaskID}})
	if err != nil {
		t.Fatal(err)
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	catalogCall := nativeOperation{ID: "catalog-before-observation", CallID: "catalog-call", Tool: "list_assets", ProjectID: b.ProjectID, GoalID: a.TaskID, SessionID: a.SessionID, StoreID: storeID, RecoveryEpoch: epoch, Status: "succeeded"}
	if err := db.Create(&catalogCall).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&nativeEvidence{OperationID: catalogCall.ID, CallID: catalogCall.CallID, SessionID: a.SessionID, Status: "completed", Data: "catalog metadata is not host observation", At: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	op := nativeOperation{ID: "operation-a", CallID: "call-a", ProjectID: b.ProjectID, GoalID: a.TaskID, GoalRevision: 1, AttemptID: "attempt-a", SessionID: a.SessionID, StoreID: storeID, RecoveryEpoch: epoch, ResourceID: resource.ID, ResourceConnectionRevision: connection, Status: "unknown"}
	if err := db.Create(&op).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&workExecutionAttempt{ID: op.AttemptID, GoalID: a.TaskID, GoalRevision: 1, SessionID: a.SessionID, ProjectID: b.ProjectID, State: "unknown", Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	evidence := nativeEvidence{OperationID: op.ID, CallID: op.CallID, SessionID: a.SessionID, Status: "unknown", Data: strings.Repeat("历史观测，", 900), At: time.Now().Add(-time.Hour)}
	if err := db.Create(&evidence).Error; err != nil {
		t.Fatal(err)
	}
	return e, b, a, other, comparison, &resource, evidence
}

func TestSuperComparisonReadsOnlyRegisteredVersionedEvidence(t *testing.T) {
	e, b, a, other, comparison, resource, evidence := superComparisonEvidenceFixture(t)
	connection := resourceConnectionForTest(t, e, b.ProjectID)
	op := nativeOperation{AttemptID: "attempt-a"}
	s, _ := e.get(comparison.SessionID)
	s.mu.Lock()
	s.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "worker", superTaskID: comparison.TaskID}
	s.mu.Unlock()
	page, err := e.ListReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	refs := page["items"].([]TaskEvidenceRef)
	if len(refs) != 1 || refs[0].ResultState != "unknown" || refs[0].AcceptanceState == "pass" || refs[0].ConnectionVersion != connection || refs[0].AttemptID != op.AttemptID {
		t.Fatal(refs)
	}
	var text string
	offset := 0
	for range 20 {
		result, err := e.ReadReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, refs[0].EvidenceID, refs[0].ID, offset, 2048)
		if err != nil || !result.Historical || len(result.Text) > 2048 {
			t.Fatal(result, err)
		}
		text += result.Text
		offset = result.NextOffset
		if offset == 0 {
			break
		}
	}
	if text != evidence.Data {
		t.Fatal("evidence paging lost source bytes")
	}
	if _, err := e.ReadReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, refs[0].EvidenceID, "forged", 0, 2048); err == nil {
		t.Fatal("forged reference accepted")
	}
	unreferenced, _ := e.get(other.SessionID)
	unreferenced.mu.Lock()
	unreferenced.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "worker", superTaskID: other.TaskID}
	unreferenced.mu.Unlock()
	if _, err := e.ListReferencedTaskEvidence(t.Context(), other.SessionID, a.TaskID, "", 20); err == nil {
		t.Fatal("unreferenced task evidence read")
	}
	resource.MetadataDigest = hash("replaced-connection")
	if _, err := e.ReadReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, refs[0].EvidenceID, refs[0].ID, offset, 2048); err == nil {
		t.Fatal("stale actual connection read")
	}
	resource.MetadataDigest = hash("endpoint-a")
	policy, err := e.SecurityProjectPolicy(t.Context(), b.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	policy.ResourceIDs = nil
	if _, err := e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "remove-read-scope", ProjectID: b.ProjectID, ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	if _, err := e.ReadReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, refs[0].EvidenceID, refs[0].ID, 0, 2048); err == nil {
		t.Fatal("revoked resource scope read")
	}
}

func resourceConnectionForTest(t *testing.T, e *Engine, project string) int64 {
	t.Helper()
	rows, err := e.SecurityCatalogResources(t.Context(), project)
	if err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	return rows[0].ConnectionRevision
}

func TestSuperComparisonHistoricalReadVerifiesReceiptWithoutAcceptingSource(t *testing.T) {
	e, b, a, _, comparison, resource, _ := superComparisonEvidenceFixture(t)
	policy, err := e.SecurityProjectPolicy(t.Context(), b.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	policy.Rules = append(policy.Rules, security.Rule{Capability: "task.read", Effect: security.EffectAllow})
	if _, err := e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "allow-history-receipt", ProjectID: b.ProjectID, ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}

	db, _ := e.superStore()
	before, _ := e.SuperTaskDetail(a.SessionID, a.TaskID)
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", comparison.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(t.Context(), b, worker.SourceEventID); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get(comparison.SessionID)
	s.mu.Lock()
	s.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "worker", superTaskID: comparison.TaskID}
	s.mu.Unlock()
	refs, err := e.ListReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	ref := refs["items"].([]TaskEvidenceRef)[0]
	model, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "plan", Name: "work_begin", Arguments: `{"asset_refs":[],"title":"Read historical evidence page","items":[{"title":"Review one historical page without accepting source results"}]}`})
		}
		_, g, err := e.workRow(comparison.SessionID, comparison.TaskID)
		if err != nil {
			t.Error(err)
			return response("blocked")
		}
		if n == 2 {
			return response("", Call{ID: "start", Name: "work_update", Arguments: js(map[string]any{"item_id": g.Items[0].ID, "status": "running"})})
		}
		if n == 3 {
			return response("", Call{ID: "list-history", Name: "list_referenced_task_evidence", Arguments: js(map[string]any{"task_id": a.TaskID})})
		}
		if n == 4 {
			current, err := e.ListReferencedTaskEvidence(t.Context(), comparison.SessionID, a.TaskID, "", 20)
			if err != nil {
				t.Error(err)
				return response("blocked")
			}
			ref = current["items"].([]TaskEvidenceRef)[0]
			return response("", Call{ID: "historical-read", Name: "read_referenced_task_evidence", Arguments: js(map[string]any{"task_id": a.TaskID, "evidence_id": ref.EvidenceID, "reference_id": ref.ID, "limit": 2048})})
		}
		if n == 5 {
			return response("Historical source remains unknown and unaccepted; only one stored page was read.", Call{ID: "verify", Name: "work_update", Arguments: js(map[string]any{"item_id": g.Items[0].ID, "status": "completed", "evidence_ids": []string{"historical-read"}})})
		}
		if n == 6 {
			return response("", Call{ID: "finish", Name: "work_finish", Arguments: `{"summary":"Historical page read; source remains unaccepted."}`})
		}
		return response("Historical page read; source remains unaccepted.")
	})
	defer closeModel()
	if err := e.ConfigureTaskWorker(t.Context(), b.ProjectID, worker.ID, Config{Model: model, SecurityProjectID: b.ProjectID, Profile: "core", MaxSteps: 8}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	e.HostContext = ctx
	done := make(chan error, 1)
	drained := make(chan struct{})
	go func() { defer close(drained); done <- e.StartTaskWorker(ctx, b.ProjectID, worker.ID) }()
	defer func() {
		cancel()
		select {
		case <-drained:
		case <-time.After(3 * time.Second):
			t.Error("worker did not drain")
		}
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("automatic comparison did not finish")
	}
	s.mu.Lock()
	question := s.state.View.Question
	s.mu.Unlock()
	if nativeQuestionReady(question) {
		t.Fatal("automatic comparison requested confirmation")
	}

	var op nativeOperation
	if err := db.First(&op, "session_id = ? AND tool = ?", comparison.SessionID, "read_referenced_task_evidence").Error; err != nil {
		t.Fatal(err)
	}
	if op.Status != "succeeded" || op.ResourceID != "" || op.AttemptID == "" || qualifiedAcceptanceOperation(op) {
		t.Fatal("historical read became host observation", op)
	}
	if current, err := currentWorkOperationResourcesTx(db, op); err != nil || !current {
		t.Fatal("missing exact receipt", current, err)
	}
	after, _ := e.SuperTaskDetail(a.SessionID, a.TaskID)
	if js(before) != js(after) {
		t.Fatal("comparison changed source task")
	}
	var passes int64
	db.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND state = 'pass'", comparison.TaskID).Count(&passes)
	if passes != 2 {
		t.Fatal("comparison did not verify its own receipt", passes)
	}
	db.Model(&workAcceptanceRecord{}).Where("goal_id = ? AND verifier_version = 'human/1'", comparison.TaskID).Count(&passes)
	if passes != 0 {
		t.Fatal("comparison manufactured human verification")
	}
	var commands int64
	db.Model(&nativeOperation{}).Where("session_id = ? AND resource_id <> ''", comparison.SessionID).Count(&commands)
	if commands != 0 {
		t.Fatal("comparison executed host operation")
	}
	// Every receipt is invalidated by source changes, including after the
	// comparison has verified its own historical read.
	original := op.Result
	var page TaskEvidencePage
	_ = json.Unmarshal([]byte(op.Result), &page)
	page.Hash = hash("forged")
	op.Result = js(page)
	if current, err := currentWorkOperationResourcesTx(db, op); err == nil && current {
		t.Fatal("tampered receipt accepted")
	}
	op.Result = original
	if err := db.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", b.ProjectID, resource.ID).Update("connection_revision", ref.ConnectionVersion+1).Error; err != nil {
		t.Fatal(err)
	}
	if current, err := currentWorkOperationResourcesTx(db, op); err == nil && current {
		t.Fatal("changed source connection accepted")
	}
}
