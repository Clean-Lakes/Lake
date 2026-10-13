package ai

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
)

func directoryTestConfig() Config {
	return Config{Profile: "core", MultiAgentMode: "auto", Assets: []Asset{{ID: "node-a", Name: "192.168.2.79", Kind: "ssh", FolderPath: []string{"Production", "新k8s集群"}}, {ID: "node-b", Name: "192.168.2.75", Kind: "ssh", FolderPath: []string{"Production", "新k8s集群", "worker"}}, {ID: "old", Name: "172.16.31.14", Kind: "local", FolderPath: []string{"旧k8s集群"}}}, Directories: []AssetDirectory{{ID: "new", Name: "新k8s集群", Path: []string{"Production", "新k8s集群"}, ResourceIDs: []string{"node-a", "node-b"}}, {ID: "old-dir", Name: "旧k8s集群", Path: []string{"旧k8s集群"}, ResourceIDs: []string{"old"}}, {ID: "worker", Name: "worker", Path: []string{"Production", "新k8s集群", "worker"}, ResourceIDs: []string{"node-b"}}}}
}
func TestDirectoryAssetLookupIncludesHierarchyAndWordOrder(t *testing.T) {
	c := directoryTestConfig()
	for _, a := range []map[string]any{{"pattern": "新k8s集群"}, {"pattern": "k8s新集群"}, {"pattern": "", "folder_path": "Production/新k8s集群"}, {"pattern": "", "folder_ref": "g_" + hash("new")[:16]}} {
		got, err := listDirectoryAssets(c, a)
		if err != nil {
			t.Fatal(err)
		}
		rows := arr(got)
		if len(rows) != 2 || obj(rows[1])["folder_path"] != "Production/新k8s集群/worker" {
			t.Fatalf("incorrect directory lookup: %s", js(got))
		}
	}
	got, err := listDirectoryAssets(c, map[string]any{"pattern": "旧k8s集群"})
	if err != nil || len(arr(got)) != 1 {
		t.Fatal(got, err)
	}
	if !DirectoryNameMentioned("k8s新集群 目录下就是新集群的节点啊", "新k8s集群") || DirectoryNameMentioned("旧k8s集群目录里的节点", "新k8s集群") {
		t.Fatal("directory name order matching invented a different target")
	}
	for _, message := range []string{"读取 /var/log/新k8s集群 的日志", "prod-新k8s集群2目录", "新k8s集群2目录"} {
		if DirectoryNameMentioned(message, "新k8s集群") {
			t.Fatalf("path or distinct suffixed name was mistaken for a resource directory: %s", message)
		}
	}
	if !DirectoryNameMentioned("check Production directory", "Production") {
		t.Fatal("Latin word boundary lost an explicit folder")
	}
	if DirectoryNameMentioned("非生产目录", "生产") {
		t.Fatal("negated/different directory selected production")
	}
	for _, message := range []string{"不要查新k8s集群目录", "别看新k8s集群目录", "不是新k8s集群目录"} {
		if DirectoryNameMentioned(message, "新k8s集群") {
			t.Fatal("negative mention selected a directory")
		}
	}
	if !DirectoryNameMentioned("不要查旧集群，而是新k8s集群目录", "新k8s集群") {
		t.Fatal("positive correction was lost")
	}
	c.Directories = append(c.Directories, AssetDirectory{ID: "duplicate", Name: "新k8s集群", Path: []string{"Staging", "新k8s集群"}, ResourceIDs: []string{"old"}})
	if _, err := listDirectoryAssets(c, map[string]any{"pattern": "", "folder_path": "新k8s集群"}); err == nil {
		t.Fatal("duplicate leaf name was guessed")
	}
	if _, err := listDirectoryAssets(c, map[string]any{"pattern": "", "folder_path": "missing"}); err == nil {
		t.Fatal("missing directory was guessed")
	}
}
func TestDirectoryScopeBlocksWrongHostTerminalAndChildBeforeExecution(t *testing.T) {
	var executions atomic.Int32
	bridge := func(ctx context.Context, id, name string, a map[string]any, approved bool) (any, error) {
		if name == "policy" {
			return map[string]any{"risk": "readonly", "asset_ref": "old", "runtime": "local"}, nil
		}
		executions.Add(1)
		return map[string]any{}, nil
	}
	engine := engineFor(t, Model{URL: "http://localhost:1", Name: "fixture", Protocol: "openai"}, bridge)
	c := directoryTestConfig()
	c.Model = Model{URL: "http://localhost:1", Name: "fixture", Protocol: "openai"}
	c.AssetRef = "old"
	c.targetScope = &TargetScope{DirectoryIDs: []string{"new"}, Paths: []string{"Production/新k8s集群"}, ResourceIDs: []string{"node-a", "node-b"}}
	if err := engine.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	s, _ := engine.get("case")
	for _, call := range []Call{{ID: "wrong", Name: "shell", Arguments: js(map[string]any{"asset_ref": assetAlias("old"), "runtime": "local", "command": "uname -a"})}, {ID: "implicit", Name: "shell", Arguments: js(map[string]any{"command": "uname -a"})}, {ID: "terminal", Name: "ssh_terminal_send", Arguments: js(map[string]any{"terminal_id": "old-terminal", "input": "uname -a"})}} {
		if _, err := engine.invoke(context.Background(), s, c, call); err == nil || !strings.Contains(err.Error(), "目录") {
			t.Fatalf("wrong target did not reach directory protection: %s (%v)", call.Name, err)
		}
	}
	if _, err := engine.runInvestigations(context.Background(), s, c, []investigationSpec{{Role: "host", Task: "wrong node", AssetRefs: []string{assetAlias("old")}}}); err == nil {
		t.Fatal("child escaped directory scope")
	}
	if executions.Load() != 0 {
		t.Fatal("an outside target was executed")
	}
	for _, name := range []string{"list_assets", "list_resource_groups"} {
		args := `{}`
		if name == "list_assets" {
			args = `{"pattern":""}`
		}
		if _, err := engine.invoke(context.Background(), s, c, Call{ID: name, Name: name, Arguments: args}); err != nil {
			t.Fatal(err)
		}
	}
	view, _ := engine.Snapshot("case")
	for _, card := range view.Cards {
		if card.Type == "operation" && str(obj(card.Data)["target"]) != "项目资源目录" {
			t.Fatal("directory lookup was mislabeled as a host operation")
		}
	}
	if executions.Load() != 0 {
		t.Fatal("metadata discovery accessed a host")
	}
}
func TestDirectoryLookupPreservesResourcePermissionFilter(t *testing.T) {
	c := directoryTestConfig()
	p := DefaultPermissions()
	p.BlockUnreferencedAssets = true
	c.Permissions = &p
	c.ReferencedAssets = []string{"node-a"}
	got, err := listDirectoryAssets(c, map[string]any{"pattern": "", "folder_path": "Production/新k8s集群"})
	if err != nil || len(arr(got)) != 1 {
		t.Fatal(got, err)
	}
	groups := directoryDiscovery(c)
	if groups[0]["resource_count"] != 2 || groups[0]["accessible_resource_count"] != 1 {
		t.Fatal("hidden resources were incorrectly presented as an empty directory")
	}
	if !strings.Contains(Prompt(c), "local kubeconfig") {
		t.Fatal("missing folder-versus-local-cluster policy")
	}
}
