package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/store"
)

type fakeV2Executor struct {
	mu      sync.Mutex
	calls   []string
	command func(context.Context, string, string) (any, error)
}

func (f *fakeV2Executor) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}
func (f *fakeV2Executor) SSHCheck(_ context.Context, target, check string) (any, error) {
	f.record("check:" + target + ":" + check)
	return "ok:" + target, nil
}
func (f *fakeV2Executor) SSHCommand(ctx context.Context, target, command string) (any, error) {
	f.record("command:" + target + ":" + command)
	if f.command != nil {
		return f.command(ctx, target, command)
	}
	return map[string]any{"stdout": "done", "exit_code": 0}, nil
}
func (f *fakeV2Executor) CodeTask(_ context.Context, request string) (any, error) {
	f.record("code:" + request)
	return "code done", nil
}
func (f *fakeV2Executor) SpecialistTask(_ context.Context, name, request string) (any, error) {
	f.record("specialist:" + name + ":" + request)
	return "specialist done", nil
}
func (f *fakeV2Executor) ToolCall(_ context.Context, name string, input map[string]any) (any, error) {
	f.record("tool:" + name)
	return map[string]any{"echo": input["message"]}, nil
}

func savedV2(t *testing.T, body string) (*store.Store, store.WorkflowV2Definition) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	lake, err := s.CreateLake(ctx, "ops-v2", "")
	if err != nil {
		t.Fatal(err)
	}
	def, err := ParseV2([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CompileV2(def); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := s.CreateWorkflowV2(ctx, lake.ID, def.Name, def.Description, raw)
	if err != nil {
		t.Fatal(err)
	}
	return s, saved
}

func TestWorkflowV2WaitsForApprovalThenResumesWithCommittedReference(t *testing.T) {
	s, def := savedV2(t, `{"version":2,"name":"approval","nodes":[{"id":"read","kind":"ssh_check","target":{"type":"string","literal":"host"},"check":"uptime"},{"id":"report","kind":"tool_call","tool":"lake_report","output_type":"object","depends_on":["read"],"inputs":{"message":{"type":"string","ref":{"node":"read","type":"string"}}}}]}`)
	fake := &fakeV2Executor{}
	run, err := StartV2(context.Background(), s, def, "cli", fake, nil)
	if err != nil || run.Status != "waiting_approval" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if len(fake.calls) != 1 || fake.calls[0] != "check:host:uptime" {
		t.Fatalf("calls=%v", fake.calls)
	}
	if run.Nodes[1].Status != "waiting_approval" || !strings.Contains(string(run.Nodes[1].Input), "ok:host") {
		t.Fatalf("waiting snapshot=%+v", run.Nodes[1])
	}
	run, err = ResumeV2(context.Background(), s, run.ID, false, fake, func(context.Context, NodeV2, json.RawMessage) (bool, error) { return true, nil })
	if err != nil || run.Status != "completed" || run.Nodes[1].Status != "completed" || len(fake.calls) != 2 {
		t.Fatalf("run=%+v calls=%v err=%v", run, fake.calls, err)
	}
	if !strings.Contains(string(run.Nodes[1].Result), "ok:host") || !strings.Contains(string(run.Nodes[1].Approval), "allow") {
		t.Fatalf("result=%+v", run.Nodes[1])
	}
}

func TestWorkflowV2InterruptedWriteRequiresExplicitRetry(t *testing.T) {
	s, def := savedV2(t, `{"version":2,"name":"write","nodes":[{"id":"command","kind":"ssh_command","target":{"type":"string","literal":"host"},"command":{"type":"string","literal":"touch /tmp/file"}}]}`)
	ctx, cancel := context.WithCancel(context.Background())
	fake := &fakeV2Executor{command: func(ctx context.Context, _, _ string) (any, error) { cancel(); return nil, ctx.Err() }}
	approve := func(context.Context, NodeV2, json.RawMessage) (bool, error) { return true, nil }
	run, err := StartV2(ctx, s, def, "cli", fake, approve)
	if err != nil || run.Status != "interrupted" || run.Nodes[0].Status != "unknown" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if _, err := ResumeV2(context.Background(), s, run.ID, false, fake, approve); err == nil {
		t.Fatal("unknown write replayed")
	}
	if len(fake.calls) != 1 {
		t.Fatalf("calls=%v", fake.calls)
	}
	fake.command = nil
	run, err = ResumeV2(context.Background(), s, run.ID, true, fake, approve)
	if err != nil || run.Status != "completed" || len(fake.calls) != 2 {
		t.Fatalf("run=%+v calls=%v err=%v", run, fake.calls, err)
	}
}

func TestWorkflowV2FanoutBindsItems(t *testing.T) {
	s, def := savedV2(t, `{"version":2,"name":"fanout","nodes":[{"id":"hosts","kind":"tool_call","tool":"lake_hosts","output_type":"array"},{"id":"check","kind":"ssh_check","depends_on":["hosts"],"target":{"type":"string","item":true},"check":"uptime","for_each":{"ref":{"node":"hosts","type":"array"},"element_type":"string","max_items":3}}]}`)
	fake := &fakeV2Executor{}
	// A tool_call needs explicit approval even when this test executor is read-only.
	run, err := StartV2(context.Background(), s, def, "cli", v2HostsExecutor{fake}, func(context.Context, NodeV2, json.RawMessage) (bool, error) { return true, nil })
	if err != nil || run.Status != "completed" || run.Nodes[1].Status != "completed" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if !strings.Contains(string(run.Nodes[1].Result), "ok:a") || !strings.Contains(string(run.Nodes[1].Result), "ok:b") {
		t.Fatalf("fanout result=%s", run.Nodes[1].Result)
	}
}

func TestResumeV2MarksAllInFlightWritesUnknownBeforeRefusingRetry(t *testing.T) {
	s, def := savedV2(t, `{"version":2,"name":"two-writes","nodes":[{"id":"a","kind":"ssh_command","target":{"type":"string","literal":"host"},"command":{"type":"string","literal":"touch a"}},{"id":"b","kind":"ssh_command","target":{"type":"string","literal":"host"},"command":{"type":"string","literal":"touch b"}}]}`)
	run, err := s.CreateWorkflowV2Run(context.Background(), def, "cli", []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		if _, err := s.TransitionWorkflowV2Node(context.Background(), store.WorkflowV2NodeChange{RunID: run.ID, NodeID: id, From: "pending", To: "running", Input: json.RawMessage(`{"calls":[]}`)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetWorkflowV2RunStatus(context.Background(), run.ID, "interrupted"); err != nil {
		t.Fatal(err)
	}
	if _, err := ResumeV2(context.Background(), s, run.ID, false, &fakeV2Executor{}, nil); err == nil {
		t.Fatal("unknown writes resumed")
	}
	run, err = s.GetWorkflowV2Run(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range run.Nodes {
		if node.Status != "unknown" {
			t.Fatalf("node was not marked unknown: %+v", node)
		}
	}
}

type parallelV2Executor struct {
	*fakeV2Executor
	mu                sync.Mutex
	active, maxActive int
}

func (f *parallelV2Executor) SSHCheck(_ context.Context, target, check string) (any, error) {
	f.mu.Lock()
	f.active++
	if f.active > f.maxActive {
		f.maxActive = f.active
	}
	f.mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	f.mu.Lock()
	f.active--
	f.mu.Unlock()
	return "ok", nil
}

func TestWorkflowV2HonorsParallelLimit(t *testing.T) {
	s, def := savedV2(t, `{"version":2,"name":"parallel","max_parallel":2,"nodes":[{"id":"a","kind":"ssh_check","target":{"type":"string","literal":"host"},"check":"uptime"},{"id":"b","kind":"ssh_check","target":{"type":"string","literal":"host"},"check":"uptime"},{"id":"c","kind":"ssh_check","target":{"type":"string","literal":"host"},"check":"uptime"},{"id":"d","kind":"ssh_check","target":{"type":"string","literal":"host"},"check":"uptime"}]}`)
	fake := &parallelV2Executor{fakeV2Executor: &fakeV2Executor{}}
	run, err := StartV2(context.Background(), s, def, "cli", fake, nil)
	if err != nil || run.Status != "completed" || fake.maxActive != 2 {
		t.Fatalf("run=%+v parallel=%d err=%v", run, fake.maxActive, err)
	}
}

func TestWorkflowV2MissingCommittedResultPathFailsWithoutDispatch(t *testing.T) {
	s, def := savedV2(t, `{"version":2,"name":"missing","nodes":[{"id":"write","kind":"ssh_command","target":{"type":"string","literal":"host"},"command":{"type":"string","literal":"echo hi"}},{"id":"next","kind":"code_task","depends_on":["write"],"request":{"type":"string","ref":{"node":"write","path":"/missing","type":"string"}}}]}`)
	fake := &fakeV2Executor{}
	run, err := StartV2(context.Background(), s, def, "cli", fake, func(context.Context, NodeV2, json.RawMessage) (bool, error) { return true, nil })
	if err != nil || run.Status != "failed" || run.Nodes[1].Status != "failed" || run.Nodes[1].ErrorCode != "input_unavailable" || len(fake.calls) != 1 {
		t.Fatalf("run=%+v calls=%v err=%v", run, fake.calls, err)
	}
}

type v2HostsExecutor struct{ *fakeV2Executor }

func (f v2HostsExecutor) ToolCall(_ context.Context, name string, _ map[string]any) (any, error) {
	if name != "lake_hosts" {
		return nil, errors.New("unexpected tool")
	}
	f.record("hosts")
	return []string{"a", "b"}, nil
}
