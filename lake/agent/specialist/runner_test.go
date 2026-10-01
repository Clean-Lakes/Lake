package specialist

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/schema"
)

func TestTaskToolPersistsDigestsOnly(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	prepared := Prepared{Profile: Profile{Name: "lake_test_agent", Model: "test"}, Scope: agent.RunScope{LakeID: "lake", ToolNames: []string{"lake_test"}}}
	wrapper := taskTool{delegate: testDelegate{}, prepared: prepared, store: s, parentRunID: "run-1"}
	output, err := wrapper.InvokableRun(ctx, `{"request":"secret argument"}`)
	if err != nil || output != "summary" {
		t.Fatalf("output=%q err=%v", output, err)
	}
	tasks, err := s.ListSpecialistTasks(ctx, "run-1")
	if err != nil || len(tasks) != 1 || tasks[0].Status != "completed" {
		t.Fatalf("tasks=%+v err=%v", tasks, err)
	}
	if strings.Contains(tasks[0].ScopeJSON, "secret argument") || tasks[0].RequestSHA256 == "" || tasks[0].ResponseSHA256 == "" {
		t.Fatalf("task leaked arguments: %+v", tasks[0])
	}
}

func TestTaskToolPersistsFailureWithoutErrorText(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	prepared := Prepared{Profile: Profile{Name: "lake_test_agent", Model: "test"}, Scope: agent.RunScope{LakeID: "lake"}}
	wrapper := taskTool{delegate: failedDelegate{}, prepared: prepared, store: s, parentRunID: "run-fail"}
	if _, err := wrapper.InvokableRun(ctx, `{"request":"secret argument"}`); err == nil {
		t.Fatal("failure swallowed")
	}
	tasks, err := s.ListSpecialistTasks(ctx, "run-fail")
	if err != nil || len(tasks) != 1 || tasks[0].Status != "failed" || strings.Contains(tasks[0].ScopeJSON, "secret") {
		t.Fatalf("tasks=%+v err=%v", tasks, err)
	}
}

type failedDelegate struct{}

func (failedDelegate) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "lake_test_agent", Desc: "test"}, nil
}
func (failedDelegate) InvokableRun(context.Context, string, ...tool.Option) (string, error) {
	return "", errors.New("secret error text")
}

func TestScopedResourceToolRejectsKnownResourceOutsideIntersection(t *testing.T) {
	called := false
	guard := scopedResourceTool{original: namedDelegate{called: &called}, scope: agent.RunScope{LakeID: "lake", ResourceIDs: []string{"id-1"}}, ids: map[string]string{"one": "id-1", "two": "id-2"}}
	if _, err := guard.InvokableRun(context.Background(), `{"resource":"two"}`); err == nil || called {
		t.Fatal("out-of-scope resource reached delegate")
	}
	if _, err := guard.InvokableRun(context.Background(), `{"resource":"one"}`); err != nil || !called {
		t.Fatalf("in-scope resource rejected: %v", err)
	}
}

type namedDelegate struct{ called *bool }

func (namedDelegate) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "lake_ssh", Desc: "test"}, nil
}
func (d namedDelegate) InvokableRun(context.Context, string, ...tool.Option) (string, error) {
	*d.called = true
	return "ok", nil
}

type testDelegate struct{}

func (testDelegate) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "lake_test_agent", Desc: "test"}, nil
}
func (testDelegate) InvokableRun(context.Context, string, ...tool.Option) (string, error) {
	return "summary", nil
}
