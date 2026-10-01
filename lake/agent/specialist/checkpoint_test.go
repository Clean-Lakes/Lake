package specialist

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/store"
	"github.com/cloudwego/eino/schema"
)

type recoveryModel struct {
	toolName  string
	calls     *atomic.Int32
	failFinal *atomic.Bool
}

func (m recoveryModel) WithTools([]*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	return m, nil
}
func (m recoveryModel) Generate(_ context.Context, in []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	m.calls.Add(1)
	if in[len(in)-1].Role == schema.Tool {
		if m.failFinal != nil && m.failFinal.Swap(false) {
			return nil, errors.New("simulated crash after tool")
		}
		return schema.AssistantMessage("done", nil), nil
	}
	return schema.AssistantMessage("", []schema.ToolCall{{ID: "durable-call", Type: "function", Function: schema.FunctionCall{Name: m.toolName, Arguments: `{}`}}}), nil
}
func (m recoveryModel) Stream(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	v, e := m.Generate(ctx, in, opts...)
	if e != nil {
		return nil, e
	}
	return schema.StreamReaderFromArray([]*schema.Message{v}), nil
}

type recoveryTool struct {
	name   string
	calls  *atomic.Int32
	fail   *atomic.Bool
	output string
}

func (t recoveryTool) Info(context.Context) (*schema.ToolInfo, error) {
	return &schema.ToolInfo{Name: t.name, Desc: "test", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{})}, nil
}
func (t recoveryTool) InvokableRun(context.Context, string, ...tool.Option) (string, error) {
	t.calls.Add(1)
	if t.fail != nil && t.fail.Swap(false) {
		return "", errors.New("simulated uncertain write")
	}
	if t.output != "" {
		return t.output, nil
	}
	return `{"text":"ok"}`, nil
}

