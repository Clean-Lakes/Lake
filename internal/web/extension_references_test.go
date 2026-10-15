package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	webassets "github.com/Clean-Lakes/Lake/assets/web"
	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/extensions"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func mentionFixture(t *testing.T) (*Server, *httptest.Server, string, *atomic.Int32) {
	t.Helper()
	b, h := fixture(t)
	id, _ := newSession(t, h)
	options := b.Store.Options(id)
	options["silentCommands"] = false
	b.Store.SaveOptions(id, options)
	if err := b.Extensions.Store.SaveSkill("service-check", "---\nname: service-check\ndescription: 检查服务健康\n---\nReport the fixture marker skill-selected-ok.", true); err != nil {
		t.Fatal(err)
	}
	calls := &atomic.Int32{}
	tools := mcp.NewServer(&mcp.Implementation{Name: "Mention fixture", Version: "1"}, nil)
	mcp.AddTool(tools, &mcp.Tool{Name: "echo", Description: "Echo fixture input"}, func(ctx context.Context, req *mcp.CallToolRequest, args struct {
		Text string `json:"text"`
	}) (*mcp.CallToolResult, any, error) {
		calls.Add(1)
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: args.Text}}}, nil, nil
	})
	remote := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return tools }, nil))
	t.Cleanup(remote.Close)
	if err := b.Extensions.Store.SaveServer(extensions.Server{ID: "mention-tools", Name: "团队工具", Transport: "http", URL: remote.URL, Enabled: true, Headers: map[string]string{"Authorization": "Bearer synthetic-mention-secret"}}, true, true); err != nil {
		t.Fatal(err)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			_ = json.NewEncoder(w).Encode(Object{"data": []Object{{"id": "fixture", "context_length": 128000}}})
			return
		}
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		messages := objects(body["messages"])
		last, user := 0, ""
		for i, m := range messages {
			if m["role"] == "user" {
				last, user = i, stringOf(m["content"])
			}
		}
		skillSelected := strings.Contains(user, `"skill_name":"service-check"`)
		mcpSelected := strings.Contains(user, `"server_id":"mention-tools"`)
		completed := 0
		called := false
		for _, m := range messages[last+1:] {
			if m["role"] == "tool" {
				completed++
				called = called || strings.Contains(stringOf(m["content"]), "mention-ok")
			}
		}
		if completed == 0 {
			selected := []ai.Call{}
			if skillSelected {
				selected = append(selected, ai.Call{ID: "selected-skill", Name: "load_skill", Arguments: `{"name":"service-check"}`})
			}
			if mcpSelected {
				selected = append(selected, ai.Call{ID: "selected-tools", Name: "list_mcp_tools", Arguments: `{"server_id":"mention-tools"}`})
			}
			if len(selected) > 0 {
				emitModel(w, "", selected)
				return
			}
		}
		if mcpSelected && completed > 0 && !called {
			emitModel(w, "", []ai.Call{{ID: "selected-call", Name: "call_mcp_tool", Arguments: `{"server_id":"mention-tools","tool":"echo","arguments":{"text":"mention-ok"}}`}})
			return
		}
		emitModel(w, "已验证所选流程与工具。", nil)
	}))
	t.Cleanup(provider.Close)
	b.Models.Save(&ai.Model{URL: provider.URL + "/v1/chat/completions", Name: "fixture", Protocol: "openai", ContextWindow: 128000})
	return b, h, id, calls
}

func TestSelectedExtensionsReachAgentAndRetainMCPApproval(t *testing.T) {
	b, h, id, calls := mentionFixture(t)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "@service-check @团队工具 检查", "references": []Object{{"kind": "skill", "skill_name": "service-check"}, {"kind": "mcp", "server_id": "mention-tools"}}}, 202)
	v := waitAI(t, b, id, "waiting_approval")
	if v.Pending == nil || v.Pending.Kind != "mcp" || v.Pending.Call.Name != "call_mcp_tool" || calls.Load() != 0 {
		t.Fatal("selecting MCP must not authorize its tool call")
	}
	loaded := false
	for _, card := range v.Cards {
		loaded = loaded || strings.Contains(card.Content, "skill-selected-ok")
	}
	if !loaded {
		t.Fatal("selected Skill was not loaded through the real tool")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": v.Pending.ID, "accept": true}, 200)
	waitAI(t, b, id, "completed")
	awaitQueueWorkers(t, b)
	if calls.Load() != 1 {
		t.Fatal("approved selected MCP tool did not run exactly once")
	}
}

