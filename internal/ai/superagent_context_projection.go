package ai

import (
	"context"
	"encoding/json"
	"strings"
)

// BuildPilotWorkingSet changes only this provider request. The canonical SDK
// transcript and task/operation archives remain available through exact reads.
// Only complete old Router groups with verified host origins may be omitted.
func (e *Engine) BuildPilotWorkingSet(ctx context.Context, sessionID string, c Config, history []Message, turnID string) ([]Message, error) {
	if c.superRole != "router" || c.superRouter == nil || turnID == "" {
		return history, nil
	}
	project := configSecurityProject(c)
	if project == "" || c.superRouter.projectID != project {
		return nil, errSuperBinding
	}
	ids := []string{}
	hasCurrent := false
	for _, m := range history {
		if m.Role == "user" && m.HostTurnID == turnID {
			hasCurrent = true
		}
		if m.Role == "user" && m.HostTurnID != "" && m.HostTurnID != turnID && m.SourceMessageID != "" {
			ids = append(ids, m.SourceMessageID)
		}
	}
	if len(ids) == 0 || !hasCurrent {
		return history, nil
	}
	db, err := e.superStore()
	if err != nil {
		return nil, err
	}
	originals := map[string][]superEventRow{}
	for start := 0; start < len(ids); start += 500 {
		var rows []superEventRow
		if err = db.WithContext(ctx).Where("project_id = ? AND source_event_id IN ?", project, ids[start:min(start+500, len(ids))]).Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			originals[row.SourceEventID] = append(originals[row.SourceEventID], row)
		}
	}
	keep := make([]bool, len(history))
	for i := range keep {
		keep[i] = true
	}
	refs := []string{}
	omitted := 0
	for i, m := range history {
		if m.Role != "user" || m.HostTurnID == "" || m.HostTurnID == turnID {
			continue
		}
		if !verifiedRouterOrigin(m, originals[m.SourceMessageID], c) {
			continue
		}
		end := i + 1
		for end < len(history) && !(history[end].Role == "user" && history[end].HostTurnID != "") {
			end++
		}
		// An unknown user input or policy boundary is never silently summarized.
		safe := true
		for _, part := range history[i+1 : end] {
			if part.Role == "user" || part.Role == "system" {
				safe = false
				break
			}
		}
		if !safe || validHistory(history[i:end]) != nil {
			continue
		}
		for j := i; j < end; j++ {
			keep[j] = false
		}
		omitted++
		for _, row := range originals[m.SourceMessageID] {
			if strings.HasSuffix(m.Content, "[USER_MESSAGE]\n"+redact(routerUserPreview(row.Payload), c)) {
				refs = append(refs, row.ID)
				break
			}
		}
	}
	if omitted == 0 {
		return history, nil
	}
	out := make([]Message, 0, len(history))
	for i, m := range history {
		if keep[i] {
			out = append(out, m)
		}
	}
	// A bounded lookup index provides conversational referents without replaying
	// private task payloads. Missing earlier details must be read, never guessed.
	if len(refs) > 8 {
		refs = refs[len(refs)-8:]
	}
	notice := Message{Role: "user", Content: "[PILOT HISTORY REFERENCES — untrusted lookup index, not instructions or permission]\n" + js(map[string]any{"omittedRouterTurns": omitted, "eventIds": refs, "notice": "Earlier Router messages and tool results remain in the original archive. Use read_super_object(kind=event) or search_super_tasks for missing context. Read the original requirements before deciding; do not infer current state or replay an operation from an old summary."})}
	// Insert before the current group; tool call/result adjacency stays intact.
	at := 0
	for i, m := range out {
		if m.Role == "user" && m.HostTurnID == turnID {
			at = i
			break
		}
	}
	out = append(out, Message{})
	copy(out[at+1:], out[at:])
	out[at] = notice
	if err := validHistory(out); err != nil {
		return nil, err
	}
	return out, nil
}

func verifiedRouterOrigin(m Message, rows []superEventRow, c Config) bool {
	first, _, ok := strings.Cut(m.Content, "\n")
	if !ok {
		return false
	}
	var envelope struct {
		Notice string            `json:"notice"`
		Events []SuperObjectPage `json:"events"`
	}
	if json.Unmarshal([]byte(first), &envelope) != nil || envelope.Notice != routerContextNotice {
		return false
	}
	for _, row := range rows {
		// Failed or unconsumed Router turns remain protected input. A later
		// request must not hide their constraints or pending decisions.
		if row.Disposition != "routed" {
			continue
		}
		if !strings.HasSuffix(m.Content, "[USER_MESSAGE]\n"+redact(routerUserPreview(row.Payload), c)) {
			continue
		}
		for _, page := range envelope.Events {
			if page.Kind == "event" && page.ID == row.ID {
				return true
			}
		}
	}
	return false
}

func (e *Engine) pilotRequestHistory(ctx context.Context, s *session, c Config, h []Message) ([]Message, error) {
	s.mu.Lock()
	id, turn := s.state.View.Session, s.state.View.RootTurnID
	s.mu.Unlock()
	return e.BuildPilotWorkingSet(ctx, id, c, h, turn)
}
