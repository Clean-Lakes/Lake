// Package kubernetes provides bounded observations and preconditioned actions on an explicitly
// configured cluster. It never executes credential plugins or kubectl.
package kubernetes

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type APIError struct {
	Status int
	Err    error
}

func (e *APIError) Error() string { return e.Err.Error() }
func (e *APIError) Unwrap() error { return e.Err }

var ErrTimeout = errors.New("连接超时，请检查集群地址或调整超时")
var versionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$`)
var objectName = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)

type Query struct {
	Metric, Namespace, Continue, Pod, Container string
	SinceMinutes                                int
	Previous                                    bool
}
type Client struct {
	connection Connection
	http       *http.Client
	transport  *http.Transport
	timeout    time.Duration
}

func New(settings map[string]any, secrets map[string]string) (*Client, error) {
	connection := Connection{endpoint: text(settings["endpoint"]), selectedContext: text(settings["context"]), namespace: text(settings["namespace"]), token: secrets["token"], tls: &tls.Config{MinVersion: tls.VersionTLS12}}
	if text(settings["authMethod"]) == "kubeconfig" {
		var err error
		connection, err = Resolve(secrets["kubeconfig"], settings)
		if err != nil {
			return nil, err
		}
		if saved := strings.TrimRight(strings.TrimSpace(text(settings["endpoint"])), "/"); saved != "" && saved != connection.endpoint {
			return nil, errors.New("保存的集群地址与 Kubeconfig 不一致，请重新添加资源")
		}
	} else if method := text(settings["authMethod"]); method != "" && method != "token" {
		return nil, errors.New("不支持的 Kubernetes 认证方式")
	}
	u, err := url.Parse(connection.endpoint)
	if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || strings.ContainsAny(connection.endpoint, "?#\\ \t\r\n\x00") {
		return nil, errors.New("Kubernetes API Server 地址无效")
	}
	if len(connection.token) > 16384 || strings.ContainsAny(connection.token, " \t\r\n\x00") {
		return nil, errors.New("Kubeconfig Token 格式无效")
	}
	if connection.namespace == "" {
		connection.namespace = "default"
	}
	if err := ValidateNamespace(connection.namespace); err != nil {
		return nil, err
	}
	switch text(settings["tlsMode"]) {
	case "", "config":
	case "verify":
		connection.tls.InsecureSkipVerify = false
	case "skip":
		connection.tls.InsecureSkipVerify = true
	default:
		return nil, errors.New("不支持的 TLS 验证方式")
	}
	seconds := 10
	if raw, ok := settings["requestTimeout"]; ok {
		switch n := raw.(type) {
		case int:
			seconds = n
		case int64:
			seconds = int(n)
		case float64:
			seconds = int(n)
			if n != float64(seconds) {
				return nil, errors.New("Kubernetes 超时须为整数")
			}
		default:
			return nil, errors.New("Kubernetes 超时须为整数")
		}
	}
	if seconds < 1 || seconds > 60 {
		return nil, errors.New("Kubernetes 超时须为 1～60 秒的整数")
	}
	transport := &http.Transport{TLSClientConfig: connection.tls, DisableKeepAlives: true, MaxResponseHeaderBytes: 64 << 10}
	return &Client{connection: connection, transport: transport, timeout: time.Duration(seconds) * time.Second, http: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) Close() { c.transport.CloseIdleConnections() }

func (c *Client) get(ctx context.Context, path string, query url.Values, limit int) ([]byte, error) {
	return c.request(ctx, http.MethodGet, path, query, nil, "", limit)
}

func (c *Client) request(ctx context.Context, method, path string, query url.Values, payload any, contentType string, limit int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var data []byte
	if payload != nil {
		data, _ = json.Marshal(payload)
	}
	endpoint := strings.TrimRight(c.connection.endpoint, "/") + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("Kubernetes 请求地址无效")
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.connection.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.connection.token)
	} else if c.connection.username != "" || c.connection.password != "" {
		req.SetBasicAuth(c.connection.username, c.connection.password)
	}
	response, err := c.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ErrTimeout
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, context.Canceled
		}
		var verification *tls.CertificateVerificationError
		if errors.As(err, &verification) {
			return nil, errors.New("TLS 证书验证失败，请检查 Kubeconfig 的 CA 证书与服务地址")
		}
		return nil, errors.New("无法连接 Kubernetes API Server，请检查地址、网络和证书配置")
	}
	defer response.Body.Close()
	apiError := func(message string) error { return &APIError{Status: response.StatusCode, Err: errors.New(message)} }
	switch response.StatusCode {
	case 200, 201, 202:
	case 401:
		return nil, apiError("Kubernetes 认证失败，请检查 Token 或客户端证书")
	case 403:
		return nil, apiError("Kubernetes 拒绝访问，请检查账号对本次操作的 RBAC 权限")
	case 404:
		return nil, apiError("Kubernetes 对象或 API 不存在，请重新查询目标")
	case 409:
		return nil, apiError("Kubernetes 对象已变化，请重新查询 UID 和 resourceVersion；未自动重试")
	default:
		return nil, apiError("Kubernetes API Server 未接受本次请求")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil {
		return nil, errors.New("无法读取 Kubernetes 观察结果")
	}
	if len(body) > limit {
		return nil, errors.New("Kubernetes 响应超过读取上限，请缩小命名空间范围")
	}
	return body, nil
}

// Redact before observations enter model context, history or the operation ledger.
func (c *Client) safe(result map[string]any) map[string]any {
	data, _ := json.Marshal(result)
	secrets := []string{c.connection.token, c.connection.password}
	if c.connection.username != "" || c.connection.password != "" {
		secrets = append(secrets, base64.StdEncoding.EncodeToString([]byte(c.connection.username+":"+c.connection.password)))
	}
	for _, secret := range secrets {
		if secret != "" {
			encoded, _ := json.Marshal(secret)
			data = []byte(strings.ReplaceAll(string(data), string(encoded[1:len(encoded)-1]), "[REDACTED]"))
		}
	}
	var clean map[string]any
	_ = json.Unmarshal(data, &clean)
	return clean
}
func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func list(v any) []any         { a, _ := v.([]any); return a }
func short(v any, n int) string {
	s := text(v)
	if len(s) > n {
		s = s[:n]
	}
	return s
}
func fields(m map[string]any, names ...string) map[string]any {
	r := map[string]any{}
	for _, name := range names {
		if value, ok := m[name]; ok {
			r[name] = short(value, 256)
		}
	}
	return r
}

func (c *Client) Query(ctx context.Context, q Query) (map[string]any, error) {
	result := c.connection.Metadata()
	result["metric"] = q.Metric
	result["source"] = "configured_kubernetes_api"
	result["exitCode"] = 0
	if q.Metric == "version" || q.Metric == "identity" {
		body, err := c.get(ctx, "/version", nil, 64<<10)
		if err != nil {
			return nil, err
		}
		var v struct {
			GitVersion string `json:"gitVersion"`
		}
		if json.Unmarshal(body, &v) != nil || len(v.GitVersion) > 128 || !versionPattern.MatchString(v.GitVersion) {
			return nil, errors.New("Kubernetes API Server 返回的版本信息无效")
		}
		for _, secret := range []string{c.connection.token, c.connection.password} {
			if secret != "" && strings.Contains(v.GitVersion, secret) {
				return nil, errors.New("Kubernetes API Server 返回的版本信息无效")
			}
		}
		result["version"] = v.GitVersion
		result["identity"] = map[string]any{"api_server": c.connection.endpoint, "context": c.connection.selectedContext, "target_match": true, "binding": "saved resource endpoint and context; resource display name is an alias"}
		return c.safe(result), nil
	}
	namespace := q.Namespace
	if namespace == "" {
		namespace = c.connection.namespace
	}
	if err := ValidateNamespace(namespace); err != nil {
		return nil, err
	}
	query := url.Values{"limit": {"100"}}
	if len(q.Continue) > 8192 || strings.ContainsAny(q.Continue, "\r\n\x00") {
		return nil, errors.New("无效的 Kubernetes 分页标记")
	}
	if q.Continue != "" {
		query.Set("continue", q.Continue)
	}
	path := ""
	switch q.Metric {
	case "nodes", "resources":
		path = "/api/v1/nodes"
	case "namespaces":
		path = "/api/v1/namespaces"
	case "deployments", "replicasets", "statefulsets", "daemonsets":
		path = "/apis/apps/v1/namespaces/" + url.PathEscape(namespace) + "/" + q.Metric
		result["namespace"] = namespace
	case "pods", "events":
		path = "/api/v1/namespaces/" + url.PathEscape(namespace) + "/" + q.Metric
		result["namespace"] = namespace
		if q.Metric == "events" {
			query.Set("fieldSelector", "type=Warning")
		}
	case "logs":
		for _, name := range []string{q.Pod, q.Container} {
			if name == "" && q.Pod != "" {
				continue
			}
			if len(name) > 253 || !objectName.MatchString(name) {
				return nil, errors.New("日志需使用实际 Pod 和 container 名称")
			}
		}
		minutes := q.SinceMinutes
		if minutes == 0 {
			minutes = 20
		}
		if minutes < 1 || minutes > 60 {
			return nil, errors.New("日志时间范围必须为 1–60 分钟")
		}
		query = url.Values{"tailLines": {"150"}, "limitBytes": {"65536"}, "sinceSeconds": {strconv.Itoa(minutes * 60)}}
		if q.Container != "" {
			query.Set("container", q.Container)
		}
		if q.Previous {
			query.Set("previous", "true")
		}
		body, err := c.get(ctx, "/api/v1/namespaces/"+url.PathEscape(namespace)+"/pods/"+url.PathEscape(q.Pod)+"/log", query, 64<<10)
		if err != nil {
			return nil, err
		}
		result["namespace"], result["pod"], result["container"], result["output"], result["bounded"] = namespace, q.Pod, q.Container, string(body), true
		return c.safe(result), nil
	default:
		return nil, errors.New("不支持的 Kubernetes 观察；只允许版本、节点、工作负载、Pod、命名空间、事件、资源容量或日志")
	}
	body, err := c.get(ctx, path, query, 4<<20)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil || payload["items"] == nil {
		return nil, errors.New("Kubernetes 观察结果格式无效")
	}
	items, ok := payload["items"].([]any)
	if !ok {
		return nil, errors.New("Kubernetes 观察结果格式无效")
	}
	projected := []any{}
	projectedBytes := 0
	clipped := false
	for _, item := range items[:min(len(items), 100)] {
		v := obj(item)
		meta, status, spec := obj(v["metadata"]), obj(v["status"]), obj(v["spec"])
		row := fields(meta, "name", "namespace")
		row["uid"] = short(meta["uid"], 128)
		row["resource_version"] = short(meta["resourceVersion"], 256)
		owners := []any{}
		for _, owner := range list(meta["ownerReferences"]) {
			if len(owners) >= 8 {
				clipped = true
				break
			}
			owners = append(owners, fields(obj(owner), "kind", "name", "uid"))
		}
		row["owners"] = owners
		switch q.Metric {
		case "deployments", "replicasets", "statefulsets", "daemonsets":
			row["kind"] = q.Metric
			if n, ok := spec["replicas"].(float64); ok && n >= 0 && math.Trunc(n) == n {
				row["desired_replicas"] = n
			}
			if n, ok := meta["generation"].(float64); ok && n >= 0 && math.Trunc(n) == n {
				row["generation"] = n
			}
			row["status"] = map[string]any{}
			for _, field := range []string{"replicas", "readyReplicas", "availableReplicas", "updatedReplicas", "observedGeneration", "numberReady", "desiredNumberScheduled", "updatedNumberScheduled"} {
				if v, ok := status[field].(float64); ok && v >= 0 && math.Trunc(v) == v {
					obj(row["status"])[field] = v
				}
			}
			conditions := []any{}
			for _, condition := range list(status["conditions"]) {
				if len(conditions) >= 16 {
					clipped = true
					break
				}
				conditions = append(conditions, fields(obj(condition), "type", "status", "reason", "message"))
			}
			row["conditions"] = conditions
		case "nodes":
			addresses := []any{}
			for _, a := range list(status["addresses"]) {
				m := obj(a)
				if m["type"] == "InternalIP" {
					addresses = append(addresses, short(m["address"], 64))
				}
			}
			row["internal_ips"] = addresses
			row["unschedulable"] = spec["unschedulable"] == true
			conditions := []any{}
			allConditions := list(status["conditions"])
			if len(allConditions) > 16 {
				clipped = true
			}
			for _, item := range allConditions[:min(len(allConditions), 16)] {
				conditions = append(conditions, fields(obj(item), "type", "status", "reason"))
			}
			row["conditions"] = conditions
			row["nodeInfo"] = fields(obj(status["nodeInfo"]), "kubeletVersion", "containerRuntimeVersion", "operatingSystem", "architecture")
		case "resources":
			row["capacity"] = fields(obj(status["capacity"]), "cpu", "memory", "pods", "ephemeral-storage")
			row["allocatable"] = fields(obj(status["allocatable"]), "cpu", "memory", "pods", "ephemeral-storage")
			row["note"] = "capacity/allocatable are not measured current usage"
		case "pods":
			row["phase"], row["node"], row["reason"] = short(status["phase"], 64), short(spec["nodeName"], 253), short(status["reason"], 128)
			containers := []any{}
			allContainers := list(status["containerStatuses"])
			if len(allContainers) > 64 {
				clipped = true
			}
			for _, item := range allContainers[:min(len(allContainers), 64)] {
				m := obj(item)
				r := fields(m, "name")
				r["ready"] = m["ready"] == true
				r["restartCount"] = m["restartCount"]
				state := obj(m["state"])
				for _, kind := range []string{"waiting", "terminated"} {
					if value := obj(state[kind]); value != nil {
						r["state"], r["reason"] = kind, short(value["reason"], 128)
					}
				}
				containers = append(containers, r)
			}
			row["containers"] = containers
		case "events":
			row["reason"], row["message"], row["count"], row["lastTimestamp"] = short(v["reason"], 128), short(v["message"], 512), v["count"], short(v["lastTimestamp"], 128)
			row["object"] = fields(obj(v["involvedObject"]), "kind", "name", "namespace")
		case "namespaces":
			row["phase"] = short(status["phase"], 64)
		}
		encoded, _ := json.Marshal(row)
		if projectedBytes+len(encoded) > 56<<10 {
			clipped = true
			break
		}
		projectedBytes += len(encoded)
		projected = append(projected, row)
	}
	next := short(obj(payload["metadata"])["continue"], 8192)
	result["items"], result["count"], result["truncated"] = projected, len(projected), clipped || next != "" || len(items) > 100
	if clipped || len(items) > 100 {
		result["source_truncated"] = true
		result["note"] = "This page exceeded the projection limit. A continue token starts the next API page and does not recover clipped records in this page; narrow the namespace or report incomplete evidence."
	}
	if next != "" {
		result["continue_token"] = next
	}
	return c.safe(result), nil
}
