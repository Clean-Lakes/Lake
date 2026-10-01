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

	"github.com/cloudwego/eino/lake/store"
)

func TestToolActivityPreviewLimitsFieldsAndRedacts(t *testing.T) {
	for _, tc := range []struct{ name, arguments, want string }{
		{"lake_code_read", `{"path":"src/main.go","content":"do not display"}`, "src/main.go"},
		{"lake_code_run", `{"command":"go test ./..."}`, "go test ./..."},
		{"lake_code_run", `{"command":"deploy --token fixture-private-value"}`, "[redacted]"},
		{"lake_ssh", `{"resource":"host","command":"API_KEY=fixture-private-value curl example.com"}`, "[redacted]"},
		{"lake_web_fetch", `{"url":"https://user:fixture-private-value@example.com/manual?token=fixture-private-value"}`, "example.com/manual"},
		{"mcp_custom_tool", `{"password":"fixture-private-value","command":"should not display"}`, ""},
		{"lake_code_create", `{"path":"main.go","content":"fixture-private-value"}`, "main.go"},
		{"lake_code_edit", `{"path":"main.go","old_text":"fixture-private-value","new_text":"do not display"}`, "main.go"},
		{"lake_code_patch", `{"files":[{"path":"main.go","content":"fixture-private-value"},{"path":"old.go","delete":true}]}`, "main.go、old.go（删除）"},
		{"lake_code_checkpoint", `{"paths":["main.go","old.go"]}`, "main.go、old.go"},
		{"lake_code_restore", `{"id":"checkpoint-1"}`, "checkpoint-1"},
		{"lake_script_read", `{"id":"script-1"}`, "script-1"},
		{"lake_resources", `{"lake":"测试湖"}`, "测试湖"},
		{"lake_workflow_v2_save", `{"definition_json":"{\"name\":\"检查流程\",\"command\":\"fixture-private-value\"}"}`, "检查流程"},
		{"lake_database_inspect", `{"resource":"db","query":"SELECT fixture-private-value","check":"version"}`, "db · version"},
	} {
		got := toolActivityPreview(tc.name, tc.arguments)
		if got != tc.want || strings.Contains(got, "fixture-private-value") {
			t.Fatalf("unsafe or unexpected preview for %s: %q", tc.name, got)
		}
	}
	long, _ := json.Marshal(map[string]string{"path": strings.Repeat("界", 400)})
	if len(toolActivityPreview("lake_code_read", string(long))) > 300 {
		t.Fatal("preview exceeds display budget")
	}
}

func TestToolActivityActionsDistinguishFileChanges(t *testing.T) {
	for _, tc := range []struct {
		name, arguments, kind, action string
		count                         int
	}{
		{"lake_code_edit", `{}`, "edit", "编辑文件", 0},
		{"lake_code_create", `{}`, "create", "创建文件", 0},
		{"lake_code_patch", `{"files":[{"path":"a"},{"path":"b"}]}`, "edit", "修改文件", 2},
		{"lake_code_patch", `{"files":[{"path":"a","delete":true}]}`, "delete", "删除文件", 1},
		{"lake_code_patch", `{"files":[{"path":"a"},{"path":"b","delete":true}]}`, "edit", "修改和删除文件", 2},
		{"lake_remote_code_write", `{"expected_sha256":"absent"}`, "create", "创建远程文件", 0},
		{"lake_remote_code_write", `{"expected_sha256":"original-hash"}`, "edit", "编辑远程文件", 0},
		{"lake_code_restore", `{}`, "restore", "恢复文件检查点", 0},
		{"lake_ssh", `{"check":"disk"}`, "query", "检查磁盘", 0},
	} {
		got := toolActivityAction(tc.name, tc.arguments)
		if got.Kind != tc.kind || got.Action != tc.action || got.Count != tc.count {
			t.Fatalf("%s: got %+v", tc.name, got)
		}
	}
}

