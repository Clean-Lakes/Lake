package operate

import (
	"context"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type fakeKeys struct{ loaded int }

func (f *fakeKeys) Load(string) ([]byte, error) {
	f.loaded++
	return []byte("test-private-key"), nil
}

type fakeSSH struct {
	calls   int
	command string
}

type fakePersistentSSH struct {
	runs   int
	closed bool
}

func (f *fakePersistentSSH) Run(_ context.Context, command string) (sshtransport.Result, error) {
	f.runs++
	return sshtransport.Result{Stdout: "persistent:" + command}, nil
}

func (f *fakePersistentSSH) Close() error {
	f.closed = true
	return nil
}

func (f *fakePersistentSSH) IsClosed() bool { return f.closed }

func (f *fakeSSH) Run(_ context.Context, _ sshtransport.Target, _ []byte, command string) (sshtransport.Result, error) {
	f.calls++
	f.command = command
	return sshtransport.Result{Stdout: "ok\n"}, nil
}

func TestSSHAuthorizationAndFixedReadCommand(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "host",
		SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "keychain:ssh/00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	keys := &fakeKeys{}
	transport := &fakeSSH{}
	service.Keys, service.Runner = keys, transport
	if _, err := service.RunRead(ctx, "host", "uptime"); err == nil || !strings.Contains(err.Error(), "尚未开启执行授权") {
		t.Fatalf("expected authorization error, got %v", err)
	}
	if keys.loaded != 0 || transport.calls != 0 {
		t.Fatal("unauthorized SSH call accessed credentials or network")
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunRead(ctx, "host", "uptime; rm -rf /"); err == nil {
		t.Fatal("arbitrary command accepted")
	}
	result, err := service.RunRead(ctx, "host", "uptime")
	if err != nil || result.Stdout != "ok\n" || transport.command != "uptime" || transport.calls != 1 {
		t.Fatalf("SSH result=%+v err=%v command=%q", result, err, transport.command)
	}
	journal, err := s.ListJournal(ctx, store.JournalFilter{RunID: service.RunID})
	if err != nil || len(journal) != 5 || journal[0].Event != "completed" || journal[3].Event != "denied" || journal[4].Event != "requested" {
		t.Fatalf("journal=%+v err=%v", journal, err)
	}
	if _, err := service.RunRead(ctx, "host", "cpu"); err != nil || !strings.Contains(transport.command, "/proc/stat") {
		t.Fatalf("CPU check did not use fixed /proc/stat sample: command=%q err=%v", transport.command, err)
	}
	if _, err := service.RunCommand(ctx, "host", "echo ok"); err == nil {
		t.Fatal("command ran without human confirmation")
	}
	if transport.calls != 2 {
		t.Fatal("unconfirmed command reached SSH transport")
	}
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	if _, err := service.RunCommand(ctx, "host", "echo ok"); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 3 || transport.command != "echo ok" {
		t.Fatal("approved command did not reach SSH transport")
	}
	if _, err := service.RunCommand(ctx, "host", "rm -rf /"); err == nil {
		t.Fatal("blocked command accepted")
	}
	if _, err := service.RunCommand(ctx, "host", "echo ok\x1b[2J"); err == nil {
		t.Fatal("terminal control sequence accepted")
	}
	journal, err = s.ListJournal(ctx, store.JournalFilter{RunID: service.RunID})
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range journal {
		if strings.Contains(entry.Detail, "echo ok") {
			t.Fatal("raw command leaked into journal")
		}
	}
}

func TestSSHPermissionPolicyUpdatesLiveService(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "keychain:ssh/00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	transport := &fakeSSH{}
	service.Keys, service.Runner = &fakeKeys{}, transport
	if _, err := service.RunRead(ctx, "host", "uptime"); err != nil || transport.calls != 1 {
		t.Fatalf("default read check = %v; calls=%d", err, transport.calls)
	}
	if _, err := service.RunCommand(ctx, "host", "echo ok"); err == nil || transport.calls != 1 {
		t.Fatalf("default command required approval: %v; calls=%d", err, transport.calls)
	}
	if _, err := s.SetPermissionPolicy(ctx, "ssh-command", true); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunCommand(ctx, "host", "echo ok"); err != nil || transport.calls != 2 {
		t.Fatalf("silent command = %v; calls=%d", err, transport.calls)
	}
	if _, err := s.SetPermissionPolicy(ctx, "ssh-read", false); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunRead(ctx, "host", "uptime"); err == nil || transport.calls != 2 {
		t.Fatalf("read check required approval: %v; calls=%d", err, transport.calls)
	}
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	if _, err := service.RunRead(ctx, "host", "uptime"); err != nil || transport.calls != 3 {
		t.Fatalf("approved read check = %v; calls=%d", err, transport.calls)
	}
	journal, err := s.ListJournal(ctx, store.JournalFilter{RunID: service.RunID})
	if err != nil {
		t.Fatal(err)
	}
	foundSilentApproval := false
	for _, entry := range journal {
		foundSilentApproval = foundSilentApproval || entry.Event == "approved" && entry.Detail == "silent_ssh_command_policy"
	}
	if !foundSilentApproval {
		t.Fatal("silent command approval missing from journal")
	}
}

func TestPersistentSSHSessionReusesConnectionAndCloses(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "测试湖", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UseLake(ctx, lake.ID); err != nil {
		t.Fatal(err)
	}
	host, err := s.CreateHost(ctx, store.ResourceInput{
		LakeID: lake.ID, Name: "host", SSH: store.SSHSpec{Host: "127.0.0.1", Port: 22, Username: "root"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, host.ID, "keychain:ssh/00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	defer service.CloseSessions()
	keys := &fakeKeys{}
	oneshot := &fakeSSH{}
	persistent := &fakePersistentSSH{}
	opened := 0
	service.Keys, service.Runner = keys, oneshot
	service.Opener = func(context.Context, sshtransport.Target, []byte) (SSHConnection, error) {
		opened++
		return persistent, nil
	}
	if _, err := service.OpenSession(ctx, "host"); err == nil || !strings.Contains(err.Error(), "尚未开启执行授权") {
		t.Fatalf("expected authorization error, got %v", err)
	}
	if opened != 0 || keys.loaded != 0 {
		t.Fatal("unauthorized open accessed credentials or network")
	}
	if _, err := s.SetExecuteAuthz(ctx, host.ID, true); err != nil {
		t.Fatal(err)
	}
	status, err := service.OpenSession(ctx, "host")
	if err != nil || status.Resource != "测试湖/host" || status.State != "connected" {
		t.Fatalf("open status=%+v err=%v", status, err)
	}
	if _, err := service.OpenSession(ctx, "host"); err != nil || opened != 1 || keys.loaded != 1 {
		t.Fatalf("reopening did not reuse connection: opened=%d keys=%d err=%v", opened, keys.loaded, err)
	}
	result, err := service.RunRead(ctx, "host", "uptime")
	if err != nil || result.Stdout != "persistent:uptime" || persistent.runs != 1 || oneshot.calls != 0 || keys.loaded != 1 {
		t.Fatalf("persistent run=%+v err=%v runs=%d oneshot=%d keys=%d", result, err, persistent.runs, oneshot.calls, keys.loaded)
	}
	if _, err := service.RunCommand(ctx, "host", "echo ok"); err == nil || persistent.runs != 1 {
		t.Fatalf("unconfirmed command reached persistent connection: runs=%d err=%v", persistent.runs, err)
	}
	service.Confirm = func(context.Context, string, string) (bool, error) { return true, nil }
	if _, err := service.RunCommand(ctx, "host", "echo ok"); err != nil || persistent.runs != 2 {
		t.Fatalf("approved command did not use persistent connection: runs=%d err=%v", persistent.runs, err)
	}
	if sessions := service.ListSessions(); len(sessions) != 1 || sessions[0].Resource != "测试湖/host" {
		t.Fatalf("sessions=%+v", sessions)
	}
	if err := service.CloseSession(ctx, "host"); err != nil || !persistent.closed || len(service.ListSessions()) != 0 {
		t.Fatalf("close err=%v closed=%t sessions=%+v", err, persistent.closed, service.ListSessions())
	}
	if _, err := service.RunRead(ctx, "host", "uptime"); err != nil || oneshot.calls != 1 || keys.loaded != 2 {
		t.Fatalf("one-shot fallback after close: calls=%d keys=%d err=%v", oneshot.calls, keys.loaded, err)
	}
	reopened := &fakePersistentSSH{}
	service.Opener = func(context.Context, sshtransport.Target, []byte) (SSHConnection, error) {
		return reopened, nil
	}
	if _, err := service.OpenSession(ctx, "host"); err != nil {
		t.Fatal(err)
	}
	service.CloseSessions()
	if !reopened.closed || len(service.ListSessions()) != 0 {
		t.Fatalf("agent shutdown left SSH connection open: closed=%t sessions=%+v", reopened.closed, service.ListSessions())
	}
}
