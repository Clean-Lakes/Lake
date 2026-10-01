package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

func TestK8sReadRejectsResourceOutsideFrozenLake(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first, err := s.CreateLake(ctx, "第一湖", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateLake(ctx, "第二湖", "")
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := s.CreateK8s(ctx, store.ResourceInput{LakeID: first.ID, Name: "集群一", K8s: store.K8sSpec{Context: "one"}})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := s.CreateK8s(ctx, store.ResourceInput{LakeID: second.ID, Name: "集群二", K8s: store.K8sSpec{Context: "two"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, foreign.ID, true); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{LakeID: first.ID, ToolNames: []string{"lake_k8s_get"}, ResourceIDs: []string{allowed.ID}}
	if _, err := runK8sGet(ctx, s, k8sGetInput{Resource: "第二湖/集群二", Kind: "pods"}, scope); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("foreign resource passed policy: %v", err)
	}
}

func TestK8sResourceImportAndReadOnlyGuard(t *testing.T) {
	if _, err := exec.LookPath("kubectl"); err != nil {
		t.Skip("kubectl is not installed")
	}
	ctx := context.Background()
	root := t.TempDir()
	config := filepath.Join(t.TempDir(), "config")
	fixture := `apiVersion: v1
kind: Config
clusters:
- name: demo-cluster
  cluster:
    server: https://127.0.0.1:65535
users:
- name: demo-user
  user:
    token: fixture-token
contexts:
- name: demo-context
  context:
    cluster: demo-cluster
    user: demo-user
- name: other-context
  context:
    cluster: demo-cluster
    user: demo-user
current-context: demo-context
`
	if err := os.WriteFile(config, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	call := func(args ...string) string {
		t.Helper()
		var out, stderr bytes.Buffer
		if err := run(ctx, args, root, &out, &stderr); err != nil {
			t.Fatalf("lake %v: %v %s", args, err, stderr.String())
		}
		return out.String()
	}
	call("add", "测试湖")
	var contexts kubeconfigSummary
	if err := json.Unmarshal([]byte(call("res", "k8s-contexts", "--kubeconfig", config)), &contexts); err != nil {
		t.Fatal(err)
	}
	if contexts.CurrentContext != "demo-context" || len(contexts.Contexts) != 2 {
		t.Fatalf("contexts: %+v", contexts)
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(call("res", "add-k8s", "测试湖/测试集群", "--kubeconfig", config, "--json")), &created); err != nil {
		t.Fatal(err)
	}
	if created["kind"] != "k8s" || created["ssh"] != nil || created["k8s"].(map[string]any)["context"] != "demo-context" {
		t.Fatalf("resource: %+v", created)
	}
	if !strings.Contains(call("res", "ls", "--all"), "demo-context/default") {
		t.Fatal("Kubernetes endpoint missing from list")
	}
	var alternate map[string]any
	if err := json.Unmarshal([]byte(call("res", "add-k8s", "测试湖/备用集群", "--kubeconfig", config, "--context", "other-context", "--json")), &alternate); err != nil {
		t.Fatal(err)
	}
	if alternate["k8s"].(map[string]any)["context"] != "other-context" {
		t.Fatalf("alternate context: %+v", alternate)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	resource, err := s.ResolveResource(ctx, "测试湖/测试集群")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runK8sGet(ctx, s, k8sGetInput{Resource: "测试湖/测试集群", Kind: "secrets"}); err == nil {
		t.Fatal("Secret query was not rejected")
	}
	if _, err := runK8sGet(ctx, s, k8sGetInput{Resource: "测试湖/测试集群", Kind: "pods"}); err == nil || !strings.Contains(err.Error(), "授权") {
		t.Fatalf("unauthorized query: %v", err)
	}
	attachments, err := s.ListAttachments(ctx, resource.ID)
	if err != nil || len(attachments) != 1 {
		t.Fatalf("attachments: %+v %v", attachments, err)
	}
	contents, err := (credential.FileVault{Root: root}).LoadKubeconfig(attachments[0].Ref)
	if err != nil || !bytes.Contains(contents, []byte("demo-context")) {
		t.Fatalf("imported config: %v", err)
	}
	if err := os.Remove(config); err != nil {
		t.Fatal(err)
	}
	if _, err := (credential.FileVault{Root: root}).LoadKubeconfig(attachments[0].Ref); err != nil {
		t.Fatalf("import still depends on original path: %v", err)
	}
	call("res", "authz", "测试湖/测试集群", "on")
	fakeDir := t.TempDir()
	fakeArgs := filepath.Join(fakeDir, "args")
	fakeKubectl := filepath.Join(fakeDir, "kubectl")
	if err := os.WriteFile(fakeKubectl, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$LAKE_KUBECTL_ARGS\"\nprintf 'NAME STATUS\\npod-a Running\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LAKE_KUBECTL_ARGS", fakeArgs)
	t.Setenv("PATH", fakeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	got, err := runK8sGet(ctx, s, k8sGetInput{Resource: "测试湖/测试集群", Kind: "pods"})
	if err != nil || !strings.Contains(got.Output, "pod-a Running") {
		t.Fatalf("read-only get: %+v %v", got, err)
	}
	args, err := os.ReadFile(fakeArgs)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"--context\ndemo-context\n", "--namespace\ndefault\n", "get\npods\n"} {
		if !strings.Contains(string(args), expected) {
			t.Fatalf("kubectl arguments missing %q: %q", expected, args)
		}
	}
}
