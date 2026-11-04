package web

import (
	"context"
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
	"testing"
	"time"
)

func TestSecurityScheduleReminderDeliveryAndRevisionAreIdempotent(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	value, err := b.scheduleTool(context.Background(), session, project, "schedule_create", Object{"name": "single delivery", "kind": "reminder", "message": "fixture", "at": time.Now().Add(time.Minute).Format(time.RFC3339), "interval_seconds": 60}, true)
	if err != nil {
		t.Fatal(err)
	}
	id := stringOf(object(value)["id"])
	rows, err := b.readSchedules()
	if err != nil {
		t.Fatal(err)
	}
	row := rows[0]
	row.OccurrenceID = "fixed-occurrence"
	b.deliverScheduleReminder(row)
	b.deliverScheduleReminder(row)
	if len(objects(b.Store.Snapshot(session)["messages"])) != 1 {
		t.Fatal("same local occurrence delivered twice")
	}
	b.tickSchedules(time.Now().Add(2 * time.Minute))
	rows, err = b.readSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Revision != 1 || rows[0].ConfigRevision != 1 || rows[0].AuthorityRevision != 1 || rows[0].StatusRevision < 2 {
		t.Fatal("worker status invalidated config/authorization revision")
	}
	view := scheduleView(rows[0])
	for _, key := range []string{"security_config_revision", "security_authority_revision", "security_status_revision", "security_anchor_at", "security_occurrence_id"} {
		if _, exists := view[key]; exists {
			t.Fatal("internal schedule metadata changed existing frontend shape")
		}
	}
	apiTest(t, h, "PATCH", "/api/projects/"+project+"/schedules/"+id, Object{"enabled": false, "expectedRevision": 1}, 200)
	rows, err = b.readSchedules()
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Revision != 2 || rows[0].ConfigRevision != 1 || rows[0].AuthorityRevision != 1 {
		t.Fatal("availability toggle changed frozen execution authority")
	}
}

