package operate

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type localJobRunner struct {
	home         string
	starts       int
	calls        int
	loseStart    bool
	malformStart bool
	failStatus   int
}

func (r *localJobRunner) Run(context.Context, sshtransport.Target, []byte, string) (sshtransport.Result, error) {
	return sshtransport.Result{}, errors.New("unexpected command without input")
}
func (r *localJobRunner) RunWithInput(ctx context.Context, _ sshtransport.Target, _ []byte, command string, input []byte) (sshtransport.Result, error) {
	r.calls++
	var request struct{ Action string }
	json.Unmarshal(input, &request)
	if request.Action == "status" && r.failStatus > 0 {
		r.failStatus--
		return sshtransport.Result{}, errors.New("simulated read disconnection")
	}
	if request.Action == "start" {
		r.starts++
	}
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Env = append(os.Environ(), "HOME="+r.home)
	cmd.Stdin = strings.NewReader(string(input))
	output, err := cmd.Output()
	result := sshtransport.Result{Stdout: string(output)}
	if exit, ok := err.(*exec.ExitError); ok {
		result.ExitCode = exit.ExitCode()
		result.Stderr = string(exit.Stderr)
		err = nil
	}
	if request.Action == "start" && r.loseStart {
		r.loseStart = false
		return sshtransport.Result{}, errors.New("simulated lost launch response")
	}
	if request.Action == "start" && r.malformStart {
		r.malformStart = false
		result.Stdout = "invalid response after execution"
	}
	return result, err
}

func TestScriptJobInvalidLaunchResponseRemainsUnknownAndQueriesSameJob(t *testing.T) {
	service, script, runner := jobService(t, "printf once >> executions\nsleep 1\n")
	runner.malformStart = true
	job, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, 20, "invalid-response")
	if err != nil || job.Status != "unknown" {
		t.Fatalf("execution misclassified: %+v %v", job, err)
	}
	result := waitJob(t, service, job.Job.ID)
	if result.Status != "succeeded" || runner.starts != 1 {
		t.Fatalf("did not observe original execution: %+v", result)
	}
}

func jobService(t *testing.T, content string) (*Service, store.Script, *localJobRunner) {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	lake, err := s.CreateLake(ctx, "jobs", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "example.invalid", Port: 22, Username: "root"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
		t.Fatal(err)
	}
	script, err := s.SaveScript(ctx, store.ScriptInput{Name: "test", Language: "sh", ResourceID: host.ID, Content: []byte(content)})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewServiceForLake(ctx, s, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	runner := &localJobRunner{home: t.TempDir()}
	service.Runner = runner
	service.Keys = &fakeKeys{}
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	t.Cleanup(func() { service.CloseSessions() })
	return service, script, runner
}

func waitJob(t *testing.T, s *Service, id string) ScriptJobStatus {
	t.Helper()
	result, err := s.WaitScriptJob(context.Background(), id, 5, nil)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestScriptJobLostResponseRestartAndReadRetryNeverRepeatExecution(t *testing.T) {
	service, script, runner := jobService(t, "printf once >> executions\nsleep 1\nprintf finished\n")
	runner.loseStart = true
	first, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, 20, "same-call")
	if err != nil || first.Status != "unknown" || first.Job.ID == "" {
		t.Fatalf("lost identity: %+v %v", first, err)
	}
	// A fresh service observes a persisted job after process restart.
	restarted, err := NewServiceForLake(context.Background(), service.Store, service.Lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	restarted.Runner = runner
	restarted.Keys = &fakeKeys{}
	restarted.Confirm = service.Confirm
	runner.failStatus = 1
	result := waitJob(t, restarted, first.Job.ID)
	if result.Status != "succeeded" || result.ExitCode == nil || *result.ExitCode != 0 || result.StdoutTail != "finished" {
		t.Fatalf("did not recover: %+v", result)
	}
	// Replaying the original start call only queries the same identity.
	duplicate, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, 20, "same-call")
	if err != nil || duplicate.Job.ID != first.Job.ID || runner.starts != 1 {
		t.Fatalf("duplicate execution: %+v %v starts=%d", duplicate, err, runner.starts)
	}
	executions, err := os.ReadFile(filepath.Join(runner.home, ".lake-script-jobs", first.Job.ID, "executions"))
	if err != nil || string(executions) != "once" {
		t.Fatalf("script replayed: %q %v", executions, err)
	}
	if _, err := service.Store.SetExecuteAuthz(context.Background(), first.Job.ResourceID, false); err != nil {
		t.Fatal(err)
	}
	calls := runner.calls
	if _, err := service.ScriptJobStatus(context.Background(), first.Job.ID); err == nil || runner.calls != calls {
		t.Fatal("withdrawn grant reached SSH")
	}
}

func TestScriptJobTimeoutCancelAndBoundedOutput(t *testing.T) {
	for _, scenario := range []string{"timeout", "cancel", "output"} {
		t.Run(scenario, func(t *testing.T) {
			content := "sleep 15\n"
			timeout := 20
			if scenario == "timeout" {
				timeout = 1
			}
			if scenario == "output" {
				content = "python3 -c 'print(\"x\"*300000)'\n"
			}
			service, script, runner := jobService(t, content)
			job, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, timeout, scenario)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "cancel" {
				if _, err = service.CancelScriptJob(context.Background(), job.Job.ID); err != nil {
					t.Fatal(err)
				}
			}
			result := waitJob(t, service, job.Job.ID)
			want := map[string]string{"timeout": "timed_out", "cancel": "cancelled", "output": "succeeded"}[scenario]
			if result.Status != want {
				t.Fatalf("want %s: %+v", want, result)
			}
			if len(result.StdoutTail) > 8192 {
				t.Fatal("unbounded output")
			}
			if scenario == "output" {
				info, err := os.Stat(filepath.Join(runner.home, ".lake-script-jobs", job.Job.ID, "stdout.log"))
				if err != nil || info.Size() > 131072 {
					t.Fatalf("disk log unbounded: %v %v", info, err)
				}
			}
		})
	}
}

