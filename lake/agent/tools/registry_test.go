package tools

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/schema"
)

type fakeTool struct {
	name string
	run  func(context.Context, string) (string, error)
}

func (f fakeTool) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: f.name, Desc: "test", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{})}, nil
}
func (f fakeTool) InvokableRun(ctx context.Context, input string, _ ...tool.Option) (string, error) {
	return f.run(ctx, input)
}

func testSpec(name string) agent.ToolSpec {
	return agent.ToolSpec{Name: name, Description: "test", Capability: "read", InputSchema: json.RawMessage(`{"type":"object"}`), MaxOutputBytes: 64, Timeout: time.Second}
}

func TestRegistryRejectsDuplicatesAndMalformedSchemas(t *testing.T) {
	r := NewRegistry()
	fake := fakeTool{name: "read", run: func(_ context.Context, _ string) (string, error) { return "ok", nil }}
	if err := r.Register(testSpec("read"), fake); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(testSpec("read"), fake); err == nil {
		t.Fatal("duplicate tool accepted")
	}
	bad := testSpec("bad")
	bad.InputSchema = json.RawMessage(`{"type":"array"}`)
	if err := r.Register(bad, fakeTool{name: "bad"}); err == nil {
		t.Fatal("non-object schema accepted")
	}
}

func TestRegistryFiltersScopeAndBoundsOutputAndTimeout(t *testing.T) {
	r := NewRegistry()
	fake := fakeTool{name: "read", run: func(ctx context.Context, _ string) (string, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("tool deadline missing")
		}
		return strings.Repeat("x", 100), nil
	}}
	if err := r.Register(testSpec("read"), fake); err != nil {
		t.Fatal(err)
	}
	if got := r.List(agent.RunScope{LakeID: "lake"}); len(got) != 0 {
		t.Fatalf("ungranted tool visible: %+v", got)
	}
	if got := r.List(agent.RunScope{LakeID: "lake", ToolNames: []string{"read"}}); len(got) != 1 {
		t.Fatalf("granted tool hidden: %+v", got)
	}
	selected, err := r.Resolve("read")
	if err != nil {
		t.Fatal(err)
	}
	result, err := selected.(tool.InvokableTool).InvokableRun(context.Background(), `{}`)
	if err != nil || len(result) > 64 || !strings.Contains(result, "truncated") {
		t.Fatalf("result=%q err=%v", result, err)
	}
}

func TestRegistryValidatesArgumentsAgainstSchema(t *testing.T) {
	r := NewRegistry()
	spec := testSpec("read")
	spec.InputSchema = json.RawMessage(`{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}`)
	if err := r.Register(spec, fakeTool{name: "read", run: func(_ context.Context, _ string) (string, error) { return "ok", nil }}); err != nil {
		t.Fatal(err)
	}
	selected, err := r.Resolve("read")
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{}`, `{"name":3}`, `not json`, `null`} {
		if _, err := selected.(tool.InvokableTool).InvokableRun(context.Background(), input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid input %s was accepted", input)
		}
	}
}

func TestUserInputHasNoAdditionalTimeoutAndRemainsCancelable(t *testing.T) {
	r := NewRegistry()
	spec := testSpec("ask_user")
	spec.Capability = "user_input"
	spec.Timeout = 0
	started := make(chan struct{}, 1)
	if err := r.Register(spec, fakeTool{name: "ask_user", run: func(ctx context.Context, _ string) (string, error) {
		if _, ok := ctx.Deadline(); ok {
			t.Error("human wait has a tool deadline")
		}
		started <- struct{}{}
		<-ctx.Done()
		return "", ctx.Err()
	}}); err != nil {
		t.Fatal(err)
	}
	selected := r.List(agent.RunScope{LakeID: "lake", AllTools: true})[0].(tool.InvokableTool)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := selected.InvokableRun(ctx, `{}`); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancellation ignored")
		}
	case <-time.After(time.Second):
		t.Fatal("tool did not cancel")
	}
	spec.Capability = "read"
	if err := NewRegistry().Register(spec, fakeTool{name: "ask_user"}); err == nil {
		t.Fatal("ordinary tool accepted no timeout")
	}
}
