package web

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type memoryReadLedger struct {
	mu    sync.Mutex
	bytes int
	pages map[string]string
}

func (b *Server) chargeMemoryList(scope memoryReadScope, id string, args, result Object) (Object, error) {
	value, _ := b.memoryReads.LoadOrStore(id+":"+scope.TurnID, &memoryReadLedger{pages: map[string]string{}})
	ledger := value.(*memoryReadLedger)
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	key := "list:" + memoryHash(Object{"args": args, "resources": scope.ResourceIDs, "revision": result["projectRevision"]})
	if access := ledger.pages[key]; access != "" {
		return Object{"reason": "already_read", "accessId": access}, nil
	}
	cost := len(jsonText(result))
	if ledger.bytes+cost > min(16384, max(0, scope.InputBudget*2/10)) {
		return nil, errors.New("memory_budget_exhausted")
	}
	ledger.bytes += cost
	ledger.pages[key] = ident()
	return result, nil
}

func memoryDetailsFrom(data Object) *MemoryDetails {
	for _, field := range []string{"knowledgeKind", "scopeKind", "factKey", "reviewState"} {
		if value, ok := data[field]; ok {
			if _, ok := value.(string); !ok {
				fail(400, "Invalid memory classification field")
			}
		}
	}
	if value, ok := data["subject"]; ok {
		if _, ok := value.(map[string]any); !ok {
			fail(400, "Invalid memory subject")
		}
	}
	if value, ok := data["resourceIds"]; ok {
		switch values := value.(type) {
		case []any:
			for _, v := range values {
				if _, ok := v.(string); !ok {
					fail(400, "Invalid memory resources")
				}
			}
		case []string:
		default:
			fail(400, "Invalid memory resources")
		}
	}
	if value, ok := data["alwaysReference"]; ok {
		memoryBool(value, "alwaysReference")
	}
	return &MemoryDetails{KnowledgeKind: stringOf(data["knowledgeKind"]), ScopeKind: stringOf(data["scopeKind"]), ResourceIDs: stringsOf(data["resourceIds"]), Subject: object(data["subject"]), FactKey: stringOf(data["factKey"]), AlwaysReference: data["alwaysReference"] == true, ReviewState: stringOf(data["reviewState"])}
}