func TestScriptJobApprovalWithdrawalAndChangedTargetBlockBeforeStart(t *testing.T) {
	for _, change := range []string{"withdraw", "target"} {
		t.Run(change, func(t *testing.T) {
			service, script, runner := jobService(t, "printf ok\n")
			service.Confirm = func(ctx context.Context, _, _ string) (bool, error) {
				if change == "withdraw" {
					_, err := service.Store.SetExecuteAuthz(ctx, script.ResourceID, false)
					return true, err
				}
				changeJobTarget(t, service, script.ResourceID)
				return true, nil
			}
			job, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, 20, change)
			if err != nil || job.Status != "not_started" || runner.starts != 0 {
				t.Fatalf("changed approval executed: %+v %v", job, err)
			}
		})
	}
}

// Only a temporary test DB is edited: emulate a concurrent resource update.
func changeJobTarget(t *testing.T, service *Service, resourceID string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(service.Store.Root(), "lake.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`UPDATE resource SET spec='{"ssh":{"host":"changed.invalid","port":22,"username":"root"}}' WHERE id=?`, resourceID)
	if err != nil {
		t.Fatal(err)
	}
}

func TestScriptJobChangedTargetBlocksStatusAndCancel(t *testing.T) {
	service, script, runner := jobService(t, "printf done\n")
	job, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, 20, "target-bound")
	if err != nil {
		t.Fatal(err)
	}
	waitJob(t, service, job.Job.ID)
	changeJobTarget(t, service, script.ResourceID)
	calls := runner.calls
	if _, err := service.ScriptJobStatus(context.Background(), job.Job.ID); err == nil {
		t.Fatal("status sent to changed target")
	}
	if _, err := service.CancelScriptJob(context.Background(), job.Job.ID); err == nil {
		t.Fatal("cancel sent to changed target")
	}
	if runner.calls != calls {
		t.Fatal("changed target reached SSH")
	}
}

func TestScriptJobRemoteSymlinkAndMissingStatusDoNotCreateOrReadPaths(t *testing.T) {
	service, script, runner := jobService(t, "printf ok\n")
	job, err := service.StartScriptJob(context.Background(), "host", script.ID, script.SHA256, 20, "link")
	if err != nil {
		t.Fatal(err)
	}
	_ = waitJob(t, service, job.Job.ID)
	dir := filepath.Join(runner.home, ".lake-script-jobs", job.Job.ID)
	if err = os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ScriptJobStatus(context.Background(), job.Job.ID); err == nil {
		t.Fatal("missing job accepted")
	}
	if _, err = os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only query created remote directory")
	}
	outside := t.TempDir()
	if err = os.Symlink(outside, dir); err != nil {
		t.Fatal(err)
	}
	if _, err = service.ScriptJobStatus(context.Background(), job.Job.ID); err == nil {
		t.Fatal("followed remote directory symlink")
	}
}
