package ai

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPilotGrepZeroMatchesIsACompletedObservation(t *testing.T) {
	grep, err := exec.LookPath("grep")
	if err != nil {
		t.Skip("grep unavailable")
	}
	p := filepath.Join(t.TempDir(), "sample.log")
	if err = os.WriteFile(p, []byte("ordinary log\n"), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(grep, "-c", "ERROR", p).CombinedOutput()
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("expected grep no-match exit, got %v", err)
	}
	exit := exitError.ExitCode()
	if exit != 1 || string(output) != "0\n" {
		t.Fatalf("unexpected actual grep outcome: %d %q", exit, output)
	}
	child, _, c, repo := pilotDelegationFixture(t, "step")
	repo.task.Attempts[0].Status = "running"
	call := Call{ID: "zero", Name: "shell", Arguments: js(map[string]any{"command": "grep -c 'ERROR' sample.log"})}
	if err = child.PrepareSREOperation(c, call, "readonly"); err != nil {
		t.Fatal(err)
	}
	if err = child.DispatchSREOperation(context.Background(), c, call); err != nil {
		t.Fatal(err)
	}
	result := map[string]any{"status": "completed", "finishedAt": timestamp(), "output": string(output), "exitCode": exit}
	child.finishSREOperation(c, call, result, nil)
	if repo.task.Attempts[0].Operations[0].Status != "succeeded" {
		t.Fatal("zero matches became failed check")
	}
	if err = pilotAttemptError(repo.task, repo.task.Attempts[0], SREPlanStep{ID: "logs", Kind: "observe"}); err != nil {
		t.Fatal(err)
	}
	if _, err = child.recordSREToolResult(c, call, map[string]any{"asset_ref": "fixture-host"}, result, nil); err != nil {
		t.Fatal(err)
	}
	evidence := repo.task.Attempts[0].Evidence
	if len(evidence) != 1 || !evidence[0].Success || evidence[0].ExitCode == nil || *evidence[0].ExitCode != 1 {
		t.Fatal("no-match evidence lost its successful collection or raw exit code")
	}
	if repo.task.Attempts[0].Operations[0].Result == "" {
		t.Fatal("raw exit code and output were not preserved")
	}
}

func TestPilotNoMatchRecognitionDoesNotHideOtherFailures(t *testing.T) {
	result := func() map[string]any {
		return map[string]any{"status": "completed", "finishedAt": timestamp(), "output": "\x1b[?2004l\r0\r\n", "exitCode": 1}
	}
	for _, command := range []string{"grep -c ERROR sample.log", "grep -ciE 'error|panic' /var/log/messages", "/usr/bin/grep --count 'ERROR' sample.log"} {
		if !sreReadNoMatches(Call{Name: "shell", Arguments: js(map[string]any{"command": command})}, result()) {
			t.Fatal(command)
		}
	}
	for _, command := range []string{"grep -c ERROR x | false", "grep -c ERROR x; false", "grep -c ERROR x && false", "! grep -c ERROR x", "bash -c 'grep -c ERROR x'", "printf 0", "grep -n ERROR x", "grep -c ERROR $(touch x)", "grep -c ERROR x > output", "/tmp/grep -c ERROR x"} {
		if sreReadNoMatches(Call{Name: "shell", Arguments: js(map[string]any{"command": command})}, result()) {
			t.Fatal("misclassified", command)
		}
	}
	for _, variant := range []string{"exit2", "running", "missing_end", "stderr", "truncated", "unknown_tool"} {
		r := result()
		call := Call{Name: "shell", Arguments: `{"command":"grep -c ERROR x"}`}
		switch variant {
		case "exit2":
			r["exitCode"] = 2
		case "running":
			r["status"] = "running"
		case "missing_end":
			delete(r, "finishedAt")
		case "stderr":
			r["output"] = "grep: missing file\n0\n"
		case "truncated":
			r["truncated"] = true
		case "unknown_tool":
			call.Name = "call_mcp_tool"
		}
		if sreReadNoMatches(call, r) {
			t.Fatal("hid real failure", variant)
		}
	}
}