func (b *Server) memoryV2Read(ctx context.Context, id, name string, args Object) (any, error) {
	scope, err := b.ResolveMemoryReadScope(id)
	if err != nil {
		return nil, err
	}
	switch name {
	case "project_memory_index":
		messages := objects(b.Store.Snapshot(id)["messages"])
		query := memoryRunePrefix(latestRealUserText(messages), 2048)
		users := []string{}
		for _, m := range messages {
			if m["role"] == "user" {
				users = append(users, stringOf(m["text"]))
			}
		}
		if len(users) > 1 {
			query += " " + memoryRunePrefix(users[len(users)-2], 512)
		}
		model := b.Models.Active()
		if model == nil {
			model = &ai.Model{}
		}
		if b.Terminals.containsCredential(query) || !ai.SafeMemoryContent(query, *model) {
			query = ""
		}
		budget := integer(args["maxBytes"])
		if budget == 0 {
			budget = 3072
		}
		return b.Store.BuildScopedMemoryIndex(scope, query, budget), nil
	case "list_project_memories":
		memoryFields(args, "query", "offset", "limit", "includeHistory")
		model := b.Models.Active()
		if model == nil {
			model = &ai.Model{}
		}
		if b.Terminals.containsCredential(stringOf(args["query"])) || !ai.SafeMemoryContent(stringOf(args["query"]), *model) {
			return nil, errors.New("unsafe_memory_query")
		}
		limit := integer(args["limit"])
		if limit == 0 {
			limit = 20
		}
		result := b.Store.scopedMemoryList(scope, stringOf(args["query"]), integer(args["offset"]), limit, args["includeHistory"] == true)
		summaries := []Object{}
		for _, entry := range memoryObjects(result["items"]) {
			summary := Object{}
			for _, field := range []string{"key", "revision", "type", "knowledgeKind", "scopeKind", "eligibility", "historical", "observedAt", "validUntil"} {
				summary[field] = entry[field]
			}
			summary["description"] = memoryRunePrefix(stringOf(entry["description"]), 80)
			if len(jsonText(append(summaries, summary))) > 3700 {
				break
			}
			summaries = append(summaries, summary)
		}
		result["items"], result["historyRead"] = summaries, args["includeHistory"] == true
		if integer(result["total"]) > integer(args["offset"])+len(summaries) {
			result["nextOffset"] = integer(args["offset"]) + len(summaries)
		}
		return b.chargeMemoryList(scope, id, args, result)
	case "read_project_memory":
		memoryFields(args, "key", "offsetLine", "byteOffset", "limitLines", "expectedRevision", "includeHistory")
		entry := b.Store.scopedMemoryRead(scope, stringOf(args["key"]), args["includeHistory"] == true)
		if _, ok := args["expectedRevision"]; !ok {
			delete(entry, "body")
			delete(entry, "sources")
			entry["reason"] = "revision_required"
			return entry, nil
		}
		if memoryRevision(args["expectedRevision"]) != integer(entry["revision"]) {
			return nil, errors.New("memory_revision_conflict")
		}
		body, ok := entry["body"].(string)
		if !ok {
			return entry, nil
		}
		entry["historyRead"] = args["includeHistory"] == true
		offset, byteOffset, limit := integer(args["offsetLine"]), integer(args["byteOffset"]), integer(args["limitLines"])
		if limit == 0 {
			limit = 200
		}
		if limit < 1 || limit > 200 {
			return nil, errors.New("invalid_memory_page")
		}
		page, nextLine, nextByte, more, err := memoryBodyPage(body, offset, byteOffset, limit)
		if err != nil {
			return nil, err
		}
		ledgerKey := id + ":" + scope.TurnID
		value, _ := b.memoryReads.LoadOrStore(ledgerKey, &memoryReadLedger{pages: map[string]string{}})
		ledger := value.(*memoryReadLedger)
		ledger.mu.Lock()
		defer ledger.mu.Unlock()
		pageKey := fmt.Sprintf("%s:%d:%d:%d:%s", entry["key"], integer(entry["revision"]), offset, byteOffset, memoryHash(scope.ResourceIDs))
		if accessID := ledger.pages[pageKey]; accessID != "" {
			return Object{"reason": "already_read", "accessId": accessID}, nil
		}
		entry["body"], entry["truncated"] = page, more
		if more {
			entry["nextLine"], entry["nextByteOffset"] = nextLine, nextByte
		}
		budget := min(16384, max(0, scope.InputBudget*2/10))
		cost := len(jsonText(entry))
		for ledger.bytes+cost > budget {
			if len(page) < 4 {
				return nil, errors.New("memory_budget_exhausted")
			}
			page, nextLine, nextByte, more, err = memoryBodyPageLimit(body, offset, byteOffset, limit, len(page)/2)
			if err != nil {
				return nil, errors.New("memory_budget_exhausted")
			}
			entry["body"], entry["truncated"] = page, more
			if more {
				entry["nextLine"], entry["nextByteOffset"] = nextLine, nextByte
			}
			cost = len(jsonText(entry))
		}
		ledger.bytes += cost
		ledger.pages[pageKey] = ident()
		if err := b.Engine.RecordMemoryAccess(id, []ai.MemoryAccess{{Key: stringOf(entry["key"]), Revision: integer(entry["revision"]), Kind: "read", ObservedAt: stringOf(entry["observedAt"]), Historical: entry["historical"] == true || entry["eligibility"] != "eligible", OffsetLine: offset, ByteOffset: byteOffset, BytesRead: len(page)}}, scope.TurnID); err != nil {
			return nil, err
		}
		return entry, nil
	}
	return nil, errors.New("unknown memory read")
}

func (b *Server) validateMemoryToolDetails(id string, args Object) *MemoryDetails {
	memoryFields(args, "key", "type", "description", "body", "expectedRevision", "restoreDeleted", "knowledgeKind", "scopeKind", "resourceIds", "subject", "factKey")
	d := memoryDetailsFrom(args)
	scope, err := b.ResolveMemoryReadScope(id)
	must(err)
	allowed := map[string]bool{}
	for _, ref := range scope.ResourceIDs {
		allowed[ref] = true
	}
	for index, ref := range d.ResourceIDs {
		if !allowed[ref] {
			for id := range allowed {
				if ai.AssetAlias(id) == ref {
					d.ResourceIDs[index] = id
					ref = id
					break
				}
			}
		}
		if !allowed[ref] {
			fail(403, "Memory scope exceeds current target")
		}
	}
	if strings.TrimSpace(d.ScopeKind) == "" {
		fail(422, "scope_required")
	}
	return d
}
