package ai

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestStrategyRetiredLearningNeverCapturesSignals(t *testing.T) {
	for _, text := range []string{"以后请用中文回答。", "Check the current status"} {
		t.Run(text, func(t *testing.T) {
			m, done := fakeModel(t, func(n int, r map[string]any) any {
				if strings.Contains(js(r["tools"]), onlineRevisionTool) {
					t.Error("retired tool registered")
				}
				if n == 1 {
					return response("", Call{ID: "failed", Name: "read", Arguments: `{"path":"/synthetic/missing"}`})
				}
				return response("The observation failed; continuing normally.")
			})
			defer done()
			e := engineFor(t, m, func(context.Context, string, string, map[string]any, bool) (any, error) { return nil, os.ErrNotExist })
			s, _ := e.get("case")
			c := s.state.Config
			c.MemoryProjectID = "project"
			if err := e.Configure("case", c); err != nil {
				t.Fatal(err)
			}
			if err := e.ExecuteTurn(context.Background(), "case", TurnInput{StrategyMessageID: "genuine", UserText: text}); err != nil {
				t.Fatal(err)
			}
			out, err := e.StrategyOutbox("case")
			if err != nil || len(out) != 0 {
				t.Fatal("retired source captured", out, err)
			}
		})
	}
}