func TestSecurityScheduleExplicitGrantAPIAndAvailabilityRetainAbsoluteLimits(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": true}, 200)
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": "http://127.0.0.1:12345/v1", "name": "metadata-only fixture", "protocol": "openai"}, 200)
	resources, err := b.Engine.SecurityCatalogResources(context.Background(), project)
	if err != nil {
		t.Fatal(err)
	}
	var resource security.ResourceRevision
	for _, candidate := range resources {
		if candidate.ID == ref {
			resource = candidate
		}
	}
	if resource.ID == "" {
		t.Fatal("actual resource catalog binding missing")
	}
	policy := security.ProjectPolicy{ProjectID: project, SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{ref}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmEither, Limits: security.ScopeLimits{FileRoots: []string{"/tmp"}}}}}
	if _, err = b.Engine.PutSecurityProjectPolicy(context.Background(), ai.SecurityPolicyAction{ActorID: "local-user", ActionID: "schedule-policy", ProjectID: project}, policy); err != nil {
		t.Fatal(err)
	}
	template := b.Store.SaveWorkflow(project, "", 0, b.validateWorkflowTemplate(project, object(parsed(jsonText(workflowFixtureInput(ref))))))
	steps := workflowSecuritySteps(template)
	acceptance := map[string]ai.WorkStepContract{}
	for _, step := range steps {
		acceptance[step.ID] = ai.WorkStepContract{Required: true, Criteria: []security.AcceptanceCriterion{{ID: "health", Method: "json_equal", Target: ref, ConnectionRevision: resource.ConnectionRevision, SourceDigest: security.ObservationSourceDigest("read", security.ContentDigest([]byte("fixed-health-query")), ref, resource.ConnectionRevision), Pointer: "/healthy", Expected: json.RawMessage(`true`)}}}
	}
	if _, err = b.Engine.PutSecurityWorkflowDefinition(context.Background(), ai.SecurityWorkflowDefinitionAction{ActorID: "local-user", ActionID: "workflow-contract", ProjectID: project, WorkflowID: template.ID}, ai.SecurityWorkflowDefinition{ProjectID: project, WorkflowID: template.ID, TemplateVersion: int64(template.Version), TemplateDigest: workflowSecurityDigest(template), Goal: template.Goal, Steps: steps, Acceptance: acceptance}); err != nil {
		t.Fatal(err)
	}
	// This private metadata fixture does not execute a model/resource operation.
	value, err := b.scheduleTool(context.Background(), session, project, "schedule_create", Object{"name": "bounded workflow", "kind": "workflow", "workflow_id": template.ID, "version": template.Version, "at": time.Now().Add(time.Hour).Format(time.RFC3339)}, true)
	if err == nil {
		t.Fatal("managed tool trusted approved bool without registered permit", value)
	}
	row := toolSchedule{ID: ident(), Project: project, Session: session, Name: "bounded workflow", Kind: "workflow", WorkflowID: template.ID, Version: template.Version, At: time.Now().Add(time.Hour).Format(time.RFC3339), Enabled: true, Revision: 1, Status: "scheduled"}
	normalizeScheduleRevisions(&row)
	if err = b.persistScheduleConfiguration(context.Background(), &row, "local-user", func() error { return b.writeSchedules([]toolSchedule{row}) }); err != nil {
		t.Fatal(err)
	}
	base := "/api/projects/" + project + "/schedules/" + row.ID
	expiry := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	grant := apiTest(t, h, "POST", base+"/grant", Object{"actionId": "explicit-grant", "expectedConfigRevision": 1, "expectedAuthorityRevision": 1, "expiresAt": expiry.Format(time.RFC3339), "maxRuns": 2, "taskTtlSeconds": 1800, "taskGrant": security.TaskGrant{Resources: []security.ResourceRevision{resource}, Capabilities: []string{"file.read"}, RemainingUses: 5, Limits: security.ScopeLimits{FileRoots: []string{"/tmp"}}}}, 201)
	apiTest(t, h, "PATCH", base, Object{"enabled": false, "expectedRevision": 1}, 200)
	current := apiTest(t, h, "GET", base+"/grant", nil, 200)
	if integer(current["configRevision"]) != 1 || integer(current["authorityRevision"]) != 1 {
		t.Fatal("availability invalidated original authorization identity")
	}
	grants := objects(current["grants"])
	if len(grants) != 1 || grants[0]["ID"] != grant["ID"] || grants[0]["Revoked"] != false || integer(grants[0]["RemainingRuns"]) != 2 || grants[0]["ExpiresAt"] != expiry.Format(time.RFC3339) {
		t.Fatal("availability renewed/revoked bounded schedule authorization")
	}
	apiTest(t, h, "DELETE", base+"/grant", Object{"actionId": "stale-revoke", "expectedConfigRevision": 2, "expectedAuthorityRevision": 1, "grantId": grant["ID"], "expectedGrantRevision": 1}, 409)
	apiTest(t, h, "DELETE", base+"/grant", Object{"actionId": "explicit-revoke", "expectedConfigRevision": 1, "expectedAuthorityRevision": 1, "grantId": grant["ID"], "expectedGrantRevision": 1}, 200)
	revoked := apiTest(t, h, "GET", base+"/grant", nil, 200)
	if grants := objects(revoked["grants"]); len(grants) != 1 || grants[0]["Revoked"] != true || integer(grants[0]["Revision"]) != 2 {
		t.Fatal("explicit grant revocation was not durably versioned")
	}
}

func TestSecurityScheduleGrantEndpointRejectsImplicitBoundsAndActor(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	value, err := b.scheduleTool(context.Background(), session, project, "schedule_create", Object{"name": "no agent", "kind": "reminder", "message": "fixture", "at": time.Now().Add(time.Hour).Format(time.RFC3339)}, true)
	if err != nil {
		t.Fatal(err)
	}
	id := stringOf(object(value)["id"])
	path := "/api/projects/" + project + "/schedules/" + id + "/grant"
	apiTest(t, h, "POST", path, Object{"actor": "local-user", "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)}, 400)
	apiTest(t, h, "POST", path, Object{"actionId": "missing-bounds"}, 400)
}
