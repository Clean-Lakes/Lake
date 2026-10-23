package web

import (
	"encoding/json"
	"strings"
	"unicode"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"golang.org/x/text/unicode/norm"
)

func memoryReferenceText(text string) string { return strings.ToLower(norm.NFKC.String(text)) }

func memoryMentionsKey(text, key string) bool {
	text, key = memoryReferenceText(text), memoryReferenceText(key)
	if key == "" {
		return false
	}
	identifier := func(b byte) bool { return b >= 'a' && b <= 'z' || b >= '0' && b <= '9' || b == '-' || b == '_' }
	for offset := 0; offset < len(text); {
		at := strings.Index(text[offset:], key)
		if at < 0 {
			return false
		}
		at += offset
		end := at + len(key)
		if (at == 0 || !identifier(text[at-1])) && (end == len(text) || !identifier(text[end])) {
			return true
		}
		offset = end
	}
	return false
}

// Reads performed during the deletion request cannot create consent. Only
// successful results paired with their actual calls in the previous turn count.
func previousMemoryReferences(history []ai.Message, saveOnly bool, retryTurns int) []Object {
	end, start := -1, -1
	for i := len(history) - 1; i >= 0; i-- {
		if history[i].Role == "user" {
			if end < 0 {
				end = i
			} else {
				start = i
				break
			}
		}
	}
	if start < 0 {
		return nil
	}
	refs := memoryReferencesInTurn(history[start+1:end], saveOnly)
	if len(refs) > 0 || retryTurns <= 0 {
		return refs
	}
	// Only the caller's real user-message ledger can identify a contiguous
	// deletion retry. Never jump over an unrelated turn or a completed delete.
	for _, message := range history[start+1 : end] {
		if message.Role == "tool" && message.Name == "forget_project_memory" {
			var result Object
			if json.Unmarshal([]byte(message.Content), &result) == nil && result["deleted"] == true {
				return nil
			}
		}
	}
	return previousMemoryReferences(history[:end], saveOnly, retryTurns-1)
}

func memoryReferencesInTurn(history []ai.Message, saveOnly bool) []Object {
	calls := map[string]string{}
	refs := map[string]Object{}
	for _, message := range history {
		if message.Role == "assistant" {
			for _, call := range message.Calls {
				calls[call.ID] = call.Name
			}
		}
		if message.Role != "tool" || calls[message.CallID] != message.Name {
			continue
		}
		if message.Name != "save_project_memory" && (saveOnly || message.Name != "read_project_memory") {
			continue
		}
		var payload Object
		if json.Unmarshal([]byte(message.Content), &payload) != nil || payload["error"] != nil || payload["deleted"] == true {
			continue
		}
		key := stringOf(payload["key"])
		if key == "" || integer(payload["revision"]) < 1 {
			continue
		}
		if message.Name == "read_project_memory" {
			if _, ok := payload["body"].(string); !ok {
				continue
			}
		}
		payload["operation"] = message.Name
		refs[key] = payload
	}
	out := []Object{}
	for _, ref := range refs {
		out = append(out, ref)
	}
	return out
}

// A topic only narrows a proven reference. It never searches arbitrary memories
// and cannot authorize deletion by itself.
func memoryReferenceTopicMatches(text, description, key string) bool {
	text = memoryReferenceText(text)
	for _, phrase := range []string{"请忘记", "忘记", "请删除记忆", "删除记忆", "forget ", "just saved", "just read", "that memory", "刚才保存的", "刚刚保存的", "刚保存的", "刚才记住的", "刚刚记住的", "刚才记下的", "刚刚记下的", "刚才读取的", "刚刚读取的", "刚才", "刚刚", "上一条", "这条", "那条", "项目记忆", "记忆", "约定", "记录"} {
		text = strings.ReplaceAll(text, phrase, "")
	}
	tokens := map[string]bool{}
	var han rune
	var latin strings.Builder
	flush := func() {
		if latin.Len() > 0 {
			tokens[latin.String()] = true
			latin.Reset()
		}
	}
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			flush()
			if han != 0 {
				tokens[string([]rune{han, r})] = true
			}
			han = r
			continue
		}
		han = 0
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			latin.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	if len(tokens) == 0 {
		return strings.Trim(text, " \t\r\n。.!！,，:：;；\"“”") == ""
	}
	if len(tokens) > 64 {
		return false
	}
	matched := 0
	haystack := memoryReferenceText(description + " " + key)
	for token := range tokens {
		if strings.Contains(haystack, token) {
			matched++
		}
	}
	if len(tokens) == 1 {
		for token := range tokens {
			return len([]rune(token)) >= 4 && matched == 1
		}
	}
	// Require two pairs and at least 40% of the short topic, e.g. 发布 + 方案
	// in 发布方案格式. A single generic overlap cannot authorize deletion.
	return matched >= 2 && matched*5 >= len(tokens)*2
}

func (s *Store) identifiesMemoryToForget(project, userText, key string, history []ai.Message, retryTurns ...int) bool {
	return s.read(func() any {
		rows, _ := s.listMemoryRows(project)
		if memoryMentionsKey(userText, key) {
			return true
		}
		titles := []string{}
		for _, row := range rows {
			description := stringOf(row["description"])
			if description != "" && strings.Contains(memoryReferenceText(userText), memoryReferenceText(description)) {
				titles = append(titles, stringOf(row["key"]))
			}
		}
		if len(titles) > 0 {
			return len(titles) == 1 && titles[0] == key
		}
		deictic := false
		for _, word := range []string{"刚才", "刚刚", "这条", "那条", "上一条", "just saved", "just read", "that memory"} {
			deictic = deictic || strings.Contains(memoryReferenceText(userText), word)
		}
		if !deictic {
			return false
		}
		saveOnly := strings.Contains(userText, "保存") || strings.Contains(userText, "记住") || strings.Contains(userText, "记下") || strings.Contains(memoryReferenceText(userText), "just saved")
		matches := map[string]bool{}
		retries := 0
		if len(retryTurns) > 0 {
			retries = min(3, max(0, retryTurns[0]))
		}
		for _, ref := range previousMemoryReferences(history, saveOnly, retries) {
			for _, row := range rows {
				if ref["key"] != row["key"] || integer(ref["revision"]) != integer(row["revision"]) {
					continue
				}
				if ref["operation"] == "read_project_memory" {
					if ref["projectId"] != project {
						continue
					}
				} else {
					commit := s.row("SELECT revision,mutationKeysJSON FROM projectMemoryCommits WHERE projectId=? AND commitId=?", project, stringOf(ref["commitId"]))
					if commit == nil || integer(commit["revision"]) != integer(row["projectRevision"]) || !containsMemorySource(stringsOf(parsed(stringOf(commit["mutationKeysJSON"]))), stringOf(row["key"])) {
						continue
					}
				}
				if memoryReferenceTopicMatches(userText, stringOf(row["description"]), stringOf(row["key"])) {
					matches[stringOf(row["key"])] = true
				}
			}
		}
		return len(matches) == 1 && matches[key]
	}).(bool)
}

func memoryForgetRetryTurns(messages []Object) int {
	skippedCurrent, retries := false, 0
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i]["role"] != "user" {
			continue
		}
		if !skippedCurrent {
			skippedCurrent = true
			continue
		}
		if !directMemoryIntent(stringOf(messages[i]["text"]), "forget") || retries >= 3 {
			break
		}
		retries++
	}
	return retries
}
