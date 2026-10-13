package ai

import (
	"context"
	"errors"
	"net"
	"strings"
)

func clusterObservationTool() Tool {
	return Tool{Name: "observe_cluster", Description: "Read Kubernetes identity or status through kubectl on an assigned local/SSH node. Choose metric identity, nodes, pods, events or resources; optional context and a listed standard kubeconfig path select the configuration on that node. Never read raw kubeconfig or credentials. No command, Secret, environment or mutation is accepted. The runtime matches observed node IPs against selected SSH targets before status reads. If identity fails, inspect the returned raw error, use a selected control-plane node/configuration, or report the gap; do not repeat all status metrics against the same failed context. kubelet active alone is not Kubernetes Ready. Scope and permissions remain those of the parent.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"asset_ref": map[string]any{"type": "string"}, "metric": map[string]any{"type": "string", "enum": []string{"identity", "nodes", "pods", "events", "resources"}}, "context": map[string]any{"type": "string"}, "kubeconfig": clusterConfigSchema(), "namespace": map[string]any{"type": "string", "description": "Optional exact namespace for pods/events; omit for other metrics."}}, "required": []string{"asset_ref", "metric"}}}
}

func clusterConfigSchema() map[string]any {
	return map[string]any{"type": "string", "enum": []string{"default", "/root/.kube/config", "/etc/kubernetes/admin.conf", "/etc/rancher/k3s/k3s.yaml", "/etc/rancher/rke2/rke2.yaml"}}
}

func clusterCommand(metric, selectedContext string) (string, error) {
	return clusterCommandWithConfig(metric, selectedContext, "")
}

func clusterCommandWithConfig(metric, selectedContext, kubeconfig string) (string, error) {
	if len(selectedContext) > 256 || strings.ContainsAny(selectedContext, "\x00\r\n") {
		return "", errors.New("无效的 Kubernetes context")
	}
	base := "kubectl --request-timeout=5s"
	switch kubeconfig {
	case "", "default":
	case "/root/.kube/config", "/etc/kubernetes/admin.conf", "/etc/rancher/k3s/k3s.yaml", "/etc/rancher/rke2/rke2.yaml":
		base += " --kubeconfig=" + quote(kubeconfig)
	default:
		return "", errors.New("不支持的 kubeconfig 路径；仅选择列出的标准路径，不读取凭据内容")
	}
	if selectedContext != "" {
		base += " --context=" + quote(selectedContext)
	}
	// All projections are bounded and exclude credentials, Secret data and Pod specs.
	queries := map[string]string{
		"identity":  "config view --minify -o jsonpath=" + quote("{.clusters[0].cluster.server}") + " && printf '\\n' && " + base + " get nodes --no-headers -o custom-columns=" + quote("NAME:.metadata.name,IP:.status.addresses[?(@.type==\"InternalIP\")].address"),
		"nodes":     "get nodes -o custom-columns=" + quote("NAME:.metadata.name,IP:.status.addresses[?(@.type==\"InternalIP\")].address,READY:.status.conditions[?(@.type==\"Ready\")].status,DISK_PRESSURE:.status.conditions[?(@.type==\"DiskPressure\")].status,MEM_PRESSURE:.status.conditions[?(@.type==\"MemoryPressure\")].status,PID_PRESSURE:.status.conditions[?(@.type==\"PIDPressure\")].status,KUBELET:.status.nodeInfo.kubeletVersion,RUNTIME:.status.nodeInfo.containerRuntimeVersion"),
		"pods":      "get pods -A -o custom-columns=" + quote("NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,CONTAINERS:.status.containerStatuses[*].name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName"),
		"events":    "get events -A --field-selector=type=Warning -o custom-columns=" + quote("NAMESPACE:.metadata.namespace,OBJECT:.involvedObject.name,REASON:.reason,COUNT:.count,LAST:.lastTimestamp,MESSAGE:.message"),
		"resources": "get nodes -o custom-columns=" + quote("NAME:.metadata.name,CPU_CAPACITY:.status.capacity.cpu,MEM_CAPACITY:.status.capacity.memory,CPU_ALLOCATABLE:.status.allocatable.cpu,MEM_ALLOCATABLE:.status.allocatable.memory,PODS_ALLOCATABLE:.status.allocatable.pods") + " && " + base + " top nodes",
	}
	query, ok := queries[metric]
	if !ok {
		return "", errors.New("不支持的 Kubernetes 观察")
	}
	// Use a private temporary capture so pipeline truncation cannot mask kubectl failures.
	// It contains projected observation output only, never credential contents.
	query = base + " " + query
	if metric == "identity" {
		query = "printf 'LAKE_CLUSTER_IDENTITY_BEGIN\\n'; (" + query + "); lake_identity_status=$?; printf 'LAKE_CLUSTER_IDENTITY_END\\n'; exit \"$lake_identity_status\""
	}
	return "PATH=/usr/local/bin:$PATH; " + boundedObservationCommand(query, 150), nil
}

func clusterIdentity(output string, expectedIPs []string) (map[string]any, error) {
	if _, body, ok := strings.Cut(output, "LAKE_CLUSTER_IDENTITY_BEGIN\n"); ok {
		var ended bool
		output, _, ended = strings.Cut(body, "LAKE_CLUSTER_IDENTITY_END")
		if !ended {
			return nil, errors.New("Kubernetes 身份输出不完整")
		}
	}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for len(lines) > 0 && !(strings.HasPrefix(lines[0], "https://") || strings.HasPrefix(lines[0], "http://")) {
		lines = lines[1:]
	}
	if len(lines) < 2 || !(strings.HasPrefix(lines[0], "https://") || strings.HasPrefix(lines[0], "http://")) {
		return nil, errors.New("无法确认 Kubernetes API 身份；请检查所选节点的 kubectl/context")
	}
	seen := map[string]bool{}
	nodes := []map[string]any{}
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		ips := []string{}
		for _, text := range fields[1:] {
			for _, address := range strings.Split(text, ",") {
				if ip := net.ParseIP(address); ip != nil {
					seen[ip.String()] = true
					ips = append(ips, ip.String())
				}
			}
		}
		nodes = append(nodes, map[string]any{"name": fields[0], "internal_ips": ips})
	}
	if len(nodes) == 0 {
		return nil, errors.New("集群身份观察没有返回节点地址")
	}
	missing := []string{}
	for _, expected := range expectedIPs {
		if !seen[expected] {
			missing = append(missing, expected)
		}
	}
	identity := map[string]any{"api_server": lines[0], "nodes": nodes, "target_match": len(missing) == 0, "expected_node_ips": expectedIPs, "missing_node_ips": missing}
	if len(missing) > 0 {
		return identity, errors.New("kubectl 集群与所选节点范围不匹配；未继续读取集群状态")
	}
	if len(expectedIPs) == 0 {
		identity["target_match"] = false
		identity["note"] = "所选资源无可比对的 SSH IP；身份已返回但未经目标匹配，不读取集群状态。"
	}
	return identity, nil
}

