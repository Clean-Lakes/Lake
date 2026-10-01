package remote

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type testKeys struct{}

func (testKeys) Load(string) ([]byte, error) { return []byte("fake-private-key"), nil }

type failingKeys struct{}

func (failingKeys) Load(string) ([]byte, error) {
	return nil, errors.New("synthetic-private-key-marker")
}

func TestServiceRequiresIndependentAuthorizationAndDoesNotRetryUnknown(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "ops", "")
	if err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{LakeID: lake.ID, Name: "node", SSH: store.SSHSpec{Host: "example.test", Port: 22, Username: "ops"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "file:ssh/test"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{result: sshtransport.Result{Stdout: "/srv/repo\n"}}
	service := Service{Store: s, Runner: runner, Keys: testKeys{}, Approve: func(_, _, _ string) (bool, error) { return true, nil }}
	item, err := service.Register(ctx, "ops", "ops/node", "repo", "/srv/repo")
	if err != nil || item.Authorized {
		t.Fatalf("workspace=%+v err=%v", item, err)
	}
	calls := runner.calls
	if _, err := service.List(ctx, item.ID); err == nil || runner.calls != calls {
		t.Fatalf("unauthorized list reached SSH: calls=%d err=%v", runner.calls, err)
	}
	if _, err := s.SetCodeWorkspaceAuthorized(ctx, item.ID, true); err != nil {
		t.Fatal(err)
	}
	runner.result = sshtransport.Result{Stdout: "./main.go\x00"}
	files, err := service.List(ctx, item.ID)
	if err != nil || len(files) != 1 {
		t.Fatalf("files=%v err=%v", files, err)
	}
	service.Approve = func(_, _, _ string) (bool, error) { return false, nil }
	calls = runner.calls
	if _, err := service.Run(ctx, item.ID, "echo denied"); err == nil || runner.calls != calls {
		t.Fatalf("denied run reached SSH: %v", err)
	}
	service.Approve = func(_, _, _ string) (bool, error) { return true, nil }
	runner.err = errors.New("network lost with synthetic-private-key-marker")
	result, err := service.Run(ctx, item.ID, "echo confidential-command")
	if err == nil || !result.Unknown || runner.calls != calls+1 || strings.Contains(err.Error(), "synthetic-private-key-marker") {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, runner.calls)
	}
	write, err := service.Write(ctx, item.ID, "note.txt", "absent", []byte("synthetic-private-key-marker"))
	if err == nil || !write.Unknown || strings.Contains(err.Error(), "synthetic-private-key-marker") || runner.calls != calls+2 {
		t.Fatalf("write=%+v err=%v calls=%d", write, err, runner.calls)
	}
	service.Keys = failingKeys{}
	if _, err := service.List(ctx, item.ID); err == nil || strings.Contains(err.Error(), "synthetic-private-key-marker") {
		t.Fatalf("credential error leaked: %v", err)
	}
	entries, err := s.ListJournal(ctx, store.JournalFilter{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	seenUnknown := false
	for _, entry := range entries {
		if strings.Contains(entry.Detail, "confidential-command") || strings.Contains(entry.Detail, "synthetic-private-key-marker") {
			t.Fatal("command leaked to journal")
		}
		if entry.Event == "unknown" {
			seenUnknown = true
			if entry.ExitCode != nil {
				t.Fatalf("unknown result has fabricated exit code: %+v", entry)
			}
		}
	}
	if !seenUnknown {
		t.Fatal("unknown result not journaled")
	}
}
