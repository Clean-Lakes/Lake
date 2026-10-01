package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/agent"
	agentpolicy "github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

type k8sGetInput struct {
	Resource      string `json:"resource" jsonschema:"description=已登记的 Kubernetes 资源名，跨湖时用 湖名/资源名"`
	Kind          string `json:"kind" jsonschema:"description=查询类型：pods、deployments、services、nodes、namespaces、statefulsets、daemonsets、jobs、cronjobs、events"`
	Name          string `json:"name,omitempty" jsonschema:"description=可选的对象名"`
	Namespace     string `json:"namespace,omitempty" jsonschema:"description=可选 namespace，默认使用资源配置的 namespace"`
	AllNamespaces bool   `json:"all_namespaces,omitempty" jsonschema:"description=是否查询所有 namespace"`
}

type k8sGetOutput struct {
	Resource string `json:"resource"`
	Kind     string `json:"kind"`
	Output   string `json:"output"`
}

type boundedOutput struct {
	bytes.Buffer
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if remaining := b.limit - b.Len(); remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		_, _ = b.Buffer.Write(p[:remaining])
	}
	return len(p), nil
}

var k8sReadableKinds = map[string]bool{
	"pods": true, "deployments": true, "services": true, "nodes": true, "namespaces": true,
	"statefulsets": true, "daemonsets": true, "jobs": true, "cronjobs": true, "events": true,
}

func newK8sGetTool(s *store.Store, scope agent.RunScope) (tool.InvokableTool, error) {
	return utils.InferTool[k8sGetInput, k8sGetOutput]("lake_k8s_get",
		"只读查询已登记的 Kubernetes 集群。仅支持 get 常见资源，不读取 Secret，不修改集群。调用前须确认湖和资源名；资源须开启执行授权。",
		func(ctx context.Context, in k8sGetInput) (k8sGetOutput, error) { return runK8sGet(ctx, s, in, scope) })
}

func runK8sGet(ctx context.Context, s *store.Store, in k8sGetInput, scopes ...agent.RunScope) (k8sGetOutput, error) {
	if !k8sReadableKinds[in.Kind] {
		return k8sGetOutput{}, errors.New("不支持该 Kubernetes 类型；仅允许常见只读资源，不能读取 Secret")
	}
	if in.Resource == "" {
		return k8sGetOutput{}, errors.New("需要 Kubernetes 资源名")
	}
	if in.Name != "" && !validK8sArgument(in.Name) {
		return k8sGetOutput{}, errors.New("无效的 Kubernetes 对象名")
	}
	if in.Namespace != "" && !validK8sArgument(in.Namespace) {
		return k8sGetOutput{}, errors.New("无效的 namespace")
	}
	resource, err := s.ResolveResource(ctx, strings.TrimPrefix(in.Resource, "@"))
	if err != nil {
		return k8sGetOutput{}, err
	}
	if resource.Kind != "k8s" {
		return k8sGetOutput{}, errors.New("该资源不是 Kubernetes 集群")
	}
	lake, err := s.GetLake(ctx, resource.LakeID)
	if err != nil {
		return k8sGetOutput{}, err
	}
	path := lake.Name + "/" + resource.Name
	actionID, err := store.NewActionID()
	if err != nil {
		return k8sGetOutput{}, err
	}
	journal := func(event, detail string) {
		logCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.AppendJournal(logCtx, store.JournalInput{ActionID: actionID, Actor: "agent", TargetPath: path, Tool: "lake_k8s_get", Risk: "read", Event: event, Detail: detail})
	}
	journal("requested", "kind="+in.Kind)
	if len(scopes) != 0 {
		frozen := false
		for _, id := range scopes[0].ResourceIDs {
			if id == resource.ID {
				frozen = true
				break
			}
		}
		err := agentpolicy.Authorize(ctx, agentpolicy.Input{
			Spec: agent.ToolSpec{Name: "lake_k8s_get", Capability: "read"}, Scope: scopes[0], Origin: "model",
			ResourceID: resource.ID, ResourceFrozen: frozen, ResourceAuthorized: resource.ExecuteAuthz,
		}, nil)
		if err != nil {
			journal("denied", "policy_scope_or_authorization")
			return k8sGetOutput{}, err
		}
	}
	if !resource.ExecuteAuthz {
		journal("denied", "execute_authz=false")
		return k8sGetOutput{}, fmt.Errorf("资源 %s 尚未开启执行授权", path)
	}
	attachments, err := s.ListAttachments(ctx, resource.ID)
	if err != nil {
		journal("failed", "credential_lookup")
		return k8sGetOutput{}, err
	}
	ref := ""
	for _, item := range attachments {
		if item.Kind == "credential" {
			ref = item.Ref
			break
		}
	}
	if ref == "" {
		journal("failed", "credential_missing")
		return k8sGetOutput{}, errors.New("Kubernetes 资源未关联 kubeconfig")
	}
	config, err := (credential.FileVault{Root: s.Root()}).LoadKubeconfig(ref)
	if err != nil {
		journal("failed", "credential_load")
		return k8sGetOutput{}, fmt.Errorf("读取 kubeconfig: %w", err)
	}
	defer clearBytes(config)
	tmp, err := os.CreateTemp("", "lake-kubeconfig-*")
	if err != nil {
		return k8sGetOutput{}, err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return k8sGetOutput{}, err
	}
	if _, err := tmp.Write(config); err != nil {
		tmp.Close()
		return k8sGetOutput{}, err
	}
	if err := tmp.Close(); err != nil {
		return k8sGetOutput{}, err
	}
	namespace := in.Namespace
	if namespace == "" {
		namespace = resource.K8s.Namespace
	}
	args := []string{"--kubeconfig", tmp.Name(), "--context", resource.K8s.Context, "--request-timeout=20s"}
	if in.AllNamespaces {
		args = append(args, "--all-namespaces")
	} else {
		args = append(args, "--namespace", namespace)
	}
	args = append(args, "get", in.Kind)
	if in.Name != "" {
		args = append(args, in.Name)
	}
	args = append(args, "--output=wide")
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	journal("started", "kind="+in.Kind)
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	var output boundedOutput
	output.limit = 65536
	cmd.Stdout = &output
	cmd.Stderr = &output
	err = cmd.Run()
	if err != nil {
		journal("failed", "kubectl_get_failed")
		return k8sGetOutput{}, fmt.Errorf("Kubernetes 查询失败: %w: %s", err, strings.TrimSpace(output.String()))
	}
	journal("completed", "kind="+in.Kind)
	return k8sGetOutput{Resource: path, Kind: in.Kind, Output: output.String()}, nil
}

func validK8sArgument(value string) bool {
	if value == "" || len(value) > 253 {
		return false
	}
	if value[0] < 'a' || value[0] > 'z' {
		if value[0] < '0' || value[0] > '9' {
			return false
		}
	}
	last := value[len(value)-1]
	if last < 'a' || last > 'z' {
		if last < '0' || last > '9' {
			return false
		}
	}
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '.' {
			continue
		}
		return false
	}
	return true
}
