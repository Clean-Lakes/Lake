package web

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// Work management uses new authenticated backend endpoints, while the existing
// message, question, approval and work-goal frontend contracts stay unchanged.
func (b *Server) securityWorkRoute(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 6 || parts[0] != "api" || parts[1] != "sessions" || parts[3] != "security-work" {
		return false
	}
	if r.Method != "POST" {
		fail(405, "Method not allowed")
	}
	b.protect(r)
	if !b.authorized(r) {
		fail(401, "Authentication required")
	}
	if b.Engine == nil {
		fail(503, "Security runtime unavailable")
	}
	sessionID, goalID, action := parts[2], parts[4], parts[5]
	session := b.Store.Session(sessionID)
	projectID := stringOf(session["projectId"])
	data := body(w, r, 128*1024)
	expected := int64(memoryRevision(data["expectedRevision"]))
	if _, present := data["expectedRevision"]; !present || expected < 0 || expected == 0 && action != "select" {
		fail(400, "expectedRevision required")
	}
	switch action {
	case "contract":
		memoryFields(data, "actionId", "sourceMessageId", "expectedRevision", "steps")
		b.securitySourceMessage(sessionID, stringOf(data["sourceMessageId"]))
		var steps map[string]ai.WorkStepContract
		raw, err := json.Marshal(data["steps"])
		aiFailure(err)
		decoder := json.NewDecoder(strings.NewReader(string(raw)))
		decoder.DisallowUnknownFields()
		aiFailure(decoder.Decode(&steps))
		allowed := map[string]bool{}
		for _, id := range stringsOf(session["resourceIds"]) {
			allowed[id] = true
		}
		for _, step := range steps {
			for _, criterion := range step.Criteria {
				logicalTarget := step.VerificationMode == "manual" && criterion.Method == "human_verified" && (criterion.TargetKind == "session" && criterion.Target == sessionID || criterion.TargetKind == "project" && criterion.Target == projectID)
				if !logicalTarget && !allowed[criterion.Target] {
					fail(403, "Acceptance target outside current session resources")
				}
			}
		}
		aiFailure(b.Engine.ConfigureWorkAcceptance(sessionID, goalID, projectID, "local-user", stringOf(data["actionId"]), expected, steps))
		reply(w, 200, Object{"configured": true})
	case "select":
		memoryFields(data, "actionId", "sourceMessageId", "expectedRevision", "goalRevision")
		b.securitySourceMessage(sessionID, stringOf(data["sourceMessageId"]))
		aiFailure(b.Engine.SelectSecurityGoal(r.Context(), ai.SecurityGoalSelection{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: projectID, SessionID: sessionID, GoalID: goalID, SourceMessageID: stringOf(data["sourceMessageId"]), ExpectedGoalRevision: int64(memoryRevision(data["goalRevision"])), ExpectedRevision: expected}))
		reply(w, 200, Object{"selected": true})
	case "verify-step":
		memoryFields(data, "expectedRevision", "stepId")
		id, err := b.Engine.VerifyWorkStep(sessionID, goalID, stringOf(data["stepId"]), expected)
		aiFailure(err)
		reply(w, 200, Object{"acceptanceId": id})
	case "verify-human":
		memoryFields(data, "actionId", "sourceMessageId", "expectedRevision", "stepId", "criteriaIds", "note")
		b.securitySourceMessage(sessionID, stringOf(data["sourceMessageId"]))
		id, err := b.Engine.RecordHumanWorkAcceptance(sessionID, goalID, stringOf(data["stepId"]), "local-user", stringOf(data["actionId"]), stringOf(data["sourceMessageId"]), expected, stringsOf(data["criteriaIds"]), stringOf(data["note"]))
		aiFailure(err)
		reply(w, 200, Object{"acceptanceId": id})
	case "verify-goal":
		memoryFields(data, "expectedRevision")
		id, err := b.Engine.VerifyWorkGoal(sessionID, goalID, expected)
		aiFailure(err)
		reply(w, 200, Object{"acceptanceId": id})
	case "coverage":
		memoryFields(data, "expectedRevision", "failedAttemptId", "replacementAttemptId", "acceptanceId", "reason")
		aiFailure(b.Engine.CoverWorkAttempt(sessionID, goalID, stringOf(data["failedAttemptId"]), stringOf(data["replacementAttemptId"]), stringOf(data["acceptanceId"]), stringOf(data["reason"]), expected))
		reply(w, 200, Object{"recorded": true})
	default:
		fail(404, "Unknown work management action")
	}
	return true
}
