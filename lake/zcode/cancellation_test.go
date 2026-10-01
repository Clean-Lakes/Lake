package zcode

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
)

// A transport can report its terminal result after its caller has cancelled.
// That late result must not panic or reopen an already closed Agent iterator.
type lateTool struct{ started, release, done chan struct{} }

func (*lateTool) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: "late", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{})}, nil
}
func (f *lateTool) InvokableRun(ctx context.Context, _ string, _ ...tool.Option) (string, error) {
	close(f.started)
	<-ctx.Done()
	<-f.release
	defer close(f.done)
	return "", ctx.Err()
}

func TestSourceCancellationWhileToolFinishesLate(t *testing.T) {
	opts := sourceOptions(t, t.TempDir())
	fixture := &lateTool{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	released := false
	defer func() {
		if !released {
			close(fixture.release)
		}
	}()
	opts.Tools = []tool.BaseTool{fixture}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		fixtureChunk(w, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "call_late", "type": "function", "function": map[string]string{"name": "mcp__lake__late", "arguments": "{}"}}}}, nil)
		fixtureChunk(w, map[string]any{}, "tool_calls")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()
	opts.BaseURL = server.URL + "/v1"
	agent, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	iter := agent.Run(ctx, &adk.AgentInput{Messages: []*schema.Message{schema.UserMessage("late result fixture")}})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for {
			if _, ok := iter.Next(); !ok {
				return
			}
		}
	}()
	select {
	case <-fixture.started:
	case <-time.After(10 * time.Second):
		t.Fatal("tool did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("late transport result blocked cancellation")
	}
	close(fixture.release)
	released = true
	select {
	case <-fixture.done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled transport did not finish")
	}
}
