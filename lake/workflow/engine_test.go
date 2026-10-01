package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type fakeSSH struct {
	mu                     sync.Mutex
	calls                  []string
	active, maxActive      int
	failCheck, failCommand bool
}

func (f *fakeSSH) RunRead(_ context.Context, resource, check string) (sshtransport.Result, error) {
	f.mu.Lock()
	f.calls = append(f.calls, "read:"+resource+":"+check)
	f.active++
	if f.active > f.maxActive {
		f.maxActive = f.active
	}
	fail := f.failCheck
	f.mu.Unlock()
	time.Sleep(15 * time.Millisecond)
	f.mu.Lock()
	f.active--
	f.mu.Unlock()
	if fail && check == "cpu" {
		return sshtransport.Result{ExitCode: 1, Stderr: "check failed"}, nil
	}
	return sshtransport.Result{Stdout: "ok", ExitCode: 0}, nil
}
func (f *fakeSSH) RunCommand(_ context.Context, resource, command string) (sshtransport.Result, error) {
	f.mu.Lock()
	f.calls = append(f.calls, "command:"+resource+":"+command)
	fail := f.failCommand
	f.mu.Unlock()
	if fail {
		return sshtransport.Result{ExitCode: 1, Stderr: "command failed"}, nil
	}
	return sshtransport.Result{Stdout: "done", ExitCode: 0}, nil
}

func savedWorkflow(t *testing.T, def Definition) (*store.Store, store.WorkflowDefinition) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if _, err := s.CreateLake(ctx, "ops", ""); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(def)
	if err != nil {
		t.Fatal(err)
	}
	w, err := s.CreateWorkflow(ctx, "ops", def.Name, def.Description, raw)
	if err != nil {
		t.Fatal(err)
	}
	return s, w
}

func TestWorkflowRunsIndependentChecksBeforeDependentCommand(t *testing.T) {
	def := Definition{Name: "inspect", Steps: []Step{
		{ID: "cpu", Name: "检查 CPU", Kind: "ssh_check", Resource: "web", Check: "cpu"},
		{ID: "disk", Name: "检查磁盘", Kind: "ssh_check", Resource: "db", Check: "disk"},
		{ID: "report", Name: "汇总", Kind: "ssh_command", Resource: "web", Command: "echo done", DependsOn: []string{"cpu", "disk"}},
	}}
	if err := Validate(def); err != nil {
		t.Fatal(err)
	}
	s, w := savedWorkflow(t, def)
	fake := &fakeSSH{}
	run, err := Start(context.Background(), s, w, "cli", fake, nil)
	if err != nil || run.Status != "completed" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if fake.maxActive != 2 {
		t.Fatalf("independent checks were not parallel: %d", fake.maxActive)
	}
	if len(fake.calls) != 3 || !strings.HasPrefix(fake.calls[2], "command:") {
		t.Fatalf("calls=%v", fake.calls)
	}
	events, err := s.ListWorkflowEvents(context.Background(), run.ID)
	if err != nil || len(events) < 8 {
		t.Fatalf("events=%v err=%v", events, err)
	}
}

func TestWorkflowFailureSkipsDependentAndRunsFallback(t *testing.T) {
	def := Definition{Name: "fallback", Steps: []Step{
		{ID: "cpu", Name: "检查 CPU", Kind: "ssh_check", Resource: "web", Check: "cpu"},
		{ID: "next", Name: "下一步", Kind: "ssh_check", Resource: "web", Check: "disk", DependsOn: []string{"cpu"}},
		{ID: "fallback", Name: "故障分支", Kind: "ssh_check", Resource: "web", Check: "memory", DependsOn: []string{"cpu"}, When: "any_failure"},
	}}
	s, w := savedWorkflow(t, def)
	fake := &fakeSSH{failCheck: true}
	run, err := Start(context.Background(), s, w, "cli", fake, nil)
	if err != nil || run.Status != "failed" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	status := map[string]string{}
	for _, step := range run.Steps {
		status[step.StepID] = step.Status
	}
	if status["cpu"] != "failed" || status["next"] != "skipped" || status["fallback"] != "completed" {
		t.Fatalf("statuses=%v", status)
	}
}

func TestResumeWriteNeedsExplicitRetry(t *testing.T) {
	def := Definition{Name: "retry", Steps: []Step{{ID: "write", Name: "写入", Kind: "ssh_command", Resource: "web", Command: "touch /tmp/something"}}}
	s, w := savedWorkflow(t, def)
	fake := &fakeSSH{failCommand: true}
	run, err := Start(context.Background(), s, w, "cli", fake, nil)
	if err != nil || run.Status != "failed" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	if _, err := Resume(context.Background(), s, run.ID, false, fake, nil); err == nil {
		t.Fatal("write was retried without explicit option")
	}
	fake.mu.Lock()
	fake.failCommand = false
	fake.mu.Unlock()
	run, err = Resume(context.Background(), s, run.ID, true, fake, nil)
	if err != nil || run.Status != "completed" {
		t.Fatalf("run=%+v err=%v", run, err)
	}
}

