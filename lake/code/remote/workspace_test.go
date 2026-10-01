package remote

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	sshtransport "github.com/cloudwego/eino/lake/transport/ssh"
)

type localShellRunner struct{}

func (localShellRunner) RunWithInput(ctx context.Context, _ sshtransport.Target, _ []byte, command string, input []byte) (sshtransport.Result, error) {
	process := exec.CommandContext(ctx, "sh", "-c", command)
	process.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	process.Stdout, process.Stderr = &stdout, &stderr
	err := process.Run()
	result := sshtransport.Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if exit, ok := err.(*exec.ExitError); ok {
		result.ExitCode = exit.ExitCode()
		return result, nil
	}
	return result, err
}

func TestRemoteShellWriteReadAndHashPrecondition(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	w := Workspace{Root: root, Target: sshtransport.Target{Host: "test", Port: 22, Username: "user"}, Key: []byte("fake"), Runner: localShellRunner{}}
	if err := w.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	content := []byte("package main\n")
	result, err := w.Write(context.Background(), "src/main.go", "absent", content)
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("write=%+v err=%v", result, err)
	}
	got, err := w.Read(context.Background(), "src/main.go")
	if err != nil || got != string(content) {
		t.Fatalf("read=%q err=%v", got, err)
	}
	result, err = w.Write(context.Background(), "src/main.go", "absent", []byte("overwrite"))
	if err != nil || result.ExitCode == 0 {
		t.Fatalf("stale write=%+v err=%v", result, err)
	}
	result, err = w.Write(context.Background(), "src/main.go", ContentSHA(content), []byte("package edited\n"))
	if err != nil || result.ExitCode != 0 {
		t.Fatalf("update=%+v err=%v", result, err)
	}
}

type fakeRunner struct {
	result  sshtransport.Result
	err     error
	calls   int
	command string
	input   []byte
}

func (f *fakeRunner) RunWithInput(_ context.Context, _ sshtransport.Target, _ []byte, command string, input []byte) (sshtransport.Result, error) {
	f.calls++
	f.command = command
	f.input = append([]byte(nil), input...)
	return f.result, f.err
}

func remoteFixture() (Workspace, *fakeRunner) {
	f := &fakeRunner{}
	return Workspace{Root: "/srv/project", Target: sshtransport.Target{Host: "example.test", Port: 22, Username: "ops"}, Key: []byte("private-key-test-placeholder"), Runner: f}, f
}

func TestRemoteListReadAndPathGuard(t *testing.T) {
	w, f := remoteFixture()
	f.result = sshtransport.Result{Stdout: "/srv/project\n"}
	if err := w.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.result = sshtransport.Result{Stdout: "./src/main.go\x00./.env\x00./src/../secret\x00"}
	files, err := w.List(context.Background())
	if err != nil || len(files) != 1 || files[0] != "src/main.go" {
		t.Fatalf("files=%v err=%v", files, err)
	}
	f.result = sshtransport.Result{Stdout: "hello\n"}
	text, err := w.Read(context.Background(), "src/main.go")
	if err != nil || text != "hello\n" {
		t.Fatalf("text=%q err=%v", text, err)
	}
	before := f.calls
	for _, path := range []string{"../secret", "/etc/passwd", ".env", "src/id_ed25519", "src/link/../../etc"} {
		if _, err := w.Read(context.Background(), path); err == nil {
			t.Fatalf("path %q allowed", path)
		}
	}
	if f.calls != before {
		t.Fatal("invalid path reached SSH")
	}
}

func TestRemoteWriteUnknownNeverRetriesAndHidesBody(t *testing.T) {
	w, f := remoteFixture()
	f.err = errors.New("disconnected")
	content := []byte("confidential test body")
	result, err := w.Write(context.Background(), "src/app.go", "absent", content)
	if err == nil || !result.Unknown || f.calls != 1 {
		t.Fatalf("result=%+v err=%v calls=%d", result, err, f.calls)
	}
	if strings.Contains(f.command, string(content)) || string(f.input) != string(content) {
		t.Fatal("write body was not streamed privately")
	}
	if !strings.Contains(f.command, "ln --") {
		t.Fatal("new file does not use no-clobber creation")
	}
	f.err = nil
	f.result = sshtransport.Result{Stdout: ContentSHA(content) + "\n"}
	result, err = w.Write(context.Background(), "src/app.go", "absent", content)
	if err != nil || result.Unknown {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if _, err := w.Write(context.Background(), "../outside", "absent", content); err == nil {
		t.Fatal("escape write accepted")
	}
}

func TestRemoteRunUnknownAndShellQuote(t *testing.T) {
	w, f := remoteFixture()
	f.err = errors.New("connection lost")
	result, err := w.Run(context.Background(), "printf 'ok'")
	if err == nil || !result.Unknown || f.calls != 1 {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if quote("a'b") != "'a'\"'\"'b'" {
		t.Fatalf("quote=%q", quote("a'b"))
	}
}
