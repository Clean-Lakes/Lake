package ai

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSuperComparisonReadsOnlyRegisteredVersionedEvidence(t *testing.T) {
	e := managedEngineFixture(t, Model{URL: "http://127.0.0.1:1", Name: "unused"})
	b := SuperSourceBinding{SourceID: "user", ProjectID: "project", Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(t.Context(), b); err != nil {
		t.Fatal(err)
	}
	resource := SecurityCatalogResource{ProjectID: b.ProjectID, ID: "host-a", Kind: "ssh", MetadataDigest: hash("endpoint-a")}
	if err := e.SetSecurityCatalogResolver(func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error) {
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