func TestValidateRejectsCyclesAndUnknownChecks(t *testing.T) {
	def := Definition{Name: "bad", Steps: []Step{{ID: "a", Name: "A", Kind: "ssh_check", Resource: "web", Check: "cpu", DependsOn: []string{"b"}}, {ID: "b", Name: "B", Kind: "ssh_check", Resource: "web", Check: "memory", DependsOn: []string{"a"}}}}
	if err := Validate(def); err == nil {
		t.Fatal("cycle accepted")
	}
	def.Steps[0].DependsOn = nil
	def.Steps[1].DependsOn = nil
	def.Steps[0].Check = "arbitrary shell"
	if err := Validate(def); err == nil {
		t.Fatal("unknown read check accepted")
	}
}

func TestBindWorkflowTargets(t *testing.T) {
	def := Definition{Name: "inspect", Steps: []Step{
		{ID: "cpu", Name: "CPU", Kind: "ssh_check", Resource: "$host", Check: "cpu"},
		{ID: "disk", Name: "disk", Kind: "ssh_check", Resource: "$host", Check: "disk"},
	}}
	if _, err := Bind(def, "", nil); err == nil {
		t.Fatal("accepted unresolved target")
	}
	bound, err := Bind(def, "web", nil)
	if err != nil {
		t.Fatal(err)
	}
	if bound.Steps[0].Resource != "web" || bound.Steps[1].Resource != "web" || def.Steps[0].Resource != "$host" {
		t.Fatalf("bound=%+v original=%+v", bound, def)
	}
	if _, err := Bind(def, "web", map[string]string{"host": "web"}); err == nil {
		t.Fatal("accepted competing binding modes")
	}
	if _, err := Bind(def, "", map[string]string{"other": "web"}); err == nil {
		t.Fatal("accepted unknown binding")
	}
	def.Steps[1].Resource = "$database"
	if _, err := Bind(def, "web", nil); err == nil {
		t.Fatal("accepted single target for multi-target workflow")
	}
	bound, err = Bind(def, "", map[string]string{"host": "web", "database": "db"})
	if err != nil || bound.Steps[1].Resource != "db" {
		t.Fatalf("bound=%+v err=%v", bound, err)
	}
}

func TestWorkflowTargetModesAndMultiHostFanout(t *testing.T) {
	fixed := Definition{Name: "fixed", TargetMode: "fixed", Steps: []Step{{ID: "cpu", Name: "CPU", Kind: "ssh_check", Resource: "web", Check: "cpu"}}}
	if TargetModeOf(fixed) != "fixed" {
		t.Fatal("fixed mode lost")
	}
	if _, err := BindTargets(fixed, "", nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := BindTargets(fixed, "db", nil, nil); err == nil {
		t.Fatal("fixed mode accepted override")
	}
	fixed.Steps[0].Resource = "$host"
	if err := Validate(fixed); err == nil {
		t.Fatal("fixed mode accepted placeholder")
	}
	multiple := Definition{Name: "health", TargetMode: "multiple", Steps: []Step{
		{ID: "list", Name: "列出容器", Kind: "ssh_check", Resource: "$host", Check: "os"},
		{ID: "health", Name: "检查状态", Kind: "ssh_check", Resource: "$host", Check: "cpu", DependsOn: []string{"list"}},
	}}
	if _, err := BindTargets(multiple, "", nil, nil); err == nil {
		t.Fatal("multi mode ran without target")
	}
	if _, err := BindTargets(multiple, "", nil, []string{"web", "web"}); err == nil {
		t.Fatal("multi mode accepted duplicate hosts")
	}
	resolved, err := BindTargets(multiple, "", nil, []string{"web", "db"})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.TargetMode != "fixed" || len(resolved.Steps) != 4 || resolved.Steps[1].DependsOn[0] != resolved.Steps[0].ID || resolved.Steps[3].DependsOn[0] != resolved.Steps[2].ID || resolved.Steps[0].Resource != "web" || resolved.Steps[2].Resource != "db" {
		t.Fatalf("fanout=%+v", resolved)
	}
	s, saved := savedWorkflow(t, multiple)
	fake := &fakeSSH{}
	run, err := StartWithTargets(context.Background(), s, saved, "cli", "", nil, []string{"web", "db"}, fake, nil)
	if err != nil || run.Status != "completed" || len(run.Steps) != 4 {
		t.Fatalf("run=%+v err=%v", run, err)
	}
	var snapshot Definition
	if err := json.Unmarshal(run.Spec, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Steps[2].Resource != "db" || snapshot.TargetMode != "fixed" {
		t.Fatalf("snapshot=%+v", snapshot)
	}
}
