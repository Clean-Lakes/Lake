package web

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func memoryQueryInt(r *http.Request, key string, fallback int) int {
	value := r.URL.Query().Get(key)
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		fail(400, "Invalid memory pagination")
	}
	return n
}

func memoryBool(value any, key string) bool {
	b, ok := value.(bool)
	if !ok {
		fail(400, "Invalid "+key)
	}
	return b
}

func memoryRevision(value any) int {
	n := integer(value)
	if _, ok := value.(float64); !ok {
		fail(400, "Invalid memory revision")
	}
	if float64(n) != number(value) || n < 0 {
		fail(400, "Invalid memory revision")
	}
	return n
}

func memoryFields(data Object, allowed ...string) {
	keys := map[string]bool{}
	for _, key := range allowed {
		keys[key] = true
	}
	for key := range data {
		if !keys[key] {
			fail(400, "Unknown memory field")
		}
	}
}

func (b *Server) projectMemoryRoute(w http.ResponseWriter, r *http.Request, name, method string) bool {
	parts := strings.Split(strings.Trim(name, "/"), "/")
	if len(parts) < 4 || parts[0] != "api" || parts[1] != "projects" || !workflowIdentifier.MatchString(parts[2]) {
		return false
	}
	project := parts[2]
	if len(parts) == 4 && parts[3] == "memory" {
		if method != "GET" {
			fail(405, "Method not allowed")
		}
		includeExpired := r.URL.Query().Get("includeExpired") == "true"
		includeDeleted := r.URL.Query().Get("includeDeleted") == "true"
		reply(w, 200, b.Store.ListProjectMemories(project, r.URL.Query().Get("query"), memoryQueryInt(r, "offset", 0), memoryQueryInt(r, "limit", 50), includeExpired, includeDeleted))
		return true
	}
	if len(parts) == 4 && parts[3] == "memory-settings" {
		switch method {
		case "GET":
			reply(w, 200, b.Store.MemorySettings(project))
		case "PATCH":
			data := body(w, r, 4096)
			memoryFields(data, "useEnabled", "extractionEnabled", "expectedRevision")
			reply(w, 200, b.Store.SetMemorySettings(project, memoryBool(data["useEnabled"], "useEnabled"), memoryBool(data["extractionEnabled"], "extractionEnabled"), memoryRevision(data["expectedRevision"])))
		default:
			fail(405, "Method not allowed")
		}
		return true
	}
	if len(parts) == 5 && parts[3] == "memory" {
		key := parts[4]
		switch method {
		case "GET":
			reply(w, 200, b.Store.ReadProjectMemory(project, key, r.URL.Query().Get("includeDeleted") == "true"))
		case "PUT":
			data := body(w, r, 32*1024)
			memoryFields(data, "type", "description", "body", "expectedRevision", "restoreDeleted", "validUntil")
			model := b.Models.Active()
			if model == nil {
				model = &ai.Model{}
			}
			if b.Terminals.containsCredential(stringOf(data["body"])) || b.Terminals.containsCredential(stringOf(data["description"])) || !ai.SafeMemoryContent(stringOf(data["body"]), *model) || !ai.SafeMemoryContent(stringOf(data["description"]), *model) {
				fail(400, "Credentials cannot be saved in project memory")
			}
			validUntil := ""
			if data["validUntil"] != nil {
				v, ok := data["validUntil"].(string)
				if !ok {
					fail(400, "Invalid memory expiration")
				}
				validUntil = v
			}
			restore := false
			if data["restoreDeleted"] != nil {
				restore = memoryBool(data["restoreDeleted"], "restoreDeleted")
			}
			reply(w, 200, b.Store.CommitProjectMemory(project, MemoryMutation{Key: key, Type: text(data["type"], "type", 20), Description: text(data["description"], "description", 160), Body: text(data["body"], "body", 16384), ExpectedRevision: memoryRevision(data["expectedRevision"]), RestoreDeleted: restore, ValidUntil: validUntil, Verification: "user-stated", SourceKind: "manual-ui"}))
		case "DELETE":
			data := body(w, r, 4096)
			memoryFields(data, "expectedRevision")
			reply(w, 200, b.Store.CommitProjectMemory(project, MemoryMutation{Key: key, ExpectedRevision: memoryRevision(data["expectedRevision"]), SourceKind: "manual-ui", Forget: true}))
		default:
			fail(405, "Method not allowed")
		}
		return true
	}
	if len(parts) == 4 && parts[3] == "memory-jobs" && method == "GET" {
		b.Store.Project(project)
		jobs := b.Store.read(func() any {
			return b.Store.rows("SELECT j.jobId,j.status,j.attempts,j.lastErrorCode,j.usageJSON,j.createdAt,j.updatedAt FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.projectId=? ORDER BY j.createdAt DESC LIMIT ? OFFSET ?", project, memoryQueryInt(r, "limit", 50), memoryQueryInt(r, "offset", 0))
		}).([]Object)
		reply(w, 200, Object{"items": jobs})
		return true
	}
	if len(parts) == 6 && parts[3] == "memory-jobs" && parts[5] == "retry" {
		if method != "POST" {
			fail(405, "Method not allowed")
		}
		if !workflowIdentifier.MatchString(parts[4]) {
			fail(400, "Invalid memory job")
		}
		data := body(w, r, 4096)
		memoryFields(data, "expectedProjectRevision")
		reply(w, 200, b.Store.RetryMemoryJob(project, parts[4], memoryRevision(data["expectedProjectRevision"])))
		return true
	}
	return false
}
