package ai

import "encoding/json"

// Revalidate old memory tool payloads before every provider dispatch. Changing
// target or forgetting a key must not make a prior cached tool body bypass the
// same scope/revision checks applied to a new read. Ordinary chat is preserved.
func filterMemoryHistory(history []Message, status map[string]any) {
	current, historical := obj(status["currentRevisions"]), obj(status["historicalRevisions"])
	allowed := func(entry map[string]any, includeHistory bool) bool {
		key := str(entry["key"])
		revision := num(entry["revision"], 0)
		return key != "" && revision > 0 && (num(current[key], 0) == revision || includeHistory && num(historical[key], 0) == revision)
	}
	for i := range history {
		message := &history[i]
		if message.Role != "tool" || (message.Name != "read_project_memory" && message.Name != "list_project_memories") {
			continue
		}
		var payload map[string]any
		valid := json.Unmarshal([]byte(message.Content), &payload) == nil && payload != nil
		if valid && message.Name == "read_project_memory" {
			valid = allowed(payload, payload["historyRead"] == true)
		} else if valid {
			for _, item := range arr(payload["items"]) {
				if !allowed(obj(item), payload["historyRead"] == true) {
					valid = false
					break
				}
			}
		}
		if !valid {
			message.Content = "[Project memory scope, eligibility or revision changed; search again in the current target scope.]"
			message.Native = nil
		}
	}
}
