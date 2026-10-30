package ai

import (
	"context"
	"iter"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/agent/llmagent"
	"google.golang.org/adk/v2/agent/workflowagent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/runner"
	adksession "google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"
)

type externalWaitProofModel struct{ calls int }

func (*externalWaitProofModel) Name() string { return "external-wait-proof" }
func (m *externalWaitProofModel) GenerateContent(_ context.Context, req *model.LLMRequest, _ bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.calls++
		content := &genai.Content{Role: "model", Parts: []*genai.Part{{Text: "finished"}}}
		last := req.Contents[len(req.Contents)-1]
		if len(last.Parts) > 0 && last.Parts[0].Text == "start" {
			content.Parts = []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "original-wait", Name: "work_wait", Args: map[string]any{}}}}
		}
		if last.Parts[0].FunctionResponse != nil && last.Parts[0].FunctionResponse.ID != "original-wait" {
			panic("wait identity changed")
		}
		yield(&model.LLMResponse{Content: content}, nil)
	}
}

// Public ADK APIs can park an invocation, persist its machine-input checkpoint,
// process a different conversation and resume the original function response.
func TestADKExternalWaitReopensWithoutModelPollingOrToolReplay(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "sessions.sqlite")
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	m := &externalWaitProofModel{}
	dispatches := 0
	wait, err := functiontool.New(functiontool.Config{Name: "work_wait", IsLongRunning: true}, func(ac agent.Context, _ map[string]any) (map[string]any, error) {
		dispatches++
		ac.Actions().SkipSummarization = true
		return map[string]any{"status": "pending"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	root, err := llmagent.New(llmagent.Config{Name: "proof", Model: m, Tools: []tool.Tool{wait}})
	if err != nil {
		t.Fatal(err)
	}
	run := func(service adksession.Service, id string, content *genai.Content) {
		t.Helper()
		r, err := runner.New(runner.Config{AppName: "proof", Agent: root, SessionService: service, AutoCreateSession: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, err := range r.Run(ctx, "owner", id, content, agent.RunConfig{}) {
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	run(store.Sessions, "goal", genai.NewContentFromText("start", "user"))
	if m.calls != 1 || dispatches != 1 {
		t.Fatal("wait did not release invocation", m.calls, dispatches)
	}
	rerun := true
	node := workflow.NewDynamicNode("external_event", func(ac agent.Context, _ any, emit func(*adksession.Event) error) (any, error) {
		return workflow.ResumeOrRequestInput(ac, emit, adksession.RequestInput{InterruptID: "original-wait", Message: "external result", Payload: map[string]any{"source": "machine", "watchId": "watch"}})
	}, workflow.NodeConfig{RerunOnResume: &rerun})
	workflowRoot, err := workflowagent.New(workflowagent.Config{Name: "machine_wait", Edges: workflow.Chain(workflow.Start, node)})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := func(service adksession.Service, input *genai.Content) {
		t.Helper()
		r, err := runner.New(runner.Config{AppName: "machine", Agent: workflowRoot, SessionService: service, AutoCreateSession: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, err := range r.Run(ctx, "owner", "checkpoint", input, agent.RunConfig{}) {
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	checkpoint(store.Sessions, genai.NewContentFromText("wait", "user"))
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	run(store.Sessions, "new-topic", genai.NewContentFromText("independent question", "user"))
	if m.calls != 2 || dispatches != 1 {
		t.Fatal("new topic polled or replayed old wait")
	}
	checkpoint(store.Sessions, &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "original-wait", Name: workflow.WorkflowInputFunctionCallName, Response: map[string]any{"watchId": "watch", "status": "completed"}}}}})
	run(store.Sessions, "goal", &genai.Content{Role: "user", Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "original-wait", Name: "work_wait", Response: map[string]any{"status": "completed"}}}}})
	if m.calls != 3 || dispatches != 1 {
		t.Fatal("resume replayed wait", m.calls, dispatches)
	}
}

func TestWorkSequentialWaitsHaveIndependentOriginalInputCheckpoints(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	for _, callID := range []string{"original-build-wait", "original-deploy-wait"} {
		if err = e.runWorkInput(context.Background(), "same-goal", callID, nil); err != nil {
			t.Fatal(err)
		}
		got, getErr := store.Sessions.Get(context.Background(), &adksession.GetRequest{AppName: "lake_work_input", UserID: "lake", SessionID: "same-goal_" + hash(callID)[:16]})
		if getErr != nil {
			t.Fatal(getErr)
		}
		found := false
		for event := range got.Session.Events().All() {
			if event.RequestedInput != nil && event.RequestedInput.InterruptID == callID {
				found = true
			}
		}
		if !found {
			t.Fatal("later work wait reused an already completed checkpoint", callID)
		}
		if err = e.runWorkInput(context.Background(), "same-goal", callID, map[string]any{"status": "completed"}); err != nil {
			t.Fatal(err)
		}
	}
}
