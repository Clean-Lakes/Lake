package ai

import (
	"context"
	"errors"
	"fmt"

	kube "github.com/Clean-Lakes/Lake/internal/kubernetes"
)

func kubernetesQueryTool() Tool {
	return Tool{Name: "query_kubernetes", Description: "Read the explicitly referenced Kubernetes resource using its saved Kubeconfig or API Server credentials, without SSH, local kubectl or MCP. Use deployments/replicasets/statefulsets/daemonsets to inspect controllers and rollout status; metric identity, nodes, pods, events (warnings), resources (capacity/allocatable, not current usage), namespaces or logs. A resource display name is an alias and need not match the Kubeconfig cluster/context name. The saved API endpoint and context bind the target; never substitute another SSH host or local configuration. Namespace defaults to the saved namespace; list namespaces to discover others. Lists return at most 100 projected records and continue_token for paging; pass it as continue_token with the same metric/namespace. Never interpret a partial page as a complete cluster count. Logs require exact Pod/container names previously observed via pods and are bounded to 150 lines, 64 KiB, 1..60 minutes. Returns UID, resource_version and owners for exact action targeting. This query exposes no mutation or arbitrary spec. Use kubernetes_capabilities before promising a change and kubernetes_action for supported changes.", Parameters: objectSchema(map[string]any{
		"asset_ref": stringSchema(), "metric": map[string]any{"type": "string", "enum": []string{"identity", "nodes", "pods", "events", "resources", "namespaces", "logs", "deployments", "replicasets", "statefulsets", "daemonsets"}}, "namespace": stringSchema(), "continue_token": stringSchema(), "pod": stringSchema(), "container": stringSchema(), "since_minutes": integerSchema(1, 60), "previous": map[string]any{"type": "boolean"},
	}, "asset_ref", "metric")}
}

func (e *Engine) queryKubernetes(ctx context.Context, c Config, a map[string]any) (any, error) {
	as, err := asset(c, str(a["asset_ref"]))
	if err != nil {
		return nil, err
	}
	if as.Kind != "kubernetes" {
		return nil, errors.New("请选择 Kubernetes 类型资源；此工具不使用 SSH 或本机的 kubectl")
	}
	return queryKubernetesAsset(ctx, c, as, a)
}
func queryKubernetesAsset(ctx context.Context, c Config, as Asset, a map[string]any) (any, error) {
	if context := str(a["context"]); context != "" && context != str(as.Settings["context"]) {
		return nil, errors.New("Kubernetes 资源使用已保存的 Context，请在资源配置中选择目标")
	}
	if config := str(a["kubeconfig"]); config != "" && config != "default" {
		return nil, errors.New("Kubernetes 资源使用已保存的 Kubeconfig，不读取主机配置文件")
	}
	creds, err := credentials(as, c.CredentialDir)
	if err != nil {
		return nil, err
	}
	client, err := kube.New(as.Settings, creds)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	metric := str(a["metric"])
	if metric == "" {
		metric = "logs"
	}
	return client.Query(ctx, kube.Query{Metric: metric, Namespace: str(a["namespace"]), Continue: str(a["continue_token"]), Pod: str(a["pod"]), Container: str(a["container"]), SinceMinutes: num(a["since_minutes"], 20), Previous: a["previous"] == true})
}

func kubernetesActionTools() []Tool {
	props := map[string]any{"asset_ref": stringSchema(), "action": map[string]any{"type": "string", "enum": []string{"scale", "restart", "delete_pod"}}, "kind": map[string]any{"type": "string", "enum": []string{"deployments", "replicasets", "statefulsets", "daemonsets", "pods"}}, "namespace": stringSchema(), "name": stringSchema()}
	capability := Tool{Name: "kubernetes_capabilities", Description: "Check saved-cluster RBAC for one exact supported action using SelfSubjectAccessReview; no workload change. Call before promising to execute. Failure to check is unknown, not proof of bad credentials. Does not grant user authorization. Scale supports deployments/replicasets/statefulsets; restart supports deployments/statefulsets/daemonsets; delete_pod supports pods only.", Parameters: objectSchema(props, "asset_ref", "action", "kind", "namespace", "name")}
	actionProps := map[string]any{}
	for k, v := range props {
		actionProps[k] = v
	}
	actionProps["uid"], actionProps["resource_version"], actionProps["replicas"] = stringSchema(), stringSchema(), integerSchema(0, 10000)
	action := Tool{Name: "kubernetes_action", Description: "Change one explicitly authorized Kubernetes object through its saved API. Requires exact namespace, name, uid and resource_version from query_kubernetes. Scale requires replicas (0 allowed); restart adds a rollout annotation; delete_pod deletes one Pod with identity preconditions, never a controller or collection. Inspect owners before scaling a ReplicaSet: its Deployment may reconcile it. Checks RBAC again, follows Lake approval/ledger and never retries. API acceptance is not readiness: query workloads, pods and events afterwards. No arbitrary manifests, exec or Secret access.", Parameters: objectSchema(actionProps, "asset_ref", "action", "kind", "namespace", "name", "uid", "resource_version")}
	return []Tool{capability, action}
}

func (e *Engine) kubernetesOperation(ctx context.Context, c Config, name string, a map[string]any) (any, error) {
	failBeforeDispatch := func(err error) (any, error) {
		if name == "kubernetes_action" {
			return nil, &ToolNotExecutedError{Err: err}
		}
		return nil, err
	}
	as, err := asset(c, str(a["asset_ref"]))
	if err != nil {
		return failBeforeDispatch(err)
	}
	if as.Kind != "kubernetes" {
		return failBeforeDispatch(errors.New("请选择 Kubernetes 类型资源"))
	}
	creds, err := credentials(as, c.CredentialDir)
	if err != nil {
		return failBeforeDispatch(err)
	}
	client, err := kube.New(as.Settings, creds)
	if err != nil {
		return failBeforeDispatch(err)
	}
	defer client.Close()
	action := kube.Action{Action: str(a["action"]), Kind: str(a["kind"]), Namespace: str(a["namespace"]), Name: str(a["name"]), UID: str(a["uid"]), ResourceVersion: str(a["resource_version"])}
	if raw, ok := a["replicas"]; ok {
		var n int
		if _, err := fmt.Sscan(fmt.Sprint(raw), &n); err != nil || fmt.Sprint(n) != fmt.Sprint(raw) {
			return failBeforeDispatch(errors.New("副本数必须是整数"))
		}
		action.Replicas = &n
	}
	if name == "kubernetes_capabilities" {
		return client.Capabilities(ctx, action)
	}
	result, err := client.Act(ctx, action)
	var notExecuted *kube.NotExecutedError
	if errors.As(err, &notExecuted) {
		return nil, &ToolNotExecutedError{Err: err}
	}
	return result, err
}
