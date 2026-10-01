package tui

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/server"
	"github.com/cloudwego/eino/lake/store"
)

func TestTUIKeyboardNavigationAndReadableStatus(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "ops", ""); err != nil {
		t.Fatal(err)
	}
	first, err := s.CreateConversation(ctx, "ops")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateConversation(ctx, "ops")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RenameConversation(ctx, first.ID, "第一会话"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RenameConversation(ctx, second.ID, "第二会话"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurn(ctx, first.ID, "问题一", "回答一", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendConversationTurn(ctx, second.ID, "问题二", "回答二", "", ""); err != nil {
		t.Fatal(err)
	}
	listed, err := s.ListConversations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wantPrompt, wantAnswer := "问题一", "回答一"
	otherPrompt := "问题二"
	if listed[1].ID == second.ID {
		wantPrompt, wantAnswer, otherPrompt = "问题二", "回答二", "问题一"
	}
	web, err := server.New(server.Config{Store: s, ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Run(ctx, API{Handler: web.Handler()}, strings.NewReader("\x1b[B\r?q"), &out); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	if !strings.Contains(text, "Lake TUI · 会话列表") || !strings.Contains(text, "用户："+wantPrompt) || !strings.Contains(text, "助手："+wantAnswer) || strings.Contains(text, "用户："+otherPrompt) || !strings.Contains(text, "帮助：") {
		t.Fatalf("unexpected TUI output: %s", text)
	}
}

func TestTUIEventStatusLabels(t *testing.T) {
	for _, fixture := range []struct{ kind, payload, want string }{
		{"tool_proposed", `{"tool_name":"lake_ssh","target":"ops/node"}`, "待审批动作"},
		{"tool_finished", `{"status":"failed"}`, "工具状态：failed"},
		{"specialist", `{"name":"code","status":"working"}`, "专员：code"},
		{"workflow", `{"name":"部署","status":"running","step_name":"检查","step_status":"completed","completed":1,"total":2}`, "工作流：部署"},
	} {
		var payload json.RawMessage = []byte(fixture.payload)
		event := agent.AgentEvent{Kind: fixture.kind, Payload: payload, ToolCallID: "call-approval-1"}
		if line := eventLine(event); !strings.Contains(line, fixture.want) {
			t.Fatalf("line=%q want=%q", line, fixture.want)
		}
	}
}
