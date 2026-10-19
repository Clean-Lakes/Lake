package ai

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestADKSuccessiveConfirmationsDoNotInvalidateRunnerSession(t *testing.T) {
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "first.txt"), filepath.Join(dir, "second.txt")}
	m, closeModel := fakeModel(t, func(n int, _ map[string]any) any {
		if n <= 2 {
			return response("", Call{ID: fmt.Sprintf("fixture-append-%d", n), Name: "append", Arguments: js(map[string]any{"path": paths[n-1], "content": "once\n"})})
		}
		return response("both changes recorded")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- e.Chat(ctx, "case", "write two fixture files", nil) }()
	s, _ := e.get("case")
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case err := <-result:
			history, _ := e.History("case")
			var tools []Message
			for _, message := range history {
				if message.Role == "tool" {
					tools = append(tools, message)
				}
			}
			t.Fatalf("turn ended before both confirmations: %v; fixture tools: %s", err, js(tools))
		default:
		}
		s.mu.Lock()
		var p *Approval
		if s.state.View.Pending != nil && s.state.Runtime != nil && s.state.Runtime.PendingConfirmations[s.state.View.Pending.ID] != "" {
			copy := *s.state.View.Pending
			p = &copy
		}
		s.mu.Unlock()
		if p != nil && !seen[p.ID] {
			if err := e.Decision("case", p.ID, true, p.Confirmation); err != nil {
				t.Fatal(err)
			}
			seen[p.ID] = true
		}
		select {
		case <-ctx.Done():
			t.Fatal("confirmation timeout")
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	for _, p := range paths {
		body, err := os.ReadFile(p)
		if err != nil || string(body) != "once\n" {
			t.Fatalf("effect must execute once: %q %v", body, err)
		}
	}
}