func TestBridgeShowsCodeSpecialistFileActivities(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	root, projectPath := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(projectPath, "sample.txt"), []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "file-activity", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	project, err := s.CreateCodeProject(ctx, lake.Name, "sample", projectPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetConversationProject(ctx, conversation.ID, project.ID); err != nil {
		t.Fatal(err)
	}
	responses := []string{
		`{"content":[{"type":"tool_use","id":"delegate","name":"lake_code_agent","input":{"request":"读取、新建、编辑和删除测试文件"}}]}`,
		`{"content":[{"type":"tool_use","id":"read","name":"lake_code_read","input":{"path":"sample.txt"}}]}`,
		`{"content":[{"type":"tool_use","id":"create","name":"lake_code_create","input":{"path":"new.txt","content":"new\n"}}]}`,
		`{"content":[{"type":"tool_use","id":"edit","name":"lake_code_edit","input":{"path":"sample.txt","old_text":"before","new_text":"after"}}]}`,
		`{"content":[{"type":"tool_use","id":"delete","name":"lake_code_patch","input":{"files":[{"path":"new.txt","delete":true}]}}]}`,
		`{"content":[{"type":"tool_use","id":"missing","name":"lake_code_read","input":{"path":"missing.txt"}}]}`,
		`{"content":[{"type":"text","text":"已执行文件操作，缺失文件读取失败。"}]}`,
		`{"content":[{"type":"text","text":"完成文件操作验证。"}]}`,
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		i := int(requests.Add(1)) - 1
		if i >= len(responses) {
			t.Error("unexpected model request")
			_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"停止。"}]}`)
			return
		}
		_, _ = io.WriteString(w, responses[i])
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	reader, input := io.Pipe()
	defer reader.Close()
	defer input.Close()
	go func() {
		_, _ = io.WriteString(input, "{\"type\":\"ask\",\"id\":\"files-turn\",\"prompt\":\"请修改测试项目\"}\n")
	}()
	var output bytes.Buffer
	respond := bridgeTestWriter(func(p []byte) (int, error) {
		n, err := output.Write(p)
		var event bridgeEvent
		if json.Unmarshal(p, &event) == nil {
			if event.Type == "approval" {
				go func() {
					_, _ = io.WriteString(input, "{\"type\":\"approve\",\"id\":\"files-turn\",\"approved\":true}\n")
				}()
			}
			if event.Type == "result" || event.Type == "fatal" {
				_ = input.Close()
			}
		}
		return n, err
	})
	if err = runBridgeConversation(ctx, root, conversation.ID, reader, respond); err != nil {
		t.Fatal(err)
	}
	saved, err := s.ListAgentEvents(ctx, conversation.ID, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	bySequence := map[uint64]store.ConversationEvent{}
	for _, event := range saved {
		bySequence[event.Sequence] = event
	}
	wantActions := map[string]string{"read": "读取文件", "create": "创建文件", "edit": "编辑文件", "delete": "删除文件", "missing": "读取文件"}
	starts, finishes := map[string]bool{}, map[string]bool{}
	decoder := json.NewDecoder(&output)
	for decoder.More() {
		var event bridgeEvent
		if err = decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "activity" || event.Activity == nil {
			continue
		}
		activity := *event.Activity
		want, known := wantActions[activity.ToolCallID]
		if !known {
			continue
		}
		if !bytes.Equal(activity.Payload, bySequence[activity.Sequence].Payload) {
			t.Fatal("live and persisted file activity differ")
		}
		var body map[string]any
		if err = json.Unmarshal(activity.Payload, &body); err != nil {
			t.Fatal(err)
		}
		if activity.Kind == "tool_proposed" {
			if body["activity_action"] != want || body["preview"] == "" {
				t.Fatalf("file action missing: %s", activity.Payload)
			}
			starts[activity.ToolCallID] = true
		} else if activity.Kind == "tool_finished" {
			status := "completed"
			if activity.ToolCallID == "missing" {
				status = "failed"
			}
			if body["status"] != status {
				t.Fatalf("incorrect file outcome: %s", activity.Payload)
			}
			finishes[activity.ToolCallID] = true
		}
	}
	if len(starts) != 5 || len(finishes) != 5 {
		t.Fatalf("file events missing: starts=%v finishes=%v", starts, finishes)
	}
	content, err := os.ReadFile(filepath.Join(projectPath, "sample.txt"))
	if err != nil || string(content) != "after\n" {
		t.Fatal("edit was not actually applied")
	}
	if _, err = os.Stat(filepath.Join(projectPath, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("delete was not actually applied")
	}
}

func TestToolActivityStatusDoesNotTreatBusinessErrorsAsSuccess(t *testing.T) {
	for _, tc := range []struct{ content, want string }{
		{`{"text":"read"}`, "completed"},
		{`{"error":"not found"}`, "failed"},
		{`{"error":"invalid_report"}`, "failed"},
		{`{"exit_code":1}`, "failed"},
		{`{"text":{"exit_code":7}}`, "failed"},
		{`{"unknown":true,"error":"connection lost"}`, "unknown"},
		{`{"text":{"unknown":true},"error":"connection lost"}`, "unknown"},
		{`{"task":{"status":"running"}}`, "completed"},
		{`{"task":{"status":"cancelled"}}`, "cancelled"},
		{`{"run":{"status":"unknown"}}`, "unknown"},
	} {
		if got := toolActivityStatus(tc.content); got != tc.want {
			t.Fatalf("%s: got %s, want %s", tc.content, got, tc.want)
		}
	}
}

func TestBridgeStreamsPersistedToolActivitiesAndAssistantSteps(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "activity-test", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"我先查询资源概况。"},{"type":"tool_use","id":"overview-call","name":"lake_overview","input":{}}],"stop_reason":"tool_use"}`)
		} else {
			_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"已查到资源概况。"}],"stop_reason":"end_turn"}`)
		}
	}))
	defer server.Close()
	if err = saveModelConfig(root, lakeModelConfig{Model: "fixture", ModelProvider: "test", ModelProviders: map[string]providerConfig{"test": {BaseURL: server.URL, WireAPI: "anthropic"}}}); err != nil {
		t.Fatal(err)
	}
	original := modelKeys
	modelKeys = fakeModelKeys{}
	t.Cleanup(func() { modelKeys = original })
	var output bytes.Buffer
	if err = runBridgeConversation(ctx, root, conversation.ID, strings.NewReader("{\"type\":\"ask\",\"id\":\"activity-turn\",\"prompt\":\"查询资源\"}\n"), &output); err != nil {
		t.Fatal(err)
	}
	saved, err := s.ListAgentEvents(ctx, conversation.ID, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	bySequence := map[uint64]store.ConversationEvent{}
	for _, event := range saved {
		bySequence[event.Sequence] = event
	}
	decoder := json.NewDecoder(&output)
	activityCount, assistantStep := 0, false
	for decoder.More() {
		var event bridgeEvent
		if err = decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "assistant_step" {
			assistantStep = event.Text == "我先查询资源概况。"
		}
		if event.Type != "activity" {
			continue
		}
		activityCount++
		if event.ID != "activity-turn" || event.Activity == nil {
			t.Fatal("missing turn or activity")
		}
		activity := *event.Activity
		persisted := bySequence[activity.Sequence]
		if activity.ToolCallID != "overview-call" || !bytes.Equal(activity.Payload, persisted.Payload) || activity.Kind != persisted.Kind {
			t.Fatal("live activity differs from persisted record")
		}
		if activity.Kind == "tool_finished" && !bytes.Contains(activity.Payload, []byte(`"status":"completed"`)) {
			t.Fatal("missing actual finish status")
		}
	}
	if activityCount != 2 || !assistantStep {
		t.Fatalf("activity count=%d assistant step=%v", activityCount, assistantStep)
	}
}
