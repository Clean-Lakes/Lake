package ai

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestLargeAgentEvidenceUsesBoundedModelHandoffs(t *testing.T) {
	var logPath, ref string
	var mu sync.Mutex
	steps := map[string]int{}
	m, closeModel := fakeModel(t, func(_ int, b map[string]any) any {
		role := fixtureRole(b)
		mu.Lock()
		steps[role]++
		step := steps[role]
		mu.Unlock()
		if role == "parent" {
			if step == 1 {
				return response("", Call{"delegate", "delegate_investigation", js(map[string]any{"tasks": []investigationSpec{{Role: "application", Task: "Read fixture log", AssetRefs: []string{ref}, Context: strings.Repeat("bounded handoff ", 850)}}})})
			}
			if step == 2 {
				return response("", Call{"verify", "delegate_investigation", js(map[string]any{"tasks": []investigationSpec{{Role: "verify", Task: "Review observed data"}}})})
			}
			return response("result")
		}
		if step == 1 {
			if role == "verify" {
				return response("", Call{"raw", "read_evidence", `{}`})
			}
			return response("", Call{"logs", "observe_logs", js(map[string]any{"asset_ref": ref, "path": logPath})})
		}
		serialized := js(b["messages"])
		if len(serialized) > 25000 {
			t.Error("large raw output filled the child context")
		}
		return response("Observed evidence: " + strings.Join(evidenceReference.FindAllString(serialized, -1), " "))
	})
	defer closeModel()
	e, path, alias := fixtureMultiEngine(t, m, true)
	logPath, ref = path, alias
	if err := os.WriteFile(logPath, []byte(strings.Repeat("LARGE_FIXTURE_LOG ", 2200)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := e.Chat(context.Background(), "case", "Investigate this log", multiReferences()); err != nil {
		t.Fatal(err)
	}
	v, _ := e.Snapshot("case")
	if len(v.AgentRuns) != 2 {
		t.Fatal("independent verification missing")
	}
	for _, run := range v.AgentRuns {
		if run.Status != "completed" {
			t.Fatalf("bounded handoff failed: %s %s", run.Name, run.Summary)
		}
	}
	if len(v.AgentRuns[0].Evidence[0].Excerpt) < 4000 {
		t.Fatal("recorded detail was reduced to the model excerpt")
	}
}
