package main

import (
	"context"
	"errors"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	lakehooks "github.com/cloudwego/eino/lake/extension/hooks"
	"github.com/cloudwego/eino/schema"
)

type hookTestTool struct{ fail bool }

func (t hookTestTool) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "test_tool", Desc: "test"}, nil
}

func (t hookTestTool) InvokableRun(context.Context, string, ...tool.Option) (string, error) {
	if t.fail {
		return "", errors.New("failed")
	}
	return "done", nil
}

func TestHookedToolEmitsBeforeAndTerminalEvents(t *testing.T) {
	for _, tc := range []struct {
		fail bool
		last lakehooks.Event
	}{
		{false, lakehooks.PostToolUse}, {true, lakehooks.PostToolUseFailure},
	} {
		var events []lakehooks.Event
		wrapped := hookedTool{original: hookTestTool{fail: tc.fail}, emit: func(_ context.Context, event lakehooks.Event, _ map[string]string) {
			events = append(events, event)
		}}
		_, _ = wrapped.InvokableRun(context.Background(), `{}`)
		if len(events) != 2 || events[0] != lakehooks.PreToolUse || events[1] != tc.last {
			t.Fatalf("tool hook events=%v", events)
		}
	}
}
