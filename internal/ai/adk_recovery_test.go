package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestADKCrashApprovalHelper(t *testing.T) {
	if os.Getenv("LAKE_ADK_CRASH_HELPER") != "1" {
		t.Skip("subprocess fixture")
	}
	dir := os.Getenv("LAKE_ADK_CRASH_HOME")
	var bridge Bridge
	effect := os.Getenv("LAKE_ADK_CRASH_SCENARIO") == "effect"
	if effect {
		bridge = func(ctx context.Context, _ string, name string, _ map[string]any, _ bool) (any, error) {
			if name == "policy" {
				return map[string]any{"risk": "write", "target": "crash fixture", "fingerprint": "fixture-generation"}, nil
			}
			if name == "runtimeCommandExec" {
				f, err := os.OpenFile(filepath.Join(dir, "effect.txt"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					return nil, err
				}
				_, err = f.WriteString("once\n")
				if err == nil {
					err = f.Sync()
				}
				f.Close()
				if err != nil {
					return nil, err
				}
				if err = os.WriteFile(filepath.Join(dir, "effect-dispatched"), []byte("ready"), 0600); err != nil {
					return nil, err
				}
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return nil, nil
		}
	}
	engine, err := New(dir, bridge, nil)
	if err != nil {
		t.Fatal(err)
	}
	model := Model{URL: os.Getenv("LAKE_ADK_CRASH_PROVIDER"), Name: "fixture", Protocol: "openai", ContextWindow: 64000, MaxOutput: 8192}
	if err = engine.Configure("case", Config{ConversationMode: os.Getenv("LAKE_ADK_CRASH_MODE"), Model: model, Profile: "core", Workspace: dir, Permissions: &Permissions{SilentCommands: effect, SilentTerminalCreation: effect, SilentReadFiles: true, SilentReadSQL: true}}); err != nil {
		t.Fatal(err)
	}
	if err = engine.Chat(context.Background(), "case", "write the test file", nil); err != nil {
		t.Fatal(err)
	}
}

// Subprocess startup on Windows CI can include antivirus and private ACL setup.
// Bound readiness separately from the crash/once assertions, and retain child
// diagnostics so a startup failure cannot masquerade as a recovery failure.
func TestADKApprovalSurvivesProcessCrashAndExecutesOnce(t *testing.T) {
	home := t.TempDir()
	target := filepath.Join(home, "effect.txt")
	model, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "crash-write", Name: "append", Arguments: js(map[string]any{"path": target, "content": "once\n"})})
		}
		return response("complete")
	})
	defer close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(binary, "-test.run=^TestADKCrashApprovalHelper$", "-test.timeout=60s")
	var childOutput bytes.Buffer
	child.Stdout, child.Stderr = &childOutput, &childOutput
	child.Env = append(os.Environ(), "LAKE_ADK_CRASH_HELPER=1", "LAKE_ADK_CRASH_HOME="+home, "LAKE_ADK_CRASH_PROVIDER="+model.URL)
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	killed := false
	defer func() {
		if !killed {
			child.Process.Kill()
			child.Wait()
		}
	}()
	var saved State
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(filepath.Join(home, "case.json"))
		if err == nil && json.Unmarshal(raw, &saved) == nil && saved.View.Pending != nil && saved.Runtime != nil {
			// The UI pending record precedes the ADK confirmation event. Wait for its
			// durable event cursor before killing the process.
			if len(saved.Runtime.PendingConfirmations) > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if saved.View.Pending == nil || saved.Runtime == nil || len(saved.Runtime.PendingConfirmations) == 0 {
		_ = child.Process.Kill()
		_ = child.Wait()
		killed = true
		t.Fatalf("child did not persist a complete approval checkpoint: %s", childOutput.String())
	}
	if _, err = os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("effect occurred before approval")
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	killed = true
	restarted, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Shutdown()
	if err = restarted.Configure("case", Config{Model: model, Profile: "core", Workspace: home, Permissions: &Permissions{SilentReadFiles: true, SilentReadSQL: true}}); err != nil {
		t.Fatal(err)
	}
	view, err := restarted.Snapshot("case")
	if err != nil || view.Status != "waiting_approval" || view.Pending == nil {
		t.Fatalf("approval not recovered: status=%s err=%v", view.Status, err)
	}
	if err = restarted.Decision("case", view.Pending.ID, true, view.Pending.Confirmation); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		view, _ = restarted.Snapshot("case")
		if view.Status == "completed" || view.Status == "failed" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if view.Status != "completed" {
		t.Fatalf("resume did not complete: %s", js(view))
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "once\n" {
		t.Fatalf("effect count incorrect: %q %v", content, err)
	}
	if err = restarted.Decision("case", saved.View.Pending.ID, true, ""); err == nil {
		t.Fatal("duplicate approval accepted")
	}
	content, err = os.ReadFile(target)
	if err != nil || string(content) != "once\n" {
		t.Fatal("duplicate effect")
	}
}

func TestADKCrashAfterExternalEffectNeverReplaysUnknownOperation(t *testing.T) {
	home := t.TempDir()
	target := filepath.Join(home, "effect.txt")
	model, close := fakeModel(t, func(n int, _ map[string]any) any {
		if n <= 2 {
			return response("", Call{ID: "external-effect", Name: "shell", Arguments: `{"command":"synthetic-append"}`})
		}
		return response("original operation needs verification; no retry")
	})
	defer close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(binary, "-test.run=^TestADKCrashApprovalHelper$", "-test.timeout=60s")
	var childOutput bytes.Buffer
	child.Stdout, child.Stderr = &childOutput, &childOutput
	child.Env = append(os.Environ(), "LAKE_ADK_CRASH_HELPER=1", "LAKE_ADK_CRASH_SCENARIO=effect", "LAKE_ADK_CRASH_HOME="+home, "LAKE_ADK_CRASH_PROVIDER="+model.URL)
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	killed := false
	defer func() {
		if !killed {
			child.Process.Kill()
			child.Wait()
		}
	}()
	dispatched := false
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		if _, err = os.Stat(filepath.Join(home, "effect-dispatched")); err == nil {
			dispatched = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !dispatched {
		_ = child.Process.Kill()
		_ = child.Wait()
		killed = true
		t.Fatalf("external effect was never dispatched: %s", childOutput.String())
	}
	if err = child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	killed = true
	restarted, err := New(home, func(_ context.Context, _ string, name string, _ map[string]any, _ bool) (any, error) {
		if name == "policy" {
			return map[string]any{"risk": "write", "target": "crash fixture", "fingerprint": "fixture-generation"}, nil
		}
		if name == "runtimeCommandExec" {
			f, err := os.OpenFile(target, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				return nil, err
			}
			defer f.Close()
			_, err = f.WriteString("duplicate\n")
			return map[string]any{"exitCode": 0}, err
		}
		return nil, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Shutdown()
	if err = restarted.Configure("case", Config{Model: model, Profile: "core", Workspace: home, Permissions: &Permissions{SilentCommands: true, SilentTerminalCreation: true, SilentReadFiles: true, SilentReadSQL: true}}); err != nil {
		t.Fatal(err)
	}
	if err = restarted.Chat(context.Background(), "case", "inspect the interrupted operation", nil); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "once\n" {
		t.Fatalf("unknown operation replayed: %q %v", content, err)
	}
	store, err := restarted.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var unresolved int64
	if err = store.DB.Model(&nativeOperation{}).Where("status = ?", "unknown").Count(&unresolved).Error; err != nil || unresolved != 1 {
		t.Fatal("original unknown outcome was lost", unresolved, err)
	}
}

func TestADKQuestionSurvivesProcessCrashWithoutReplayingTools(t *testing.T) {
	home := t.TempDir()
	model, close := fakeModel(t, func(n int, input map[string]any) any {
		if n == 1 {
			return response("", Call{ID: "durable-question", Name: "ask_user_question", Arguments: js(map[string]any{"questions": []any{map[string]any{"id": "target", "title": "Choose the fixture target", "options": []any{map[string]any{"label": "test only"}}}}})})
		}
		if !strings.Contains(js(input["messages"]), "test only") {
			t.Error("human answer missing from resumed provider request")
		}
		return response("human answer restored")
	})
	defer close()
	binary, _ := os.Executable()
	child := exec.Command(binary, "-test.run=^TestADKCrashApprovalHelper$", "-test.timeout=60s")
	var childOutput bytes.Buffer
	child.Stdout, child.Stderr = &childOutput, &childOutput
	child.Env = append(os.Environ(), "LAKE_ADK_CRASH_HELPER=1", "LAKE_ADK_CRASH_HOME="+home, "LAKE_ADK_CRASH_PROVIDER="+model.URL)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	var state State
	ready := false
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
		raw, _ := os.ReadFile(filepath.Join(home, "case.json"))
		_ = json.Unmarshal(raw, &state)
		if nativeQuestionReady(state.View.Question) && state.Runtime != nil {
			ready = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("no durable official workflow question: %s", childOutput.String())
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	e, err := New(home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown()
	if err = e.Configure("case", Config{Model: model, Profile: "core", Workspace: home}); err != nil {
		t.Fatal(err)
	}
	if err = e.ReplyQuestion("case", state.View.Question.ID, map[string][]string{"target": {"test only"}}); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(15 * time.Second); ; {
		view, _ := e.Snapshot("case")
		if view.Status == "completed" {
			break
		}
		if view.Status == "failed" || time.Now().After(deadline) {
			t.Fatalf("question did not resume: %s %v", view.Status, view.Cards)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = e.ReplyQuestion("case", state.View.Question.ID, map[string][]string{"target": {"test only"}}); err == nil {
		t.Fatal("question reply replay accepted")
	}
}
