package web

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestADKRuntimeUsesLakeToolsAndCards(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)

	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !strings.Contains(jsonText(req), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 测试会话", nil)
			return
		}
		switch step.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "adk-list-assets", Name: "list_assets", Arguments: `{"pattern":""}`}})
		default:
			emitModel(w, "ADK 完成", nil)
		}
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "用 ADK 列出资源"}, 202)

	view := waitAI(t, b, id, "completed")
	foundMessage, foundOperation := false, false
	for _, card := range view.Cards {
		if card.Type == "message" && strings.Contains(card.Content, "ADK 完成") {
			foundMessage = true
		}
		if card.Type == "operation" && card.Title == "list_assets" {
			foundOperation = true
		}
	}
	if !foundMessage {
		t.Fatalf("ADK final message missing: %s", jsonText(view))
	}
	if !foundOperation {
		t.Fatalf("Lake tool operation card missing: %s", jsonText(view))
	}
}

func TestADKRuntimeWriteUsesADKGateApproval(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	target := filepath.Join(t.TempDir(), "adk-approved.txt")

	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !strings.Contains(jsonText(req), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 测试会话", nil)
			return
		}
		switch step.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{
				ID:        "adk-write",
				Name:      "write",
				Arguments: jsonText(Object{"path": target, "content": "adk approved", "runtime": "local"}),
			}})
		default:
			emitModel(w, "ADK 写入完成", nil)
		}
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "用 ADK 写文件"}, 202)

	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil || view.Pending.Call.Name != "write" {
		t.Fatalf("pending = %#v", view.Pending)
	}
	if !strings.HasPrefix(view.Pending.ID, "adk-") {
		t.Fatalf("approval did not come from the ADK gate: %#v", view.Pending)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("file was created before approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": true}, 200)
	view = waitAI(t, b, id, "completed")
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "adk approved" {
		t.Fatalf("approved file content = %q err=%v", content, err)
	}
	found := false
	for _, card := range view.Cards {
		if card.Type == "message" && strings.Contains(card.Content, "ADK 写入完成") {
			found = true
		}
	}
	if !found {
		t.Fatalf("final ADK message missing: %s", jsonText(view))
	}
	evidence, err := os.ReadFile(filepath.Join(b.options.DataDir, "adk", id, "evidence.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"approval_requested", "approved", "started", "completed"} {
		if !strings.Contains(string(evidence), `"status":"`+status+`"`) {
			t.Fatalf("ADK gate evidence missing %s: %s", status, evidence)
		}
	}
}

func TestADKRuntimeAbortStopsPendingQuestion(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)

	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !strings.Contains(jsonText(req), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 测试会话", nil)
			return
		}
		if step.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{
				ID:        "adk-question",
				Name:      "ask_user_question",
				Arguments: `{"questions":[{"id":"q1","title":"Continue?"}]}`,
			}})
			return
		}
		emitModel(w, "不应到达", nil)
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "用 ADK 提问"}, 202)

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		view, err := b.Engine.Snapshot(id)
		if err != nil {
			t.Fatal(err)
		}
		if view.Question != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
	waitAI(t, b, id, "cancelled")
}

func TestADKRuntimeSRECatalogUsesCoordinationTools(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	b.Store.SetSREEnabled(project, true)
	b.configure(session, nil)

	catalog, prompt, err := b.Engine.RuntimeCapabilities(context.Background(), session, true)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tool := range catalog {
		names[tool.Name] = true
	}
	if !names["sre_collaborate"] || !names["sre_reply"] {
		t.Fatalf("SRE coordination tools missing: %v", names)
	}
	if names["shell"] || names["write"] {
		t.Fatalf("SRE coordinator can bypass specialists: %v", names)
	}
	if !strings.Contains(prompt, "SRE collaboration coordinator") {
		t.Fatalf("SRE coordination prompt missing: %s", prompt[:min(len(prompt), 200)])
	}
}

func TestADKRuntimeSREReplyUsesFormalText(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	b.Store.SetSREEnabled(project, true)
	if !b.Store.SREEnabled(project) {
		t.Fatal("SRE setting was not enabled")
	}

	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		body := jsonText(req)
		if !strings.Contains(body, "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 测试会话", nil)
			return
		}
		if strings.Contains(body, `"sre_reply"`) && step.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{
				ID:        "adk-sre-reply",
				Name:      "sre_reply",
				Arguments: `{"kind":"answer","text":"正式答复"}`,
			}})
			return
		}
		emitModel(w, "临时文本", nil)
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "直接回答"}, 202)

	view := waitAI(t, b, session, "completed")
	foundFormal, foundProvisional := false, false
	for _, card := range view.Cards {
		if card.Type == "message" && strings.Contains(card.Content, "正式答复") {
			foundFormal = true
		}
		if card.Type == "message" && strings.Contains(card.Content, "临时文本") {
			foundProvisional = true
		}
	}
	if !foundFormal || foundProvisional {
		t.Fatalf("formal SRE reply not installed: %s", jsonText(view))
	}
}