func TestExtensionReferencesResolveMetadataAndRejectStaleSelection(t *testing.T) {
	b, h, id, _ := mentionFixture(t)
	refs := b.contextReferences(id, "🔎 @service-check", []any{Object{"kind": "skill", "skill_name": "service-check", "name": "forged", "content": "forged-content", "instruction": "forged-instruction", "start": 3, "end": 17}})
	if len(refs) != 1 || refs[0]["name"] != "service-check" || strings.Contains(jsonText(refs), "forged") {
		t.Fatal("client metadata entered trusted references")
	}
	resource := stringsOf(b.Store.Session(id)["resourceIds"])[0]
	message := b.validateHumanMessage(id, Object{"text": "检查", "resourceIds": []any{resource}, "references": []any{Object{"kind": "mcp", "server_id": "mention-tools", "asset_ref": "forged"}}})
	if len(message.References) != 2 || message.References[1]["asset_ref"] != nil || strings.Contains(jsonText(message.References), "synthetic-mention-secret") {
		t.Fatal("extension selection changed target scope or exposed credentials")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "@service-check", "references": []Object{{"kind": "skill", "skill_name": "service-check", "start": 1, "end": 15}}}, 400)
	if err := b.Extensions.Store.SetSkillEnabled("service-check", false); err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查", "references": []Object{{"kind": "skill", "skill_name": "service-check"}}}, 400)
	if err := b.Extensions.Store.DeleteServer("mention-tools"); err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "检查", "references": []Object{{"kind": "mcp", "server_id": "mention-tools"}}}, 400)
}

func TestQueuedExtensionReferencesSurviveEditingAndRejectDisabledSelection(t *testing.T) {
	b, h, id, _ := mentionFixture(t)
	b.Store.EnqueueMessage(id, Object{"text": "existing"})
	b.Store.MutateMessageQueue(id, Object{"operation": "pause", "revision": b.Store.MessageQueue(id)["revision"]})
	result := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "@service-check 检查", "enqueue": true, "references": []Object{{"kind": "skill", "skill_name": "service-check", "start": 0, "end": 14}}}, 202)
	queue := object(result["messageQueue"])
	items := objects(queue["items"])
	if len(items) != 2 || len(objects(items[1]["references"])) != 1 {
		t.Fatal("queued selected Skill lost its metadata")
	}
	path := "/api/sessions/" + id + "/message-queue"
	queue = apiTest(t, h, "POST", path, Object{"operation": "edit", "revision": queue["revision"], "id": result["queuedMessageId"], "text": "检查", "resourceIds": []string{}, "references": []Object{}}, 200)
	if len(objects(objects(queue["items"])[1]["references"])) != 0 {
		t.Fatal("deleting a queued mention retained the extension")
	}
	if err := b.Extensions.Store.SetSkillEnabled("service-check", false); err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", path, Object{"operation": "edit", "revision": queue["revision"], "id": result["queuedMessageId"], "text": "@service-check", "resourceIds": []string{}, "references": []Object{{"kind": "skill", "skill_name": "service-check"}}}, 400)
}

func TestQueuedExtensionDisabledBeforeDispatchPausesQueue(t *testing.T) {
	b, h, id, calls := mentionFixture(t)
	dummy := b.Store.EnqueueMessage(id, Object{"text": "existing"})
	b.Store.MutateMessageQueue(id, Object{"operation": "pause", "revision": b.Store.MessageQueue(id)["revision"]})
	queued := apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "@service-check 检查", "enqueue": true, "references": []Object{{"kind": "skill", "skill_name": "service-check"}}}, 202)
	queue := b.Store.MutateMessageQueue(id, Object{"operation": "remove", "id": dummy["queuedMessageId"], "revision": object(queued["messageQueue"])["revision"]})
	if err := b.Extensions.Store.SetSkillEnabled("service-check", false); err != nil {
		t.Fatal(err)
	}
	queue = apiTest(t, h, "POST", "/api/sessions/"+id+"/message-queue", Object{"operation": "resume", "revision": queue["revision"]}, 200)
	if queue["paused"] != true || !strings.Contains(stringOf(queue["lastError"]), "Skill") || len(objects(queue["items"])) != 1 || calls.Load() != 0 {
		t.Fatal("a queued disabled extension was dispatched")
	}
}

func TestMentionBrowserFixture(t *testing.T) {
	if os.Getenv("LAKE_MENTION_BROWSER") != "1" {
		t.Skip("manual browser fixture")
	}
	b, h, id, _ := mentionFixture(t)
	b.options.Static = webassets.Files()
	u, _ := url.Parse(h.URL)
	b.options.Port, _ = strconv.Atoi(u.Port())
	t.Logf("MENTION_BROWSER_URL=%s/?session=%s#token=synthetic-test-auth-token", h.URL, id)
	deadline := time.NewTimer(8 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("mention fixture timed out")
		case <-ticker.C:
			if _, err := os.Stat("/tmp/lake-mention-browser.done"); err == nil {
				return
			}
		}
	}
}
