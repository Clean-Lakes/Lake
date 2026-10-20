package ai

import (
	"context"
	"testing"
	"time"
)

func TestShellOutputRestoresExactRecordAfterRestart(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value map[string]any
		want  string
	}{
		{"unknown", map[string]any{"status": "unknown", "output": "saved output"}, "unknown"},
		{"completed", map[string]any{"status": "completed", "exitCode": 0}, "completed"},
		{"failed", map[string]any{"status": "failed", "exitCode": 7}, "failed"},
		{"running", map[string]any{"status": "running", "exitCode": nil}, "running"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			calls := 0
			bridge := func(_ context.Context, session, tool string, args map[string]any, mutating bool) (any, error) {
				calls++
				if session != "case" || tool != "terminal_command_status" || args["terminal_id"] != "terminal" || args["entry_id"] != "entry" || mutating {
					t.Fatal("recovery attempted execution or read the wrong record")
				}
				return tc.value, nil
			}
			e, err := New(dir, bridge, nil)
			if err != nil {
				t.Fatal(err)
			}
			store, err := e.adkStore()
			if err != nil {
				t.Fatal(err)
			}
			row := nativeOperation{ID: "original-operation", SessionID: "case", Tool: "shell", Risk: "write", Status: "unknown", Handle: "terminal:entry", Result: `{"shell_id":"original-shell"}`, StartedAt: time.Now()}
			if err := store.DB.Create(&row).Error; err != nil {
				t.Fatal(err)
			}
			e.Shutdown()
			e, err = New(dir, bridge, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer e.Shutdown()
			for _, method := range []string{"shell_output", "wait_shell"} {
				for _, id := range []string{"original-operation", "original-shell"} {
					value, err := e.shellJob(context.Background(), "case", method, map[string]any{"shell_id": id})
					if err != nil {
						t.Fatal(err)
					}
					result := obj(value)
					if result["status"] != tc.want || result["shell_id"] != "original-shell" || obj(result["result"])["status"] != tc.value["status"] {
						t.Fatalf("incorrect recovered result: %#v", result)
					}
					if tc.want == "unknown" && result["notice"] == nil {
						t.Fatal("unknown result needs an explicit notice")
					}
				}
			}
			if calls != 4 {
				t.Fatalf("expected four reads, got %d", calls)
			}
			store, _ = e.adkStore()
			if err := store.DB.First(&row, "id = ?", row.ID).Error; err != nil {
				t.Fatal(err)
			}
			if row.Status != "unknown" {
				t.Fatal("reading a record changed the original outcome")
			}
			before := calls
			for _, args := range []struct{ session, method, id string }{
				{"other", "shell_output", "original-operation"},
				{"other", "shell_output", "original-shell"},
				{"case", "kill_shell", "original-operation"},
				{"case", "shell_output", "original"},
				{"case", "shell_output", "%"},
				{"case", "shell_output", ""},
			} {
				if _, err := e.shellJob(context.Background(), args.session, args.method, map[string]any{"shell_id": args.id}); err == nil {
					t.Fatalf("accepted invalid recovery: %#v", args)
				}
			}
			if calls != before {
				t.Fatal("invalid recovery reached terminal bridge")
			}
		})
	}
}
