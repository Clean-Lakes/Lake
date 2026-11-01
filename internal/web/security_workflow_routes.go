package web

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Workflow contracts are host management actions. The client can confirm typed
// acceptance but cannot replace the actual template, role or resource scope.
func (b *Server) securityWorkflowRoute(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 6 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "security" || parts[4] != "workflows" {
		return false
	}
	b.protect(r)
	if !b.authorized(r) {
		fail(401, "Authentication required")
	}
	if b.Engine == nil {
		fail(503, "Security runtime unavailable")
	}
	project, workflowID := parts[2], parts[5]
	template := b.Store.Workflow(project, workflowID)
	digest := workflowSecurityDigest(template)
	switch r.Method {
	case http.MethodGet:
		definition, err := b.Engine.SecurityWorkflowDefinition(r.Context(), project, workflowID, int64(template.Version), digest)
		aiFailure(err)
		reply(w, 200, definition)
	case http.MethodPut:
		data := body(w, r, 256*1024)
		memoryFields(data, "actionId", "expectedRevision", "templateVersion", "acceptance")
		expected := int64(memoryRevision(data["expectedRevision"]))
		if _, ok := data["expectedRevision"]; !ok || expected < 0 || memoryRevision(data["templateVersion"]) != template.Version {
			fail(409, "Current template version and contract revision required")
		}
		actionID := stringOf(data["actionId"])
		if actionID == "" || len(actionID) > 256 {
			fail(400, "actionId required")
		}
		var acceptance map[string]ai.WorkStepContract
		raw, err := json.Marshal(data["acceptance"])
		aiFailure(err)
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.DisallowUnknownFields()
		aiFailure(decoder.Decode(&acceptance))
		definition := ai.SecurityWorkflowDefinition{ProjectID: project, WorkflowID: workflowID, TemplateVersion: int64(template.Version), TemplateDigest: digest, Goal: template.Goal, Steps: workflowSecuritySteps(template), Acceptance: acceptance}
		out, err := b.Engine.PutSecurityWorkflowDefinition(r.Context(), ai.SecurityWorkflowDefinitionAction{ActorID: "local-user", ActionID: actionID, ProjectID: project, WorkflowID: workflowID, ExpectedRevision: expected}, definition)
		aiFailure(err)
		reply(w, 200, out)
	default:
		fail(405, "Method not allowed")
	}
	return true
}
