package ai

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestModelControlsParallelDispatchAndOptionalReview(t *testing.T) {
	for _, delegate := range []bool{false, true} {
		t.Run(fmt.Sprint(delegate), func(t *testing.T) {
			var roots, active, peak, observed atomic.Int32
			var mu sync.Mutex
			steps := map[string]int{}
			assets := []Asset{}
			refs := []map[string]any{}
			specs := []investigationSpec{}
			for i := 0; i < 5; i++ {
				id := fmt.Sprintf("host%d", i)
				assets = append(assets, Asset{ID: id, Name: id, Kind: "local"})
				refs = append(refs, map[string]any{"asset_ref": id})
				specs = append(specs, investigationSpec{Role: "host", Task: "Read node state", AssetRefs: []string{assetAlias(id)}})
			}
			model, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
				role := fixtureRole(body)
				text := js(body["messages"])
				if role == "parent" {
					n := roots.Add(1)
					if n == 1 {
						if observed.Load() != 0 || strings.Contains(text, `"role":"tool"`) {
							t.Error("execution preceded the model's decision")
						}
						if delegate {
							return response("", Call{"split", "delegate_investigation", js(map[string]any{"tasks": specs})})
						}
					}
					return response("根据现有信息回答；未声明独立复核。")
				}
				if role != "host" {
					t.Error("runtime added an unrequested verifier")
				}
				alias := ""
				for _, asset := range assets {
					if strings.Contains(text, assetAlias(asset.ID)) {
						alias = assetAlias(asset.ID)
					}
				}
				mu.Lock()
				steps[alias]++
				n := steps[alias]
				mu.Unlock()
				if n == 1 {
					if strings.Contains(text, `"role":"tool"`) {
						t.Error("child received a fixed observation prelude")
					}
					if !strings.Contains(js(body["tools"]), "observe_cluster") {
						t.Error("Scout cannot choose cluster investigation")
					}
					p := active.Add(1)
					for p > peak.Load() && !peak.CompareAndSwap(peak.Load(), p) {
					}
					time.Sleep(40 * time.Millisecond)
					active.Add(-1)
					observed.Add(1)
					return response("", Call{"read", "observe_host", js(map[string]any{"asset_ref": alias, "metric": "processes"})})
				}
				return response("本节点实际证据：" + strings.Join(evidenceReference.FindAllString(text, -1), ", "))
			})
			defer closeModel()
			e := engineFor(t, model, nil)
			if err := e.Configure("case", Config{legacyInvestigations: true, Model: model, Profile: "core", MultiAgentMode: "auto", Assets: assets}); err != nil {
				t.Fatal(err)
			}
			if err := e.Chat(context.Background(), "case", "查看新k8s集群所有节点状态", refs); err != nil {
				t.Fatal(err)
			}
			v, _ := e.Snapshot("case")
			if !delegate && (len(v.AgentRuns) != 0 || len(v.Cards) != 2 || roots.Load() != 1) {
				t.Fatal("node wording started execution without a model call")
			}
			if delegate && (len(v.AgentRuns) != 5 || roots.Load() != 2 || peak.Load() < 2) {
				t.Fatalf("model-selected five-task batch did not run in parallel: agents=%d calls=%d peak=%d", len(v.AgentRuns), roots.Load(), peak.Load())
			}
			for _, run := range v.AgentRuns {
				if run.Status != "completed" || run.ToolCount != 1 || run.AutomaticSurvey {
					t.Fatalf("child did not select its actual observation: %s %s", run.Name, run.Status)
				}
			}
			s, _ := e.get("case")
			for _, row := range e.investigationReports(s, false) {
				if len(row["resources"].([]map[string]any)) != 1 || row["verification_status"] != "not_requested" {
					t.Fatal("missing actual resource mapping or invented verification")
				}
			}
		})
	}
}
