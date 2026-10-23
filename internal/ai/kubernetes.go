package ai

import (
	"context"
	"errors"

	kube "github.com/Clean-Lakes/Lake/internal/kubernetes"
)

func kubernetesQueryTool() Tool {
	return Tool{Name: "query_kubernetes", Description: "Read the explicitly referenced Kubernetes resource using its saved Kubeconfig or API Server credentials, without SSH, local kubectl or MCP. Use metric identity, nodes, pods, events (warnings), resources (capacity/allocatable, not current usage), namespaces or logs. A resource display name is an alias and need not match the Kubeconfig cluster/context name. The saved API endpoint and context bind the target; never substitute another SSH host or local configuration. Namespace defaults to the saved namespace; list namespaces to discover others. Lists return at most 100 projected records and continue_token for paging; pass it as continue_token with the same metric/namespace. Never interpret a partial page as a complete cluster count. Logs require exact Pod/container names previously observed via pods and are bounded to 150 lines, 64 KiB, 1..60 minutes. No Secret, Pod spec, environment, credential, arbitrary API path, exec or mutation is exposed.", Parameters: objectSchema(map[string]any{
		"asset_ref": stringSchema(), "metric": map[string]any{"type": "string", "enum": []string{"identity", "nodes", "pods", "events", "resources", "namespaces", "logs"}}, "namespace": stringSchema(), "continue_token": stringSchema(), "pod": stringSchema(), "container": stringSchema(), "since_minutes": integerSchema(1, 60), "previous": map[string]any{"type": "boolean"},
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
