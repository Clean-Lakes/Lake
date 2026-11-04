package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func securityDecode(value any, out any) {
	raw, err := json.Marshal(value)
	if err != nil {
		fail(400, "Invalid security payload")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil {
		fail(400, "Unsupported or invalid security fields")
	}
}

func (b *Server) securityProjectResourceIDs(projectID string, ids []string) {
	if len(ids) > 1000 {
		fail(400, "Resource scope exceeds limit")
	}
	allowed := map[string]bool{}
	b.Store.read(func() any {
		b.Store.activeProject(projectID)
		for _, row := range b.Store.rows("SELECT id FROM resources WHERE projectId=? AND "+activeResourcesSQL, projectID) {
			allowed[stringOf(row["id"])] = true
		}
		return nil
	})
	seen := map[string]bool{}
	for _, id := range ids {
		if !allowed[id] || seen[id] {
			fail(403, "Resource scope outside current project")
		}
		seen[id] = true
	}
}

func securityPageParameters(r *http.Request) (int64, int) {
	after := int64(0)
	limit := 100
	if value := r.URL.Query().Get("after"); value != "" {
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 0 {
			fail(400, "Invalid audit cursor")
		}
		after = n
	}
	if value := r.URL.Query().Get("limit"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 || n > 200 {
			fail(400, "Invalid audit page size")
		}
		limit = n
	}
	return after, limit
}

// securityRoute is an authenticated management API. Existing frontend/SSE
// contracts and approval kinds are unchanged; model parameters cannot call it
// as an approval or provide the authenticated actor identity.
func (b *Server) securityRoute(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	projectRoute := len(parts) >= 5 && parts[0] == "api" && parts[1] == "projects" && parts[3] == "security"
	taskRoute := len(parts) >= 4 && parts[0] == "api" && parts[1] == "sessions" && parts[3] == "security-tasks"
	sessionPolicyRoute := len(parts) == 5 && parts[0] == "api" && parts[1] == "sessions" && parts[3] == "security" && parts[4] == "legacy-policy"
	globalAudit := len(parts) == 3 && parts[0] == "api" && parts[1] == "security" && parts[2] == "audit"
	if !projectRoute && !taskRoute && !globalAudit && !sessionPolicyRoute {
		return false
	}
	b.protect(r)
	if !b.authorized(r) {
		fail(401, "Authentication required")
	}
	if b.Engine == nil {
		fail(503, "Security runtime unavailable")
	}
	if sessionPolicyRoute {
		sessionID := parts[2]
		projectID := stringOf(b.Store.Session(sessionID)["projectId"])
		if r.Method == "GET" {
			result, err := b.Engine.SecurityLegacySessionPolicy(r.Context(), projectID, sessionID)
			aiFailure(err)
			reply(w, 200, result)
			return true
		}
		if r.Method != "PUT" {
			fail(405, "Method not allowed")
		}
		data := body(w, r, 8192)
		memoryFields(data, "actionId", "expectedRevision", "permissions")
		permissions := object(data["permissions"])
		if len(permissions) != 7 {
			fail(400, "All seven permission settings are required")
		}
		for _, key := range []string{"silentReadFiles", "silentWriteFiles", "silentReadSQL", "silentCommands", "silentTerminalCreation", "blockUnreferencedAssets", "denyLocalExecution"} {
			if _, ok := permissions[key].(bool); !ok {
				fail(400, "Invalid permission setting")
			}
		}
		var p ai.Permissions
		securityDecode(permissions, &p)
		result, err := b.Engine.UpdateSecurityLegacySessionPolicy(r.Context(), ai.SecurityLegacyPolicyAction{SecurityPolicyAction: ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, SessionID: sessionID, Permissions: p})
		aiFailure(err)
		reply(w, 200, result)
		return true
	}
	if globalAudit || projectRoute && len(parts) == 5 && parts[4] == "audit" {
		if r.Method != "GET" {
			fail(405, "Method not allowed")
		}
		projectID := ""
		if projectRoute {
			projectID = parts[2]
			b.Store.Project(projectID)
		}
		after, limit := securityPageParameters(r)
		page, err := b.Engine.SecurityAudit(r.Context(), projectID, r.URL.Query().Get("epoch"), after, limit)
		aiFailure(err)
		reply(w, 200, page)
		return true
	}
	if projectRoute {
		projectID := parts[2]
		b.Store.Project(projectID)
		if len(parts) != 5 && !(len(parts) == 6 && (parts[4] == "catalog" || parts[4] == "mcp-bindings" || parts[4] == "command-targets")) && !(len(parts) == 7 && parts[4] == "mcp-bindings") {
			fail(404, "Unknown security management route")
		}
		if len(parts) == 6 && parts[4] == "catalog" && parts[5] == "preview-reconciliation" && r.Method == "POST" {
			result, err := b.Engine.PreviewSecurityCatalogReconciliation(r.Context(), projectID)
			aiFailure(err)
			reply(w, 200, result)
			return true
		}
		if len(parts) == 6 && parts[4] == "catalog" && parts[5] == "confirm-reconciliation" && r.Method == "POST" {
			data := body(w, r, 8192)
			memoryFields(data, "actionId", "expectedRevision", "digest")
			result, err := b.Engine.ConfirmSecurityCatalogReconciliation(r.Context(), ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, stringOf(data["digest"]))
			aiFailure(err)
			reply(w, 200, result)
			return true
		}
		if len(parts) == 6 && parts[4] == "command-targets" {
			b.securityProjectResourceIDs(projectID, []string{parts[5]})
			if r.Method == "GET" {
				result, err := b.Engine.SecurityCommandTargetConfiguration(r.Context(), projectID, parts[5])
				aiFailure(err)
				reply(w, 200, result)
				return true
			}
			if r.Method != "PUT" {
				fail(405, "Method not allowed")
			}
			data := body(w, r, 65536)
			memoryFields(data, "actionId", "expectedRevision", "os", "enabled", "services")
			var services []security.ServiceDefinition
			securityDecode(data["services"], &services)
			enabled, ok := data["enabled"].(bool)
			if !ok {
				fail(400, "enabled is required")
			}
			result, err := b.Engine.PutSecurityCommandTarget(r.Context(), ai.SecurityCommandTargetAction{SecurityPolicyAction: ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, ResourceID: parts[5], OS: stringOf(data["os"]), Enabled: enabled, Services: services})
			aiFailure(err)
			reply(w, 200, result)
			return true
		}
		if parts[4] == "mcp-bindings" {
			if len(parts) == 7 && parts[6] == "preview-reconciliation" && r.Method == "POST" {
				result, err := b.Engine.PreviewSecurityMCPReconciliation(r.Context(), projectID, parts[5])
				aiFailure(err)
				reply(w, 200, result)
				return true
			}
			if len(parts) == 7 && parts[6] == "confirm-reconciliation" && r.Method == "POST" {
				data := body(w, r, 8192)
				memoryFields(data, "actionId", "expectedRevision", "digest")
				result, err := b.Engine.ConfirmSecurityMCPReconciliation(r.Context(), ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, parts[5], stringOf(data["digest"]))
				aiFailure(err)
				reply(w, 200, result)
				return true
			}

			if len(parts) == 5 && r.Method == "GET" {
				result, err := b.Engine.SecurityMCPBindings(r.Context(), projectID)
				aiFailure(err)
				reply(w, 200, Object{"bindings": result})
				return true
			}
			if len(parts) == 6 && r.Method == "PUT" {
				data := body(w, r, 65536)
				memoryFields(data, "actionId", "expectedRevision", "enabled", "toolNames")
				var names []string
				securityDecode(data["toolNames"], &names)
				enabled, ok := data["enabled"].(bool)
				if !ok {
					fail(400, "enabled is required")
				}
				result, err := b.Engine.PutSecurityMCPBinding(r.Context(), ai.SecurityMCPBindingAction{SecurityPolicyAction: ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, ServerID: parts[5], Enabled: enabled, ToolNames: names})
				aiFailure(err)
				reply(w, 200, result)
				return true
			}
			fail(405, "Method not allowed")
		}
		if len(parts) != 5 {
			fail(404, "Unknown security management route")
		}
		switch parts[4] {
		case "mcp-inheritance":
			if r.Method == "GET" {
				result, err := b.Engine.SecurityMCPInheritance(r.Context(), projectID)
				aiFailure(err)
				servers := b.projectMCPIndex(r.Context(), projectID, &ai.Permissions{})
				reply(w, 200, struct {
					ai.SecurityMCPInheritance
					Servers []ai.ProjectMCPServer `json:"servers"`
				}{result, append([]ai.ProjectMCPServer{}, servers...)})
				return true
			}
			if r.Method != "PUT" {
				fail(405, "Method not allowed")
			}
			data := body(w, r, 8192)
			memoryFields(data, "actionId", "expectedRevision", "enabled")
			enabled, ok := data["enabled"].(bool)
			if !ok {
				fail(400, "enabled is required")
			}
			action := ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}
			// A project can select its MCP catalog before its first Pilot session.
			aiFailure(b.Engine.InheritSuperProjectAccess(r.Context(), projectID))
			result, err := b.Engine.PutSecurityMCPInheritance(r.Context(), action, enabled)
			aiFailure(err)
			reply(w, 200, result)
			return true
		case "catalog":
			if r.Method != "GET" {
				fail(405, "Method not allowed")
			}
			resources, err := b.Engine.SecurityCatalogResources(r.Context(), projectID)
			aiFailure(err)
			reply(w, 200, Object{"resources": resources, "capabilities": security.KnownCapabilities()})
			return true
		case "policy":
			if r.Method == "GET" {
				policy, err := b.Engine.SecurityProjectPolicy(r.Context(), projectID)
				if errors.Is(err, gorm.ErrRecordNotFound) {
					reply(w, 200, Object{"configured": false})
					return true
				}
				aiFailure(err)
				reply(w, 200, Object{"configured": true, "policy": policy})
				return true
			}
			if r.Method != "PUT" {
				fail(405, "Method not allowed")
			}
			data := body(w, r, 256*1024)
			memoryFields(data, "actionId", "expectedRevision", "policy")
			var input struct {
				SchemaVersion int
				Mode          string
				ResourceIDs   []string
				DenyLocal     bool
				Rules         []security.Rule
			}
			securityDecode(data["policy"], &input)
			b.securityProjectResourceIDs(projectID, input.ResourceIDs)
			policy := security.ProjectPolicy{ProjectID: projectID, SchemaVersion: input.SchemaVersion, Mode: input.Mode, ResourceIDs: input.ResourceIDs, DenyLocal: input.DenyLocal, Rules: input.Rules}
			result, err := b.Engine.PutSecurityProjectPolicy(r.Context(), ai.SecurityPolicyAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, policy)
			aiFailure(err)
			reply(w, 200, result)
			return true
		default:
			fail(404, "Unknown security management route")
		}
	}
	sessionID := parts[2]
	session := b.Store.Session(sessionID)
	projectID := stringOf(session["projectId"])
	if len(parts) == 4 {
		if r.Method != "GET" {
			fail(405, "Method not allowed")
		}
		tasks, err := b.Engine.SecurityTasks(r.Context(), projectID, sessionID)
		aiFailure(err)
		reply(w, 200, Object{"tasks": tasks})
		return true
	}
	taskID := parts[4]
	task, err := b.Engine.SecurityTaskForManagement(r.Context(), projectID, sessionID, taskID)
	aiFailure(err)
	if len(parts) == 5 {
		if r.Method != "GET" {
			fail(405, "Method not allowed")
		}
		reply(w, 200, Object{"task": task})
		return true
	}
	if len(parts) == 6 && parts[5] == "transition" {
		if r.Method != "POST" {
			fail(405, "Method not allowed")
		}
		data := body(w, r, 16*1024)
		memoryFields(data, "actionId", "expectedRevision", "state", "reason")
		to := security.TaskState(stringOf(data["state"]))
		if to != security.TaskPaused && to != security.TaskActive && to != security.TaskCancelled {
			fail(400, "Only pause, resume or cancel can be requested")
		}
		result, err := b.Engine.TransitionSecurityTask(r.Context(), ai.SecurityTaskAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, SessionID: sessionID, GoalID: task.GoalID, TaskID: taskID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"])), Reason: stringOf(data["reason"])}, to)
		aiFailure(err)
		reply(w, 200, result)
		return true
	}
	if parts[5] != "grants" {
		fail(404, "Unknown security task route")
	}
	if len(parts) == 6 && r.Method == "GET" {
		grants, err := b.Engine.SecurityTaskGrants(r.Context(), projectID, sessionID, taskID)
		aiFailure(err)
		envelope, err := b.Engine.SecurityTaskEnvelope(r.Context(), projectID, sessionID, taskID)
		aiFailure(err)
		reply(w, 200, Object{"grants": grants, "envelope": envelope})
		return true
	}
	if len(parts) == 6 && r.Method == "POST" {
		data := body(w, r, 128*1024)
		memoryFields(data, "actionId", "expectedRevision", "grant", "backgroundPolicy")
		var grant security.TaskGrant
		securityDecode(data["grant"], &grant)
		ids := []string{}
		for _, resource := range grant.Resources {
			ids = append(ids, resource.ID)
		}
		b.securityProjectResourceIDs(projectID, ids)
		result, err := b.Engine.IssueSecurityTaskGrant(r.Context(), ai.SecurityTaskGrantAction{Action: ai.SecurityTaskAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, SessionID: sessionID, GoalID: task.GoalID, TaskID: taskID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, Grant: grant, BackgroundPolicy: stringOf(data["backgroundPolicy"])})
		aiFailure(err)
		reply(w, 201, result)
		return true
	}
	if len(parts) != 8 || r.Method != "POST" {
		fail(405, "Method not allowed")
	}
	grantID, action := parts[6], parts[7]
	data := body(w, r, 128*1024)
	if action == "revoke" {
		memoryFields(data, "actionId", "expectedGrantRevision")
		aiFailure(b.Engine.RevokeSecurityTaskGrant(r.Context(), ai.SecurityTaskAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, SessionID: sessionID, GoalID: task.GoalID, TaskID: taskID}, grantID, int64(memoryRevision(data["expectedGrantRevision"]))))
		reply(w, 200, Object{"revoked": true})
		return true
	}
	if action != "preview-expansion" && action != "expand" {
		fail(404, "Unknown grant action")
	}
	memoryFields(data, "actionId", "expectedRevision", "expectedGrantRevision", "expectedEnvelopeRevision", "desiredScope", "additionalUses", "expiresAt", "confirmedChangeDigest", "backgroundPolicy")
	var desired security.TaskGrant
	securityDecode(data["desiredScope"], &desired)
	ids := []string{}
	for _, resource := range desired.Resources {
		ids = append(ids, resource.ID)
	}
	b.securityProjectResourceIDs(projectID, ids)
	var expiry time.Time
	if value := stringOf(data["expiresAt"]); value != "" {
		parsed, parseErr := time.Parse(time.RFC3339Nano, value)
		if parseErr != nil {
			fail(400, "Invalid grant expiry")
		}
		expiry = parsed
	}
	in := ai.SecurityTaskGrantExpansion{Action: ai.SecurityTaskAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, SessionID: sessionID, GoalID: task.GoalID, TaskID: taskID, ExpectedRevision: int64(memoryRevision(data["expectedRevision"]))}, GrantID: grantID, ExpectedGrantRevision: int64(memoryRevision(data["expectedGrantRevision"])), ExpectedEnvelopeRevision: int64(memoryRevision(data["expectedEnvelopeRevision"])), DesiredScope: desired, AdditionalUses: int64(memoryRevision(data["additionalUses"])), ExpiresAt: expiry, ConfirmedChangeDigest: stringOf(data["confirmedChangeDigest"]), BackgroundPolicy: stringOf(data["backgroundPolicy"])}
	if action == "preview-expansion" {
		result, err := b.Engine.PreviewSecurityTaskGrantExpansion(r.Context(), in)
		aiFailure(err)
		reply(w, 200, result)
	} else {
		result, err := b.Engine.ExpandSecurityTaskGrant(r.Context(), in)
		aiFailure(err)
		reply(w, 200, result)
	}
	return true
}