func TestADKRuntimeSRECollaborateHandsOffToLakeEngine(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	b.Store.SetSREEnabled(project, true)
	alias := sreAliasForTest(resource)
	plan := ai.SREPlanRevision{
		Goal:     "检查本机",
		TaskType: "investigation",
		Scope:    []string{resource},
		Steps: []ai.SREPlanStep{{
			ID:               "inspect",
			Role:             ai.SREInvestigator,
			Kind:             "observe",
			Capability:       "host",
			Description:      "检查目标主机",
			ResourceIDs:      []string{resource},
			CompletionChecks: []string{"取得新证据"},
		}},
	}

	var adkCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		body := jsonText(req)
		if strings.Contains(body, "LAKE_SESSION_CONTEXT") {
			if adkCalls.Add(1) == 1 {
				emitModel(w, "", []ai.Call{{
					ID:        "adk-collaborate",
					Name:      "sre_collaborate",
					Arguments: jsonText(Object{"action": "new_task", "goal": plan.Goal, "asset_refs": []string{alias}, "mode": "plan_only"}),
				}})
				return
			}
			emitModel(w, "计划已提交", nil)
			return
		}
		if strings.Contains(body, "Return only a JSON plan object") {
			emitModel(w, jsonText(plan), nil)
			return
		}
		emitModel(w, "SRE fixture", nil)
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "检查本机并只出计划"}, 202)

	deadline := time.Now().Add(8 * time.Second)
	var tasks []ai.SRETask
	for time.Now().Before(deadline) {
		tasks, _ = b.Store.ListSRETasks(session, 20, "")
		if len(tasks) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(tasks) == 0 {
		t.Fatal("ADK sre_collaborate did not create a Lake SRE task")
	}
}

func TestADKRuntimeAcceptsImageInput(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)

	pngBytes, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}
	var sawImage atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		body := jsonText(req)
		if !strings.Contains(body, "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 图片会话", nil)
			return
		}
		if strings.Contains(body, "image_url") && strings.Contains(body, "data:image/png") {
			sawImage.Store(true)
		}
		emitModel(w, "收到图片", nil)
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "image-adk-fixture", "supportsImageInput": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	image := Object{"id": "adk-image", "name": "image.png", "mimeType": "image/png", "base64": base64.StdEncoding.EncodeToString(pngBytes)}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "看看这张图", "images": []any{image}}, 202)

	view := waitAI(t, b, id, "completed")
	if !sawImage.Load() {
		t.Fatalf("ADK provider request did not include the image: %s", jsonText(view))
	}
	found := false
	for _, card := range view.Cards {
		if card.Type == "message" && strings.Contains(card.Content, "收到图片") {
			found = true
		}
	}
	if !found {
		t.Fatalf("ADK image response missing: %s", jsonText(view))
	}
}

func TestADKRuntimeWriteRejectionDoesNotExecute(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	target := filepath.Join(t.TempDir(), "adk-rejected.txt")

	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !strings.Contains(jsonText(req), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 测试会话", nil)
			return
		}
		if step.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{
				ID:        "adk-reject-write",
				Name:      "write",
				Arguments: jsonText(Object{"path": target, "content": "should not exist", "runtime": "local"}),
			}})
			return
		}
		emitModel(w, "操作未执行", nil)
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "用 ADK 写文件"}, 202)

	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil {
		t.Fatal("missing pending approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
	waitAI(t, b, id, "completed")
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("file was created after rejection")
	}
}

func TestADKRuntimeAbortWhileApprovalPending(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	allowFixtureHost(b, id)
	target := filepath.Join(t.TempDir(), "adk-aborted.txt")

	var step atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Object
		_ = json.NewDecoder(r.Body).Decode(&req)
		if !strings.Contains(jsonText(req), "LAKE_SESSION_CONTEXT") {
			emitModel(w, "ADK 测试会话", nil)
			return
		}
		if step.Add(1) == 1 {
			emitModel(w, "", []ai.Call{{
				ID:        "adk-abort-write",
				Name:      "write",
				Arguments: jsonText(Object{"path": target, "content": "should not exist", "runtime": "local"}),
			}})
			return
		}
		emitModel(w, "不应到达", nil)
	}))
	defer provider.Close()

	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL + "/v1/chat/completions", "name": "fixture", "apiKey": nil}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"agentRuntime": "adk"}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "用 ADK 写文件"}, 202)

	view := waitAI(t, b, id, "waiting_approval")
	if view.Pending == nil {
		t.Fatal("missing pending approval")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
	waitAI(t, b, id, "cancelled")
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("file was created after abort")
	}
}
