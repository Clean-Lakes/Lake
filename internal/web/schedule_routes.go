package web

import (
	"net/http"
	"strings"
	"time"
)

func (b *Server) scheduleRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) < 4 || len(parts) > 5 || parts[0] != "api" || parts[1] != "projects" || parts[3] != "schedules" {
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
		if row.Enabled != enabled {
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
					} else {
						advanceSchedule(row, now)
					}
				}
			}
			row.Enabled = enabled
			row.Revision++
			must(b.writeSchedules(rows))
		}
		reply(w, 200, scheduleView(*row))
	default:
		fail(405, "Method not allowed")
	}
	return true
}