func TestCheckpointSSHRejectionCanContinueAndUnknownExecutionCannotReplay(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "rejected", true: "unknown"}[unknown], func(t *testing.T) {
			ctx := context.Background()
			s, err := store.Open(ctx, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			var models, tools atomic.Int32
			var fail atomic.Bool
			fail.Store(true)
			output := `{"unknown":false,"error":"SSH 命令包含控制字符"}`
			if unknown {
				output = `{"unknown":true,"error":"SSH 执行结果未知"}`
			}
			m := recoveryModel{toolName: "lake_ssh", calls: &models, failFinal: &fail}
			tt := recoveryTool{name: "lake_ssh", calls: &tools, output: output}
			candidate := recoveryRuntime(t, s, tt.name, m, tt)
			if _, err := candidate.(tool.InvokableTool).InvokableRun(ctx, `{"request":"inspect"}`); err == nil {
				t.Fatal("expected interruption")
			}
			tasks, err := s.ListSpecialistTasks(ctx, "recovery-run")
			if err != nil || len(tasks) != 1 {
				t.Fatalf("tasks=%v err=%v", tasks, err)
			}
			resumed := candidate.(interface {
				Resume(context.Context, string, bool) (string, error)
			})
			answer, err := resumed.Resume(ctx, tasks[0].ID, false)
			if unknown {
				if err == nil || !strings.Contains(err.Error(), "结果未知") {
					t.Fatalf("unknown write replayed: %q %v", answer, err)
				}
			} else if err != nil || answer != "done" {
				t.Fatalf("rejection prevented continuation: %q %v", answer, err)
			}
			if tools.Load() != 1 {
				t.Fatal("completed rejection or unknown operation repeated")
			}
		})
	}
	if !uncertainToolOutput("lake_ssh", `{"error":"legacy failure"}`) || !uncertainToolOutput("mcp_write", `{"unknown":false,"error":"failure"}`) {
		t.Fatal("legacy or other tool uncertainty bypassed")
	}
}
func recoveryRuntime(t *testing.T, s *store.Store, name string, m recoveryModel, tt recoveryTool) tool.BaseTool {
	t.Helper()
	candidate, err := (Runtime{Profile: Profile{Name: "lake_test_agent", Description: "test", Instruction: "test", Model: "test", Tools: []string{name}, MaxTurns: 4, Scope: agent.RunScope{LakeID: "lake"}}, ParentScope: agent.RunScope{LakeID: "lake", AllTools: true}, Model: m, Tools: []tool.BaseTool{tt}, Store: s, ParentRunID: "recovery-run", ResourceIDsByName: map[string]string{}}).Tool(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return candidate
}
func TestCheckpointResumeAfterRestartDoesNotRepeatCompletedTools(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	var models, tools atomic.Int32
	var fail atomic.Bool
	fail.Store(true)
	m := recoveryModel{"lake_code_read", &models, &fail}
	tt := recoveryTool{name: "lake_code_read", calls: &tools}
	candidate := recoveryRuntime(t, s, tt.name, m, tt)
	if _, err := candidate.(tool.InvokableTool).InvokableRun(ctx, `{"request":"original context"}`); err == nil {
		t.Fatal("expected interruption")
	}
	tasks, _ := s.ListSpecialistTasks(ctx, "recovery-run")
	if len(tasks) != 1 {
		t.Fatal(tasks)
	}
	id := tasks[0].ID
	state, err := LoadCheckpoint(root, id)
	if err != nil || len(state.Models) != 1 || len(state.Tools) != 1 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	info, _ := os.Stat(filepath.Join(root, "specialist-checkpoints", id+".json"))
	if info.Mode().Perm() != 0600 {
		t.Fatal("checkpoint not private")
	}
	s.Close()
	s, err = store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	resumed := recoveryRuntime(t, s, tt.name, m, tt).(interface {
		Resume(context.Context, string, bool) (string, error)
	})
	output, err := resumed.Resume(ctx, id, false)
	if err != nil || output != "done" {
		t.Fatalf("output=%q err=%v", output, err)
	}
	if tools.Load() != 1 || models.Load() != 3 {
		t.Fatalf("tools=%d models=%d", tools.Load(), models.Load())
	}
	task, _ := s.GetSpecialistTask(ctx, id)
	if task.Status != "completed" {
		t.Fatal(task.Status)
	}
}
func TestCheckpointUnknownWritesRequireExplicitRetry(t *testing.T) {
	ctx := context.Background()
	s, _ := store.Open(ctx, t.TempDir())
	defer s.Close()
	var models, tools atomic.Int32
	var fail atomic.Bool
	fail.Store(true)
	m := recoveryModel{toolName: "lake_code_run", calls: &models}
	tt := recoveryTool{name: "lake_code_run", calls: &tools, fail: &fail}
	candidate := recoveryRuntime(t, s, tt.name, m, tt)
	if _, err := candidate.(tool.InvokableTool).InvokableRun(ctx, `{"request":"run"}`); err == nil {
		t.Fatal("expected failure")
	}
	tasks, _ := s.ListSpecialistTasks(ctx, "recovery-run")
	id := tasks[0].ID
	resumed := candidate.(interface {
		Resume(context.Context, string, bool) (string, error)
	})
	if _, err := resumed.Resume(ctx, id, false); err == nil || !strings.Contains(err.Error(), "结果未知") {
		t.Fatalf("err=%v", err)
	}
	if tools.Load() != 1 {
		t.Fatal("write repeated without explicit retry")
	}
	if _, err := resumed.Resume(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	if tools.Load() != 2 {
		t.Fatal("retry did not execute")
	}
}
func TestCheckpointLockAndSymlinkProtection(t *testing.T) {
	root := t.TempDir()
	path, unlock, err := lockCheckpoint(root, "task")
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if _, _, err := lockCheckpoint(root, "task"); err == nil {
		t.Fatal("concurrent execution permitted")
	}
	other := filepath.Join(t.TempDir(), "target")
	os.WriteFile(other, []byte(`{}`), 0600)
	if err := os.Symlink(other, path); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCheckpoint(root, "task"); err == nil {
		t.Fatal("symlink checkpoint accepted")
	}
	if _, err := LoadCheckpoint(root, "../escape"); err == nil {
		t.Fatal("task path escape")
	}
}
