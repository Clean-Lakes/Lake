package web

import (
	"encoding/json"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"net/http"
	"strings"
	"time"
)

func (b *Server) scheduleRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) < 4 || len(parts) > 6 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "schedules" || len(parts) == 6 && parts[5] != "grant" {
		return false
	}
	b.Store.Project(parts[2])
	b.scheduleMu.Lock()
	defer b.scheduleMu.Unlock()
	rows, err := b.readSchedules()
	must(err)
	if len(parts) == 4 {
		if method != "GET" {
			fail(405, "Method not allowed")
		}
		items := []Object{}
		for _, row := range rows {
			if row.Project == parts[2] {
				items = append(items, scheduleView(row))
			}
		}
		reply(w, 200, Object{"items": items})
		return true
	}
	index := -1
	for i, row := range rows {
		if row.Project == parts[2] && row.ID == parts[4] {
			index = i
			break
		}
	}
	if index < 0 {
		fail(404, "定时任务不存在")
	}
	row := &rows[index]
	if len(parts) == 6 {
		if b.Engine == nil {
			fail(503, "Security runtime unavailable")
		}
		if method == "GET" {
			definition, state, err := b.Engine.SecurityScheduleDefinition(r.Context(), row.Project, row.ID)
			aiFailure(err)
			grants, err := b.Engine.SecurityScheduleGrants(r.Context(), row.Project, row.ID)
			aiFailure(err)
			reply(w, 200, Object{"configRevision": definition.ConfigRevision, "authorityRevision": definition.AuthorityRevision, "state": state, "grants": grants})
			return true
		}
		data := body(w, r, 128*1024)
		if method == "DELETE" {
			memoryFields(data, "actionId", "expectedConfigRevision", "expectedAuthorityRevision", "grantId", "expectedGrantRevision")
			a := ai.SecurityScheduleAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: row.Project, ScheduleID: row.ID, ExpectedConfigRevision: int64(memoryRevision(data["expectedConfigRevision"])), ExpectedAuthorityRevision: int64(memoryRevision(data["expectedAuthorityRevision"]))}
			aiFailure(b.Engine.RevokeSecurityScheduleGrant(r.Context(), a, stringOf(data["grantId"]), int64(memoryRevision(data["expectedGrantRevision"]))))
			reply(w, 200, Object{"revoked": true})
			return true
		}
		if method != "POST" {
			fail(405, "Method not allowed")
		}
		memoryFields(data, "actionId", "expectedConfigRevision", "expectedAuthorityRevision", "expiresAt", "maxRuns", "taskTtlSeconds", "taskGrant", "sourceMessageId")
		expiry, err := time.Parse(time.RFC3339, stringOf(data["expiresAt"]))
		if err != nil {
			fail(400, "Explicit expiresAt is required")
		}
		maxRuns := memoryRevision(data["maxRuns"])
		ttl := memoryRevision(data["taskTtlSeconds"])
		if maxRuns < 1 || maxRuns > 10000 || ttl < 1 || ttl > 4*60*60 {
			fail(400, "Explicit run count and task TTL are required")
		}
		var scope ai.SecurityScheduleGrant
		encoded := jsonText(data["taskGrant"])
		decoder := json.NewDecoder(strings.NewReader(encoded))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&scope.TaskGrant) != nil {
			fail(400, "Invalid typed task grant scope")
		}
		if b.Terminals.containsCredential(encoded) {
			fail(400, "Credentials cannot be included in grant scope")
		}
		scope.ScheduleID, scope.ProjectID, scope.ExpiresAt, scope.RemainingRuns, scope.TaskTTL = row.ID, row.Project, expiry, int64(maxRuns), time.Duration(ttl)*time.Second
		scope.SourceMessageID = stringOf(data["sourceMessageId"])
		if scope.SourceMessageID != "" {
			b.securitySourceMessage(row.Session, scope.SourceMessageID)
		}
		a := ai.SecurityScheduleAction{ActorID: "local-user", ActionID: stringOf(data["actionId"]), ProjectID: row.Project, ScheduleID: row.ID, ExpectedConfigRevision: int64(memoryRevision(data["expectedConfigRevision"])), ExpectedAuthorityRevision: int64(memoryRevision(data["expectedAuthorityRevision"]))}
		grant, err := b.Engine.IssueSecurityScheduleGrant(r.Context(), ai.SecurityScheduleGrantAction{Action: a, Grant: scope})
		aiFailure(err)
		reply(w, 201, grant)
		return true
	}
	switch method {
	case "GET":
		view := scheduleView(*row)
		history := row.History
		if history == nil {
			history = []scheduleExecution{}
		}
		view["history"] = history
		reply(w, 200, view)
	case "PATCH":
		data := body(w, r, 2048)
		memoryFields(data, "enabled", "expectedRevision")
		enabled := memoryBool(data["enabled"], "enabled")
		revision := memoryRevision(data["expectedRevision"])
		if revision != row.Revision {
			fail(409, "任务状态已变化，请刷新后重试")
		}
		availabilityIncomplete := false
		if b.Engine != nil {
			_, state, stateErr := b.Engine.SecurityScheduleDefinition(r.Context(), row.Project, row.ID)
			availabilityIncomplete = stateErr == nil && state == "availability_changing"
		}
		if row.Enabled != enabled || availabilityIncomplete {
			oldAnchor := row.AnchorAt
			if enabled {
				if row.Kind == "workflow" {
					b.requireScheduledWorkflow(row.Project)
				}
				at, e := time.Parse(time.RFC3339, row.At)
				if e != nil {
					fail(400, "任务时间无效，无法恢复")
				}
				now := time.Now()
				if !at.After(now) {
					if row.Interval == 0 {
						row.At = now.Add(time.Minute).Format(time.RFC3339)
						row.AnchorAt = row.At
					} else {
						advanceSchedule(row, now)
					}
				}
			}
			row.Enabled = enabled
			row.Revision++
			must(b.persistScheduleAvailability(r.Context(), row, oldAnchor != row.AnchorAt, func() error { return b.writeSchedules(rows) }))
		}
		reply(w, 200, scheduleView(*row))
	default:
		fail(405, "Method not allowed")
	}
	return true
}
