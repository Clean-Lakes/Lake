package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/specialist"
	"github.com/cloudwego/eino/lake/extension/plugins"
	"github.com/cloudwego/eino/lake/operate"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/lake/workflow"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPluginMCPRuntimeLoadsAndRevokesExistingTool(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, _ := store.Open(ctx, root)
	defer s.Close()
	var calls atomic.Int32
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "inspect", Description: "test"}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, struct{}, error) {
		calls.Add(1)
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, struct{}{}, nil
	})
	httpServer := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true}))
	defer httpServer.Close()
	source := t.TempDir()
	os.Mkdir(filepath.Join(source, "mcp"), 0700)
	os.WriteFile(filepath.Join(source, "lake-plugin.json"), []byte(`{"name":"inspect","version":"1.0.0","mcp":["mcp/local.json"]}`), 0600)
	declaration, _ := json.Marshal(map[string]any{"name": "local", "transport": "http", "url": httpServer.URL})
	os.WriteFile(filepath.Join(source, "mcp", "local.json"), declaration, 0600)
	bundle, err := plugins.Inspect(source)
	if err != nil {
		t.Fatal(err)
	}
	manager := plugins.NewManager(root, s)
	if _, err := manager.Install(ctx, source, bundle.Digest); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, "inspect", true); err != nil {
		t.Fatal(err)
	}
	available, cleanup, warnings := loadMCPTools(ctx, root, func(string, string, string) (bool, error) { return true, nil })
	defer cleanup()
	if len(available) != 1 || len(warnings) != 0 {
		t.Fatalf("tools=%d warnings=%v", len(available), warnings)
	}
	if _, err := available[0].(tool.InvokableTool).InvokableRun(ctx, `{}`); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, "inspect", false); err != nil {
		t.Fatal(err)
	}
	if _, err := available[0].(tool.InvokableTool).InvokableRun(ctx, `{}`); err == nil || calls.Load() != 1 {
		t.Fatalf("disabled plugin ran calls=%d err=%v", calls.Load(), err)
	}
}
func TestCustomSpecialistCatalogAndScope(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, _ := store.Open(ctx, root)
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "test", "")
	other, _ := s.CreateLake(ctx, "other", "")
	callSettings(t, root, settingsRequest{Action: "model_save", Model: "selected", Provider: "test", BaseURL: "https://example.invalid"})
	profile := specialistConfig{Profile: specialist.Profile{Name: "lake_specialist_inspect", Description: "inspect", Instruction: "use real tools", Model: "selected", Tools: []string{"lake_ssh"}, MaxTurns: 4, Scope: agent.RunScope{LakeID: lake.ID, AllResources: true}}, Enabled: true}
	callSettings(t, root, settingsRequest{Action: "specialist_save", Specialist: profile})
	service, _ := operate.NewServiceForLake(ctx, s, lake.Name)
	defer service.CloseSessions()
	tools, err := customSpecialists(ctx, specialistExecution{Root: root, LakeID: lake.ID, SessionID: "test-run", Store: s}, service, nil, nil, nil)
	if err != nil || len(tools) != 1 {
		t.Fatalf("tools=%d err=%v", len(tools), err)
	}
	custom := tools[0].(customSpecialistTool)
	if custom.config.Model != "selected" {
		t.Fatal("model was not independent")
	}
	profile.Enabled = false
	callSettings(t, root, settingsRequest{Action: "specialist_save", Specialist: profile})
	if _, _, err := custom.runtime(ctx); err == nil {
		t.Fatal("disabled profile usable")
	}
	otherService, _ := operate.NewServiceForLake(ctx, s, other.Name)
	defer otherService.CloseSessions()
	tools, err = customSpecialists(ctx, specialistExecution{Root: root, LakeID: other.ID, SessionID: "other-run", Store: s}, otherService, nil, nil, nil)
	if err != nil || len(tools) != 0 {
		t.Fatal("cross-lake profile advertised")
	}
	profile.Tools = []string{"lake_specialist_other"}
	if err := validateSpecialist(root, profile.Profile); err == nil {
		t.Fatal("recursive delegation allowed")
	}
	profile.Tools = []string{"lake_code_read"}
	if err := validateSpecialist(root, profile.Profile); err == nil {
		t.Fatal("code tool lacks registered project")
	}
}
func TestWorkflowV2DesktopManagementAndExecution(t *testing.T) {
	ctx := context.Background()
	s, _ := store.Open(ctx, t.TempDir())
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "test", "")
	definition := `{"version":2,"name":"resources","nodes":[{"id":"list","kind":"tool_call","tool":"lake_resources","inputs":{"lake":{"type":"string","literal":"test"}},"output_type":"object"}]}`
	manage := func(req workflowV2ManageRequest) (string, error) {
		raw, _ := json.Marshal(req)
		var out bytes.Buffer
		err := workflowV2Manage(ctx, s, bytes.NewReader(raw), &out)
		return out.String(), err
	}
	if _, err := manage(workflowV2ManageRequest{Action: "preview", Lake: lake.Name, Definition: definition}); err != nil {
		t.Fatal(err)
	}
	raw, err := manage(workflowV2ManageRequest{Action: "save", Lake: lake.Name, Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	var saved store.WorkflowV2Definition
	json.Unmarshal([]byte(raw), &saved)
	if _, err := manage(workflowV2ManageRequest{Action: "amend", Lake: lake.Name, ID: saved.ID, ExpectedRevision: 1, Definition: definition}); err != nil {
		t.Fatal(err)
	}
	if _, err := manage(workflowV2ManageRequest{Action: "amend", Lake: lake.Name, ID: saved.ID, ExpectedRevision: 1, Definition: definition}); err == nil {
		t.Fatal("stale edit replaced revision")
	}
	service, _ := operate.NewServiceForLake(ctx, s, lake.Name)
	defer service.CloseSessions()
	var progress []workflow.Progress
	run, err := executeWorkflowV2Desktop(ctx, s, service, nil, workflowV2DesktopInput{DefinitionID: saved.ID}, func(string, string, string) (bool, error) { return true, nil }, func(p workflow.Progress) { progress = append(progress, p) })
	if err != nil || run.Status != "completed" || len(progress) == 0 {
		t.Fatalf("run=%+v err=%v progress=%v", run, err, progress)
	}
	raw, err = manage(workflowV2ManageRequest{Action: "runs", Lake: lake.Name})
	if err != nil || !strings.Contains(raw, run.ID) {
		t.Fatalf("history=%s err=%v", raw, err)
	}
	raw, err = manage(workflowV2ManageRequest{Action: "events", Lake: lake.Name, ID: run.ID})
	if err != nil || !strings.Contains(raw, "completed") {
		t.Fatalf("events=%s err=%v", raw, err)
	}
}

func TestPluginHookRunsInChatAndRequiresApproval(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, _ := store.Open(ctx, root)
	defer s.Close()
	source := t.TempDir()
	marker := filepath.Join(t.TempDir(), "ran")
	for _, dir := range []string{"assets", "hooks"} {
		os.Mkdir(filepath.Join(source, dir), 0700)
	}
	os.WriteFile(filepath.Join(source, "lake-plugin.json"), []byte(`{"name":"observer","version":"1.0.0","hooks":["hooks/start.json"],"assets":["assets/observe.sh"]}`), 0600)
	os.WriteFile(filepath.Join(source, "hooks", "start.json"), []byte(`{"version":1,"hooks":[{"event":"SessionStart","command":"assets/observe.sh"}]}`), 0600)
	os.WriteFile(filepath.Join(source, "assets", "observe.sh"), []byte("#!/bin/sh\nprintf 'ran' >> '"+marker+"'\n"), 0700)
	manager := plugins.NewManager(root, s)
	bundle, err := plugins.Inspect(source)
	if err != nil {
		t.Fatal(err)
	}
	item, err := manager.Install(ctx, source, bundle.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SetEnabled(ctx, item.Name, true); err != nil {
		t.Fatal(err)
	}
	if err := saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: "https://example.invalid", WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if err := runChatWithHooks(ctx, nil, root, strings.NewReader("/exit\n"), &out, &errOut, &chatHooks{Approve: func(string, string, string) (bool, error) { return false, nil }}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("denied hook executed")
	}
	if err := runChatWithHooks(ctx, nil, root, strings.NewReader("/exit\n"), &out, &errOut, &chatHooks{Approve: func(string, string, string) (bool, error) { return true, nil }}); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(marker); err != nil || string(body) != "ran" {
		t.Fatalf("hook result=%q err=%v", body, err)
	}
	os.WriteFile(filepath.Join(item.InstallPath, "assets", "observe.sh"), []byte("#!/bin/sh\nexit 0\n"), 0700)
	if err := manager.CheckRuntime(ctx, item); err == nil {
		t.Fatal("mutated hook remained enabled")
	}
}
func TestCustomSpecialistUsesSelectedModelAndWhitelist(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, _ := store.Open(ctx, root)
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "test", "")
	var called atomic.Int32
	modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string `json:"model"`
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if req.Model != "selected" || len(req.Tools) != 1 || req.Tools[0].Name != "lake_ssh" {
			t.Errorf("model=%s tools=%v", req.Model, req.Tools)
		}
		called.Add(1)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"test","type":"message","role":"assistant","model":"selected","content":[{"type":"text","text":"specialist result"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer modelServer.Close()
	cfg := lakeModelConfig{Model: "default", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: modelServer.URL, WireAPI: "anthropic"}}, ModelCatalog: map[string]string{"default": "test", "selected": "test"}}
	if err := saveModelConfig(root, cfg); err != nil {
		t.Fatal(err)
	}
	if err := vaultPutModelKey(root, "test", "synthetic-key"); err != nil {
		t.Fatal(err)
	}
	profile := specialistConfig{Profile: specialist.Profile{Name: "lake_specialist_inspect", Description: "inspect", Instruction: "report", Model: "selected", Tools: []string{"lake_ssh"}, MaxTurns: 4, Scope: agent.RunScope{LakeID: lake.ID, AllResources: true}}, Enabled: true}
	callSettings(t, root, settingsRequest{Action: "specialist_save", Specialist: profile})
	service, _ := operate.NewServiceForLake(ctx, s, lake.Name)
	defer service.CloseSessions()
	executor := workflowV2Executor{store: s, service: service, parentRunID: "custom-workflow"}
	defer executor.Close()
	output, err := executor.invokeSpecialist(ctx, profile.Name, "inspect")
	if err != nil || output != "specialist result" || called.Load() != 1 {
		t.Fatalf("output=%v calls=%d err=%v", output, called.Load(), err)
	}
	tasks, _ := s.ListSpecialistTasks(ctx, "custom-workflow")
	if len(tasks) != 1 || tasks[0].Model != "selected" || tasks[0].Status != "completed" {
		t.Fatal(tasks)
	}
	output, err = executor.invokeSpecialist(ctx, profile.Name, "inspect")
	if err != nil || output != "specialist result" || called.Load() != 1 {
		t.Fatalf("completed boundary reran model output=%v calls=%d err=%v", output, called.Load(), err)
	}
}

func TestBridgeRunsWorkflowV2WithStructuredInputAndApprovals(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	root := t.TempDir()
	s, _ := store.Open(ctx, root)
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "test", "")
	s.UseLake(ctx, lake.ID)
	conversation, _ := s.CreateConversation(ctx, lake.Name)
	definition := `{"version":2,"name":"resources","nodes":[{"id":"list","kind":"tool_call","tool":"lake_resources","inputs":{"lake":{"type":"string","literal":"test"}},"output_type":"object"}]}`
	saved, err := s.CreateWorkflowV2(ctx, lake.ID, "resources", "", json.RawMessage(definition))
	if err != nil {
		t.Fatal(err)
	}
	var modelCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		modelCalls.Add(1)
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		b, _ := json.Marshal(body)
		if !strings.Contains(string(b), "resources") || !strings.Contains(string(b), "completed") {
			t.Error("v2 actual results missing from model")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"content":[{"type":"text","text":"工作流completed，资源列表已由实际工具核对。"}],"usage":{"input_tokens":30,"output_tokens":10}}`)
	}))
	defer server.Close()
	previousKeys := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = previousKeys })
	saveModelConfig(root, lakeModelConfig{Model: "test", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}})
	inputR, inputW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := runBridgeConversation(ctx, root, conversation.ID, inputR, outW)
		outW.Close()
		done <- err
	}()
	encoder := json.NewEncoder(inputW)
	go func() {
		_ = encoder.Encode(bridgeRequest{Type: "workflow_v2_run", ID: "v2-turn", Prompt: "运行 v2", WorkflowV2: &workflowV2DesktopInput{DefinitionID: saved.ID}})
	}()
	decoder := json.NewDecoder(outR)
	approvalCount := 0
	sawTrace := false
	for {
		var event bridgeEvent
		if err := decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "approval" {
			approvalCount++
			encoder.Encode(bridgeRequest{Type: "approve", ID: event.ID, Approved: true})
		}
		if event.Type == "specialist" && event.Specialist != nil && event.Specialist.Kind == "workflow" {
			sawTrace = true
		}
		if event.Type == "result" && event.ID == "v2-turn" {
			if event.Error != "" || !strings.Contains(event.Text, "completed") {
				t.Fatalf("event=%+v", event)
			}
			break
		}
	}
	inputW.Close()
	io.Copy(io.Discard, outR)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if approvalCount < 2 || !sawTrace || modelCalls.Load() != 1 {
		t.Fatalf("approvals=%d trace=%v", approvalCount, sawTrace)
	}
	turns, err := s.ListConversationTurns(ctx, conversation.ID)
	if err != nil || len(turns) != 1 || turns[0].Prompt != "运行 v2" {
		t.Fatalf("turns=%+v err=%v", turns, err)
	}
}

func TestWorkflowV2CodeNodeCheckpointScopeAcceptsNodeBinding(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, _ := store.Open(ctx, root)
	defer s.Close()
	lake, _ := s.CreateLake(ctx, "test", "")
	path := t.TempDir()
	project, err := s.CreateCodeProject(ctx, lake.Name, "project", path)
	if err != nil {
		t.Fatal(err)
	}
	modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"id":"test","type":"message","role":"assistant","model":"selected","content":[{"type":"text","text":"code result"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer modelServer.Close()
	saveModelConfig(root, lakeModelConfig{Model: "selected", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: modelServer.URL, WireAPI: "anthropic"}}, ModelCatalog: map[string]string{"selected": "test"}})
	vaultPutModelKey(root, "test", "synthetic-key")
	spec := `{"version":2,"name":"code","nodes":[{"id":"first","kind":"code_task","request":{"type":"string","literal":"inspect"},"output_type":"string"},{"id":"second","kind":"code_task","depends_on":["first"],"request":{"type":"string","literal":"inspect"},"output_type":"string"}]}`
	saved, err := s.CreateWorkflowV2(ctx, lake.ID, "code", "", json.RawMessage(spec))
	if err != nil {
		t.Fatal(err)
	}
	service, _ := operate.NewServiceForLake(ctx, s, lake.Name)
	defer service.CloseSessions()
	result, err := executeWorkflowV2Desktop(ctx, s, service, nil, workflowV2DesktopInput{DefinitionID: saved.ID, ProjectID: project.ID}, func(string, string, string) (bool, error) { return true, nil }, nil)
	if err != nil || result.Status != "completed" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	tasks, _ := s.RecentSpecialistTasks(ctx)
	if len(tasks) != 2 || tasks[0].ParentRunID == tasks[1].ParentRunID {
		t.Fatalf("node tasks collapsed: %+v", tasks)
	}
}
