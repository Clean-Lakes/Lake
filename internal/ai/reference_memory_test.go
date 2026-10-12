package ai

import (
	"context"
	"strings"
	"testing"
)

func TestReferenceMemoryPersistsPrunesAndClears(t *testing.T) {
	m, close := fakeModel(t, func(_ int, _ map[string]any) any { return response("done") })
	defer close()
	e := engineFor(t, m, nil)
	c := Config{Model: m, Runtime: "local", Assets: []Asset{{ID: "inside", Kind: "local"}, {ID: "outside", Kind: "local"}}}
	e.Configure("case", c)
	if err := e.Chat(context.Background(), "case", "remember", []map[string]any{{"asset_ref": "inside"}}); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "case", "continue", nil); err != nil {
		t.Fatal(err)
	}
	ids, _ := e.ReferencedAssets("case")
	if len(ids) != 1 || ids[0] != "inside" {
		t.Fatal(ids)
	}
	reopened, _ := New(e.Dir, nil, nil)
	ids, _ = reopened.ReferencedAssets("case")
	if len(ids) != 1 {
		t.Fatal("memory not persisted")
	}
	c.Assets = c.Assets[1:]
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	ids, _ = e.ReferencedAssets("case")
	if len(ids) != 0 {
		t.Fatal("deleted asset remembered")
	}
	e.Chat(context.Background(), "case", "remember another", []map[string]any{{"asset_ref": "outside"}})
	e.ClearReferences("case")
	ids, _ = e.ReferencedAssets("case")
	if len(ids) != 0 {
		t.Fatal("memory not cleared")
	}
}
func TestTurnContextSeparateBoundsAndCwdBudget(t *testing.T) {
	c := Config{Model: Model{ContextWindow: 64000, MaxOutput: 8192}}
	input := TurnInput{UserText: strings.Repeat("中", 100000), Context: "current_cwd: /tmp\n" + strings.Repeat("evidence", 10000)}
	if err := input.validate(); err != nil {
		t.Fatal(err)
	}
	clipped := boundedTurnContext("question", input.Context, c)
	if !strings.Contains(clipped, "current_cwd: /tmp") || !strings.Contains(clipped, "truncated") {
		t.Fatal("cwd lost during context trimming")
	}
	input.Context = strings.Repeat("x", (2<<20)+1)
	if input.validate() == nil {
		t.Fatal("unbounded internal context")
	}
}
