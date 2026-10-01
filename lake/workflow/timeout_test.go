package workflow

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

type slowSSHExecutor struct {
	client     sshtransport.Client
	target     sshtransport.Target
	key        []byte
	executions *atomic.Int32
}

func (e *slowSSHExecutor) RunRead(ctx context.Context, _, command string) (sshtransport.Result, error) {
	return e.client.Run(ctx, e.target, e.key, command)
}

func (e *slowSSHExecutor) RunCommand(ctx context.Context, resource, command string) (sshtransport.Result, error) {
	result, err := e.RunRead(ctx, resource, command)
	if err != nil && !errors.Is(err, sshtransport.ErrNotStarted) {
		err = fmt.Errorf("%w: %w", ErrExecutionUnknown, err)
	}
	return result, err
}

func slowTestSSH(t *testing.T) *slowSSHExecutor {
	t.Helper()
	_, hostKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatal(err)
	}
	_, clientKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	privateBlock, err := ssh.MarshalPrivateKey(clientKey, "workflow-timeout-test")
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return nil, nil }}
	config.AddHostKey(hostSigner)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	var executions atomic.Int32
	go func() {
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer raw.Close()
				_, channels, requests, err := ssh.NewServerConn(raw, config)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(requests)
				for channel := range channels {
					ch, reqs, err := channel.Accept()
					if err != nil {
						return
					}
					for request := range reqs {
						if request.Type != "exec" {
							request.Reply(false, nil)
							continue
						}
						executions.Add(1)
						request.Reply(true, nil)
						ch.Write([]byte("scan started\n"))
						time.Sleep(350 * time.Millisecond)
						ch.Write([]byte("scan completed\n"))
						ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
						ch.Close()
						return
					}
				}
			}()
		}
	}()
	known := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(known, []byte(knownhosts.Line([]string{listener.Addr().String()}, hostSigner.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return &slowSSHExecutor{client: sshtransport.Client{KnownHostsPath: known, Timeout: 150 * time.Millisecond}, target: sshtransport.Target{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "test"}, key: pem.EncodeToMemory(privateBlock), executions: &executions}
}

func TestWorkflowCommandTimeoutAndParentCancellation(t *testing.T) {
	for _, scenario := range []struct {
		name               string
		timeout            int
		parent             time.Duration
		status, stepStatus string
	}{
		{"long_scan", 1, 0, "completed", "completed"},
		{"original_default", 0, 0, "failed", "unknown"},
		{"parent_cancellation", 1, 100 * time.Millisecond, "interrupted", "unknown"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			def := Definition{Name: "scan-timeout", ExecutionMode: "fixed", Steps: []Step{{ID: "scan", Name: "Scan", Kind: "ssh_command", Resource: "test", Command: "scan", TimeoutSeconds: scenario.timeout}}}
			s, saved := savedWorkflow(t, def)
			executor := slowTestSSH(t)
			ctx := context.Background()
			if scenario.parent > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, scenario.parent)
				defer cancel()
			}
			run, err := Start(ctx, s, saved, "cli", executor, nil)
			if err != nil || run.Status != scenario.status || run.Steps[0].Status != scenario.stepStatus {
				t.Fatalf("run=%+v err=%v", run, err)
			}
			if executor.executions.Load() != 1 {
				t.Fatalf("remote command replayed: %d", executor.executions.Load())
			}
			var snapshot Definition
			if err := json.Unmarshal(run.Spec, &snapshot); err != nil || snapshot.Steps[0].TimeoutSeconds != scenario.timeout {
				t.Fatalf("timeout lost from snapshot: %s %v", run.Spec, err)
			}
			if scenario.stepStatus == "completed" && run.Steps[0].Stdout != "scan started\nscan completed\n" {
				t.Fatalf("incomplete successful output: %+v", run.Steps[0])
			}
			if scenario.stepStatus == "unknown" && run.Steps[0].ExitCode != nil {
				t.Fatal("unknown execution has a known exit code")
			}
		})
	}
}

func TestWorkflowTimeoutBounds(t *testing.T) {
	for _, value := range []int{-1, 0, 1, 300, 3600, 3601} {
		def := Definition{Name: "bounds", Steps: []Step{{ID: "scan", Name: "Scan", Kind: "ssh_command", Resource: "test", Command: "scan", TimeoutSeconds: value}}}
		err := Validate(def)
		if (err == nil) != (value >= 0 && value <= 3600) {
			t.Fatalf("timeout=%d err=%v", value, err)
		}
	}
}
