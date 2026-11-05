package ai

import (
	"context"
	"encoding/json"
	"strings"
)

const historicalRouterTaskText = "[Historical task snapshot omitted from model context. Read the current canonical task before deciding; this earlier revision is not current state or permission.]"

// Called under s.mu after native hydration, before admitting a new Router turn.
// Only repeated host-generated task snapshots are previews. Original event
// pages, human text, selected references, tool pairs and durable SDK events stay
// intact. Never parse ordinary user prose as a host context envelope.
func (e *Engine) projectSuperRouterHistoryLocked(ctx context.Context, s *session, c Config) error {
	if c.superRole != "router" || c.superRouter == nil {
		return nil
	}
	project := configSecurityProject(c)
	ids := []string{}
	seen := map[string]bool{}
	for _, m := range s.state.History {
		if m.Role == "user" && m.SourceMessageID != "" && m.HostTurnID != "" && !seen[m.SourceMessageID] {
			seen[m.SourceMessageID] = true
			ids = append(ids, m.SourceMessageID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	db, err := e.superStore()
	if err != nil {
		return err
	}
	originals := map[string][]superEventRow{}
	for start := 0; start < len(ids); start += 500 {
		var rows []superEventRow
		if err = db.WithContext(ctx).Where("project_id = ? AND source_kind = ? AND source_event_id IN ?", project, "user", ids[start:min(start+500, len(ids))]).Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			originals[row.SourceEventID] = append(originals[row.SourceEventID], row)
		}
	}
	changed := false
	projected := append([]Message(nil), s.state.History...)
	for i, m := range projected {
		if m.Role != "user" || m.HostTurnID == "" {
			continue
		}
		first, tail, ok := strings.Cut(m.Content, "\n")
		if !ok {
			continue
		}
		var envelope map[string]json.RawMessage
		var notice string
		var events, tasks []SuperObjectPage
		if json.Unmarshal([]byte(first), &envelope) != nil || json.Unmarshal(envelope["notice"], &notice) != nil || notice != routerContextNotice || json.Unmarshal(envelope["events"], &events) != nil || json.Unmarshal(envelope["tasks"], &tasks) != nil || len(tasks) == 0 {
			continue
		}

		matched := false
		for _, original := range originals[m.SourceMessageID] {
			if !strings.HasSuffix(m.Content, "[USER_MESSAGE]\n"+redact(routerUserPreview(original.Payload), c)) {
				continue
			}
			for _, page := range events {
				if page.Kind == "event" && page.ID == original.ID {
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
		if !matched {
			continue
		}
		pageChanged := false
		for j := range tasks {
			page := &tasks[j]
			if page.Kind != "task" || page.ID == "" || page.Text == historicalRouterTaskText {
				continue
			}
			page.Text = historicalRouterTaskText
			page.Offset = 0
			page.NextOffset = 0
			pageChanged = true
		}
		if !pageChanged {
			continue
		}
		envelope["tasks"] = json.RawMessage(js(tasks))
		projected[i].Content = js(envelope) + "\n" + tail
		changed = true
	}
	if changed {
		s.state.History = projected
		s.state.LastRequest, s.state.LastRequestAt, s.state.ContextMeasurement = nil, "", nil
	}
	return nil
}

func routerUserPreview(text string) string {
	if len(text) > 4096 {
		return utf8Prefix(text, 4096) + "\n[Original message continues in the immutable event. Read all pages before routing; the preview does not replace its constraints.]"
	}
	return text
}
