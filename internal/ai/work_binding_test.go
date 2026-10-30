package ai

import (
	"context"
	"strings"
	"testing"
)

func TestWorkBeginUsesRequestedClusterInsteadOfOldSSHTerminal(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	c.Runtime, c.AssetRef, c.TerminalID = "ssh", "old-host", "old-terminal"
	c.Assets = []Asset{{ID: "old-host", Name: "京东云服务器", Kind: "ssh"}, {ID: "cluster", Name: "Nanjing-k1", Kind: "kubernetes", Settings: map[string]any{"endpoint": "https://cluster.invalid"}}}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	value, err := e.invokeWorkTool(context.Background(), s, c, Call{Name: "work_begin"}, map[string]any{"title": "检查 UWB", "items": []map[string]any{{"title": "检查工作负载"}}, "asset_refs": []string{assetAlias("cluster")}})
	if err != nil {
		t.Fatal(err)
	}
	goal := value.(WorkGoal)
	if goal.Binding.AssetRef != "cluster" || goal.Binding.Runtime != "kubernetes" || goal.Binding.TerminalID != "" || len(goal.ResourceBindings) != 1 || goal.Binding.ResourceIdentity == "" {
		t.Fatal("goal inherited foreground SSH", goal.Binding)
	}
	_, err = e.beginWork(s, "retarget", nil, assetAlias("old-host"))
	if err == nil {
		t.Fatal("silently rebound active goal")
	}
}

func TestWorkBindingFallbackOnlyUsesCurrentTurnOrTrustedScope(t *testing.T) {
	c := Config{Runtime: "ssh", AssetRef: "old", TerminalID: "stale", Assets: []Asset{{ID: "old", Kind: "ssh"}, {ID: "kube", Kind: "kubernetes"}, {ID: "other", Kind: "kubernetes"}}}
	oldCall := Message{Role: "assistant", Calls: []Call{{Name: "shell", Arguments: js(map[string]any{"asset_ref": assetAlias("old")})}}}
	currentCall := Message{Role: "assistant", Calls: []Call{{Name: "query_kubernetes", Arguments: js(map[string]any{"asset_ref": assetAlias("kube")})}}}
	h := []Message{oldCall, {Role: "user", Content: "核查 UWB"}, currentCall}
	bindings, err := requestedWorkBindings(c, nil, h, nil)
	if err != nil || len(bindings) != 1 || bindings[0].AssetRef != "kube" || bindings[0].TerminalID != "" {
		t.Fatal(bindings, err)
	}
	bindings, err = requestedWorkBindings(c, nil, h[:2], nil)
	if err != nil || len(bindings) != 0 {
		t.Fatal("old turn or foreground host became target", bindings, err)
	}
	bindings, err = requestedWorkBindings(c, &TargetScope{ResourceIDs: []string{"kube", "other"}}, h, nil)
	if err != nil || len(bindings) != 2 {
		t.Fatal("multi-resource scope lost", bindings, err)
	}
	if _, err = requestedWorkBindings(c, &TargetScope{ResourceIDs: []string{"kube"}}, h, []string{assetAlias("old")}); err == nil {
		t.Fatal("cross-scope goal accepted")
	}
	p := DefaultPermissions()
	p.BlockUnreferencedAssets = true
	c.Permissions = &p
	if _, err = requestedWorkBindings(c, nil, h, []string{assetAlias("kube")}); err == nil {
		t.Fatal("unreferenced goal accepted")
	}
	c.ReferencedAssets = []string{"kube"}
	if _, err = requestedWorkBindings(c, nil, h, []string{assetAlias("kube")}); err != nil {
		t.Fatal(err)
	}
}

func TestWorkRecoveryValidatesEveryResourceIdentity(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	g := seedObservedWork(t, e)
	row, g, _ := e.workRow("case", g.ID)
	g.Binding = WorkBinding{}
	g.ResourceBindings = []WorkBinding{{AssetRef: "one", ResourceIdentity: hash(js(Asset{ID: "one", Kind: "kubernetes"}))}, {AssetRef: "two", ResourceIdentity: "old-configuration"}}
	if err := e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	c := s.state.Config
	c.Assets = []Asset{{ID: "one", Kind: "kubernetes"}, {ID: "two", Kind: "kubernetes"}}
	if err := e.resumeWorkGoal(context.Background(), row, g, c); err != nil {
		t.Fatal(err)
	}
	_, after, _ := e.workRow("case", g.ID)
	if after.Status != "blocked" || !strings.Contains(after.Summary, "原资源绑定已变化") {
		t.Fatal("changed secondary resource was ignored", after.Status)
	}
}

func TestWorkResourceBindsFromValidatedFirstOperationWhenModelOmittedRefs(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	c := s.state.Config
	c.Runtime, c.AssetRef, c.TerminalID = "ssh", "old", "old-terminal"
	c.Assets = []Asset{{ID: "old", Kind: "ssh"}, {ID: "kube", Kind: "kubernetes"}}
	if err := e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	g, err := e.beginWork(s, "UWB", nil)
	if err != nil {
		t.Fatal(err)
	}
	if g.Binding.AssetRef != "" {
		t.Fatal("foreground target was inherited")
	}
	if err = e.recordWorkResource(s, c, "kube"); err != nil {
		t.Fatal(err)
	}
	_, g, _ = e.workRow("case", g.ID)
	if g.Binding.AssetRef != "kube" || g.Binding.TerminalID != "" {
		t.Fatal("actual operation target not bound", g.Binding)
	}
}
