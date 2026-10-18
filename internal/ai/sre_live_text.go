package ai

import (
	"encoding/json"
	"strings"
)

// Publish presentation state without rewriting the task, its messages and its
// operation ledger for every packet. The final history/report remains durable.
// Called with the child lock held; it must never call back into the child.
func (e *Engine) updateSRELiveText(s *session, runID, textID, content string) {
	text := sreLiveProse(content)
	if text == "" {
		return
	}
	s.mu.Lock()
	text = redact(text, s.state.Config)
	changed := false
	sessionID := s.state.View.Session
	for i := range s.state.View.AgentRuns {
		r := &s.state.View.AgentRuns[i]
		if r.ID == runID && r.Status == "running" {
			if textID == "" {
				textID = r.LiveTextID
			}
			changed = r.LiveText != text || r.LiveTextID != textID
			r.LiveText, r.LiveTextID = text, textID
			break
		}
	}
	s.mu.Unlock()
	if changed && e.Emit != nil {
		e.Emit(Event{Session: sessionID, Type: "sreUpdate", Data: map[string]any{"target": "agent", "id": runID, "textId": textID, "content": text}})
	}
}

// Investigator reports stream as JSON. Expose only the summary string, never
// the partial JSON envelope, evidence identifiers or unfinished fact fields.
func sreLiveProse(content string) string {
	trimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "```json") && !strings.HasPrefix(trimmed, "```\n{") {
		return content
	}
	trimmed = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "```json"), "```"))
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return ""
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return ""
		}
		if key != "summary" {
			var skip json.RawMessage
			if decoder.Decode(&skip) != nil {
				return ""
			}
			continue
		}
		suffix := strings.TrimSpace(trimmed[decoder.InputOffset():])
		suffix = strings.TrimSpace(strings.TrimPrefix(suffix, ":"))
		if !strings.HasPrefix(suffix, "\"") {
			return ""
		}
		var text string
		if json.NewDecoder(strings.NewReader(suffix)).Decode(&text) == nil {
			return text
		}
		// Complete only the string delimiter for decoding a presentation prefix.
		// Drop an incomplete escape; the next packet will supply its suffix.
		end := len(suffix)
		for i := 1; i < len(suffix); i++ {
			if suffix[i] != '\\' {
				continue
			}
			if i+1 == len(suffix) || suffix[i+1] == 'u' && i+6 > len(suffix) {
				end = i
				break
			}
			i++
		}
		if err = json.Unmarshal([]byte(suffix[:end]+"\""), &text); err != nil {
			return ""
		}
		return text
	}
	return ""
}
