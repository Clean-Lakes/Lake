package web

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func ignoreMemoryPhrase(userText string) bool {
	text := strings.TrimSpace(userText)
	for _, phrase := range []string{"本轮不要使用项目记忆", "这次忽略项目记忆", "Do not use project memory this turn"} {
		if strings.HasPrefix(text, phrase) {
			rest := strings.TrimPrefix(text, phrase)
			if strings.TrimSpace(rest) == "" || strings.HasPrefix(rest, "。") || strings.HasPrefix(rest, ".") || strings.HasPrefix(rest, "\n") {
				return true
			}
		}
	}
	return false
}

func directMemoryIntent(userText, operation string) bool {
	text := strings.TrimSpace(userText)
	if text == "" || strings.HasPrefix(text, "\"") || strings.HasPrefix(text, "“") || strings.HasPrefix(text, ">") {
		return false
	}
	if operation == "save" {
		for _, prefix := range []string{"记住", "请记住", "记一下", "请记一下", "以后每次", "以后都", "请以后每次", "Remember ", "remember "} {
			if strings.HasPrefix(text, prefix) {
				return true
			}
		}
	} else {
		for _, prefix := range []string{"忘记", "请忘记", "删除记忆", "请删除记忆", "Forget ", "forget "} {
			if strings.HasPrefix(text, prefix) {
				return true
			}
		}
	}
	return false
}

func latestRealUserText(messages []Object) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i]["role"] == "user" {
			return stringOf(messages[i]["text"])
		}
	}
	return ""
}

func memoryBodyPage(body string, offsetLine, byteOffset, limitLines int) (string, int, int, bool, error) {
	lines := strings.SplitAfter(body, "\n")
	if offsetLine < 0 || offsetLine >= len(lines) || byteOffset < 0 || byteOffset > len(lines[offsetLine]) || !utf8.ValidString(lines[offsetLine][byteOffset:]) {
		return "", 0, 0, false, errors.New("invalid_memory_page")
	}
	var out strings.Builder
	for line := offsetLine; line < len(lines) && line < offsetLine+limitLines; line++ {
		start := 0
		if line == offsetLine {
			start = byteOffset
		}
		remaining := lines[line][start:]
		room := 4096 - out.Len()
		if room == 0 && len(remaining) > 0 {
			return out.String(), line, start, true, nil
		}
		if len(remaining) > room {
			cut := room
			for cut > 0 && !utf8.ValidString(remaining[:cut]) {
				cut--
			}
			if cut == 0 {
				return "", 0, 0, false, errors.New("memory_page_too_small")
			}
			out.WriteString(remaining[:cut])
			return out.String(), line, start + cut, true, nil
		}
		out.WriteString(remaining)
		if line+1 >= len(lines) {
			return out.String(), 0, 0, false, nil
		}
	}
	next := offsetLine + limitLines
	return out.String(), next, 0, next < len(lines), nil
}

func (b *Server) projectMemoryBridge(ctx context.Context, id, name string, args Object) (any, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	session := b.Store.Session(id)
	project := stringOf(session["projectId"])
	settings := b.Store.MemorySettings(project)
	if settings["useEnabled"] != true {
		return nil, errors.New("project memory disabled")
	}
	if name == "project_memory_index" {
		return Object{"index": b.Store.ProjectMemoryIndex(project), "revision": settings["revision"]}, nil
	}
	if name == "list_project_memories" {
		offset, limit := integer(args["offset"]), integer(args["limit"])
		if limit == 0 {
			limit = 20
		}
		return b.Store.ListProjectMemories(project, stringOf(args["query"]), offset, limit, false, false), nil
	}
	if name == "read_project_memory" {
		entry := b.Store.ReadProjectMemory(project, stringOf(args["key"]), true)
		if value, exists := args["expectedRevision"]; exists && memoryRevision(value) != integer(entry["revision"]) {
			return nil, errors.New("memory_revision_conflict")
		}
		if stringOf(entry["deletedAt"]) != "" {
			return Object{"key": entry["key"], "revision": entry["revision"], "deleted": true}, nil
		}
		if entry["expired"] == true {
			return Object{"key": entry["key"], "revision": entry["revision"], "expired": true, "validUntil": entry["validUntil"]}, nil
		}
		offsetLine, byteOffset, limitLines := 0, 0, 200
		if value, exists := args["offsetLine"]; exists {
			offsetLine = memoryRevision(value)
		}
		if value, exists := args["byteOffset"]; exists {
			byteOffset = memoryRevision(value)
		}
		if value, exists := args["limitLines"]; exists {
			limitLines = memoryRevision(value)
		}
		if limitLines < 1 || limitLines > 200 {
			return nil, errors.New("invalid_memory_page")
		}
		body, nextLine, nextByte, more, err := memoryBodyPage(stringOf(entry["body"]), offsetLine, byteOffset, limitLines)
		if err != nil {
			return nil, err
		}
		entry["body"] = body
		entry["truncated"] = more
		if more {
			entry["nextLine"], entry["nextByteOffset"] = nextLine, nextByte
		}
		return entry, nil
	}
	if name != "save_project_memory" && name != "forget_project_memory" {
		return nil, errors.New("unknown project memory operation")
	}
	snapshot := b.Store.Snapshot(id)
	userText := latestRealUserText(objects(snapshot["messages"]))
	operation := "save"
	if name == "forget_project_memory" {
		operation = "forget"
	}
	if !directMemoryIntent(userText, operation) {
		return nil, errors.New("explicit_memory_intent_required")
	}
	key := stringOf(args["key"])
	view, err := b.Engine.Snapshot(id)
	if err != nil || view.Status != "running" {
		return nil, errors.New("memory tool requires an active user turn")
	}
	if name == "forget_project_memory" {
		entry := b.Store.ReadProjectMemory(project, key, false)
		if !strings.Contains(strings.ToLower(userText), strings.ToLower(key)) && !strings.Contains(userText, stringOf(entry["description"])) {
			return nil, errors.New("memory_to_forget_not_identified")
		}
		return b.Store.CommitProjectMemory(project, MemoryMutation{Key: key, ExpectedRevision: memoryRevision(args["expectedRevision"]), Forget: true, OriginSessionID: id, OriginTurnID: view.RootTurnID, SourceKind: "user"}), nil
	}
	body := stringOf(args["body"])
	model := b.Models.Active()
	if model == nil {
		model = &ai.Model{}
	}
	if b.Terminals.containsCredential(body) || b.Terminals.containsCredential(stringOf(args["description"])) || !ai.SafeMemoryContent(body, *model) || !ai.SafeMemoryContent(stringOf(args["description"]), *model) {
		return nil, errors.New("credentials cannot be saved in project memory")
	}
	restore, _ := args["restoreDeleted"].(bool)
	return b.Store.CommitProjectMemory(project, MemoryMutation{Key: key, Type: stringOf(args["type"]), Description: stringOf(args["description"]), Body: body, ExpectedRevision: memoryRevision(args["expectedRevision"]), RestoreDeleted: restore, Verification: "user-stated", OriginSessionID: id, OriginTurnID: view.RootTurnID, SourceKind: "user"}), nil
}
