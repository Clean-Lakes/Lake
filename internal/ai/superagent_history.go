package ai

import (
	"context"
	"strings"
	"time"
)

type SuperTaskIndexEntry struct {
	WorkerID      string        `json:"workerId"`
	RoleID        string        `json:"roleId"`
	RoleKey       string        `json:"roleKey"`
	SourceEventID string        `json:"sourceEventId"`
	Task          SuperTaskView `json:"task"`
	ResourceIDs   []string      `json:"resourceIds"`
	ResourceCount int           `json:"resourceCount"`
	Truncated     bool          `json:"truncated"`
}
type SuperTaskIndexPage struct {
	Items      []SuperTaskIndexEntry `json:"items"`
	NextCursor string                `json:"nextCursor,omitempty"`
	Notice     string                `json:"notice"`
}

// Search returns canonical task projections, not another Worker's transcript.
// The cursor advances across bounded scans even when a resource filter matches
// no rows. Old tasks are never limited to the recent Router context envelope.
func (e *Engine) SearchSuperTaskIndex(ctx context.Context, session, roleID, resourceID, query, after string, limit int, dates ...string) (SuperTaskIndexPage, error) {
	out := SuperTaskIndexPage{Items: []SuperTaskIndexEntry{}, Notice: "Bounded index only, not execution constraints. Read the exact task object by ID/revision for original requirements and full bindings; continue with nextCursor."}
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 50 || len(query) > 256 {
		return out, errSuperBinding
	}
	c, err := e.superReadConfig(session)
	if err != nil || c.superRole != "router" {
		return out, errSuperBinding
	}
	project := configSecurityProject(c)
	db, err := e.superStore()
	if err != nil {
		return out, err
	}
	q := db.WithContext(ctx).Where("project_id = ? AND parent_worker_id = '' AND id > ?", project, after)
	if len(dates) > 2 {
		return out, errSuperBinding
	}
	for i, value := range dates {
		if value != "" {
			date, err := time.Parse(time.RFC3339, value)
			if err != nil {
				return out, errSuperBinding
			}
			if i == 0 {
				q = q.Where("created_at >= ?", date.UTC())
			} else {
				q = q.Where("created_at < ?", date.UTC())
			}
		}
	}
	if roleID != "" {
		q = q.Where("role_id = ?", roleID)
	}
	var rows []superWorkerRow
	if err = q.Order("id").Limit(100).Find(&rows).Error; err != nil {
		return out, err
	}
	used := len(js(out))
	for i, w := range rows {
		previousCursor := out.NextCursor
		out.NextCursor = w.ID
		task, err := e.SuperTask(w.goalSession(), w.TaskID)
		if err != nil {
			return out, err
		}
		if resourceID != "" {
			match := false
			for _, binding := range task.Resources {
				if binding.AssetRef == resourceID {
					match = true
				}
			}
			if !match {
				continue
			}
		}
		if query != "" && !strings.Contains(strings.ToLower(task.Title), strings.ToLower(query)) {
			continue
		}
		var role superRoleRow
		if err := db.First(&role, "id = ? AND project_id = ?", w.RoleID, project).Error; err != nil {
			return out, err
		}
		resourceIDs := []string{}
		for _, binding := range task.Resources {
			resourceIDs = append(resourceIDs, binding.AssetRef)
		}
		resourceCount := len(resourceIDs)
		if len(resourceIDs) > 8 {
			resourceIDs = resourceIDs[:8]
		}
		task.Title = utf8Prefix(task.Title, 200)
		task.Summary = utf8Prefix(task.Summary, 256)
		task.Resources = nil
		item := SuperTaskIndexEntry{WorkerID: w.ID, RoleID: w.RoleID, RoleKey: role.RoleKey, SourceEventID: w.SourceEventID, Task: task, ResourceIDs: resourceIDs, ResourceCount: resourceCount, Truncated: true}
		if err := e.checkSuperPayload(js(item)); err != nil {
			return out, err
		}
		bytes := len(js(item)) + 1
		if used+bytes > 15*1024 && len(out.Items) > 0 {
			out.NextCursor = previousCursor
			return out, nil
		}
		used += bytes
		out.Items = append(out.Items, item)
		if len(out.Items) == limit {
			if i == len(rows)-1 && len(rows) < 100 {
				out.NextCursor = ""
			}
			return out, nil
		}
	}
	if len(rows) < 100 {
		out.NextCursor = ""
	}
	return out, nil
}
