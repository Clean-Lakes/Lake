package ai

import (
	"fmt"
	"net/url"
)

type MemoryClaim struct {
	Field         string         `json:"field"`
	Value         string         `json:"value"`
	JSONPointer   string         `json:"jsonPointer"`
	FactKey       string         `json:"factKey"`
	KnowledgeKind string         `json:"knowledgeKind"`
	Subject       map[string]any `json:"subject"`
	Description   string         `json:"description"`
	Body          string         `json:"body"`
}

// The initial adapter deliberately covers one typed result, not arbitrary
// shell/MCP output. clusterIdentity has already parsed and matched node IPs.
func memoryStructuredClaims(tool string, value any) []MemoryClaim {
	if tool != "observe_cluster" || memoryEvidenceEligible(value, nil) != "completed_success" || obj(value)["truncated"] == true {
		return nil
	}
	identity := obj(obj(value)["identity"])
	if identity["target_match"] != true {
		return nil
	}
	endpoint := str(identity["api_server"])
	u, err := url.Parse(endpoint)
	if err != nil || len(endpoint) > 512 || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil
	}
	return []MemoryClaim{{Field: "kubernetes.api-server", Value: endpoint, JSONPointer: "/identity/api_server", FactKey: "kubectl.api-server", KnowledgeKind: "configuration", Subject: map[string]any{"kind": "service", "identity": "kubectl-api", "qualifiers": map[string]any{}}, Description: "此资源入口观测到的 Kubernetes API 地址", Body: fmt.Sprintf("在此资源入口观测到 kubectl 配置的 API 地址为 `%s`。\n\n再次使用前核对当前 context、集群身份和连接配置；这条观测不能证明其他入口属于同一集群，也不能证明当前 API 健康。", endpoint)}}
}
