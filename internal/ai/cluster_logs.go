package ai

import (
	"context"
	"errors"
	"regexp"
)

func clusterLogObservationTool() Tool {
	return Tool{Name: "observe_cluster_logs", Description: "Read logs of one exact Kubernetes Pod on an assigned control-plane/local resource after verifying cluster identity. Obtain namespace, Pod and container names from observe_cluster pods; never guess log filenames. Bounded to 150 lines, 64 KiB and 1..60 minutes. previous optionally reads the last terminated container's logs. No exec, Secret, raw kubeconfig, arbitrary selector or mutation is accepted. Deep may use this to investigate Redis/database workloads on SSH hosts without a database connection.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"asset_ref": map[string]any{"type": "string"}, "namespace": map[string]any{"type": "string"}, "pod": map[string]any{"type": "string"}, "container": map[string]any{"type": "string"}, "context": map[string]any{"type": "string"}, "kubeconfig": clusterConfigSchema(), "since_minutes": map[string]any{"type": "integer", "minimum": 1, "maximum": 60}, "previous": map[string]any{"type": "boolean"}}, "required": []string{"asset_ref", "namespace", "pod"}}}
}

var kubeObjectName = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)

func clusterLogCommand(a map[string]any) (string, error) {
	for _, key := range []string{"namespace", "pod", "container"} {
		name := str(a[key])
		if name == "" && key == "container" {
			continue
		}
		if len(name) > 253 || !kubeObjectName.MatchString(name) {
			return "", errors.New("日志需使用实际 namespace、Pod 和 container 名称")
		}
	}
	minutes := num(a["since_minutes"], 20)
	if minutes < 1 || minutes > 60 {
		return "", errors.New("日志时间范围必须为 1–60 分钟")
	}
	_, err := clusterCommandWithConfig("identity", str(a["context"]), str(a["kubeconfig"]))
	if err != nil {
		return "", err
	}
	base := "kubectl --request-timeout=5s"
	if value := str(a["context"]); value != "" {
		base += " --context=" + quote(value)
	}
	if value := str(a["kubeconfig"]); value != "" && value != "default" {
		base += " --kubeconfig=" + quote(value)
	}
	query := base + " -n " + quote(str(a["namespace"])) + " logs " + quote(str(a["pod"])) + " --tail=150 --limit-bytes=65536 --since=" + quote(js(minutes)+"m")
	if value := str(a["container"]); value != "" {
		query += " -c " + quote(value)
	}
	if a["previous"] == true {
		query += " --previous=true"
	}
	return "PATH=/usr/local/bin:$PATH; " + boundedObservationCommand(query, 150), nil
}

func (e *Engine) observeClusterLogs(ctx context.Context, c Config, as Asset, a map[string]any) (any, error) {
	if as.Kind != "local" && as.Kind != "ssh" {
		return nil, errors.New("Pod 日志仅支持分配的本机或 SSH 主机")
	}
	command, err := clusterLogCommand(a)
	if err != nil {
		return nil, err
	}
	execute := func(command string) (any, error) {
		return e.command(ctx, c, map[string]any{"asset_ref": as.ID, "runtime": as.Kind}, command)
	}
	identity, err := readClusterSnapshotConfig("identity", str(a["context"]), str(a["kubeconfig"]), e.clusterExpectedIPs(), execute)
	if err != nil {
		return identity, err
	}
	if obj(obj(identity)["identity"])["target_match"] != true {
		return identity, errors.New("集群身份尚未与所选节点匹配；未读取 Pod 日志")
	}
	value, err := execute(command)
	return map[string]any{"identity": obj(identity)["identity"], "namespace": a["namespace"], "pod": a["pod"], "container": a["container"], "output": obj(value)["output"], "exitCode": obj(value)["exitCode"], "truncated": obj(value)["truncated"]}, err
}