func (e *Engine) observeCluster(ctx context.Context, c Config, as Asset, a map[string]any) (any, error) {
	if as.Kind != "ssh" && as.Kind != "local" {
		return nil, errors.New("Scout 只能通过分配的本机或 SSH 节点查询集群")
	}
	// Bind cluster reads to the live parent selection, not the model's guessed cluster.
	expected := e.clusterExpectedIPs()
	namespace := str(a["namespace"])
	if namespace != "" && (!kubeObjectName.MatchString(namespace) || len(namespace) > 63 || str(a["metric"]) != "pods" && str(a["metric"]) != "events") {
		return nil, errors.New("namespace 仅用于 pods/events，且必须为实际命名空间名称")
	}
	return readClusterSnapshotConfig(str(a["metric"]), str(a["context"]), str(a["kubeconfig"]), expected, func(command string) (any, error) {
		if namespace != "" {
			command = strings.Replace(command, "get pods -A", "get pods -n "+quote(namespace), 1)
			command = strings.Replace(command, "get events -A", "get events -n "+quote(namespace), 1)
		}
		return e.command(ctx, c, map[string]any{"asset_ref": as.ID, "runtime": as.Kind}, command)
	})
}

func (e *Engine) clusterExpectedIPs() []string {
	w := e.worker
	w.session.mu.Lock()
	parent := w.session.state.Config
	ids := w.assets
	if scope := w.session.state.TargetScope; scope != nil {
		ids = scope.ResourceIDs
	}
	expected := []string{}
	for _, id := range ids {
		if target, lookupErr := asset(parent, id); lookupErr == nil && target.SSH != nil {
			if ip := net.ParseIP(target.SSH.Host); ip != nil {
				expected = append(expected, ip.String())
			}
		}
	}
	w.session.mu.Unlock()
	return expected
}

func readClusterSnapshot(metric, selectedContext string, expected []string, execute func(string) (any, error)) (any, error) {
	return readClusterSnapshotConfig(metric, selectedContext, "", expected, execute)
}

func readClusterSnapshotConfig(metric, selectedContext, kubeconfig string, expected []string, execute func(string) (any, error)) (any, error) {
	command, err := clusterCommandWithConfig(metric, selectedContext, kubeconfig)
	if err != nil {
		return nil, err
	}
	identityCommand, _ := clusterCommandWithConfig("identity", selectedContext, kubeconfig)
	raw, err := execute(identityCommand)
	if err != nil || num(obj(raw)["exitCode"], 1) != 0 {
		return raw, errors.New("集群身份查询失败；请检查所选节点的 kubectl、权限和 context")
	}
	output := str(obj(raw)["stdout"])
	if output == "" {
		output = str(obj(raw)["output"])
	}
	identity, err := clusterIdentity(output, expected)
	if err != nil {
		return map[string]any{"identity": identity, "output": obj(raw)["output"], "exitCode": obj(raw)["exitCode"], "truncated": obj(raw)["truncated"]}, err
	}
	if metric == "identity" {
		return map[string]any{"identity": identity, "metric": metric, "exitCode": 0}, nil
	}
	if identity["target_match"] != true {
		return identity, errors.New("尚未确认集群属于所选 SSH 节点，请先使用 identity 确认目标")
	}
	value, err := execute(command)
	return map[string]any{"identity": identity, "metric": metric, "output": obj(value)["output"], "exitCode": obj(value)["exitCode"], "truncated": obj(value)["truncated"]}, err
}
