package kubernetes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Action permits only one concrete object; arbitrary paths/specs and bulk deletion
// are deliberately not an API. Identity must come from a fresh observation.
type NotExecutedError struct{ Err error }

func (e *NotExecutedError) Error() string { return e.Err.Error() }
func (e *NotExecutedError) Unwrap() error { return e.Err }

type Action struct {
	Action, Kind, Namespace, Name, UID, ResourceVersion string
	Replicas                                            *int
}

func (c *Client) actionTarget(a Action) (Action, string, error) {
	if a.Namespace == "" {
		a.Namespace = c.connection.namespace
	}
	if err := ValidateNamespace(a.Namespace); err != nil {
		return a, "", err
	}
	if len(a.Name) > 253 || !objectName.MatchString(a.Name) {
		return a, "", errors.New("需要实际 Kubernetes 对象名称")
	}
	switch a.Action {
	case "scale":
		if a.Kind != "deployments" && a.Kind != "replicasets" && a.Kind != "statefulsets" {
			return a, "", errors.New("仅支持 Deployment、ReplicaSet 或 StatefulSet 缩放")
		}
	case "restart":
		if a.Kind != "deployments" && a.Kind != "statefulsets" && a.Kind != "daemonsets" {
			return a, "", errors.New("仅支持 Deployment、StatefulSet 或 DaemonSet 滚动重启")
		}
	case "delete_pod":
		if a.Kind != "pods" {
			return a, "", errors.New("仅支持删除单个明确 Pod；控制器可能重新创建它")
		}
	default:
		return a, "", errors.New("不支持的 Kubernetes 操作")
	}
	prefix := "/apis/apps/v1/namespaces/"
	if a.Kind == "pods" {
		prefix = "/api/v1/namespaces/"
	}
	return a, prefix + url.PathEscape(a.Namespace) + "/" + a.Kind + "/" + url.PathEscape(a.Name), nil
}

// Capabilities uses SelfSubjectAccessReview, which evaluates permissions without
// changing a workload. An unavailable authorizer is unknown, never assumed allow.
func (c *Client) Capabilities(ctx context.Context, a Action) (map[string]any, error) {
	a, _, err := c.actionTarget(a)
	if err != nil {
		return nil, err
	}
	verb, subresource := "patch", ""
	if a.Action == "scale" {
		verb, subresource = "update", "scale"
	}
	if a.Action == "delete_pod" {
		verb = "delete"
	}
	group := "apps"
	if a.Kind == "pods" {
		group = ""
	}
	attrs := map[string]any{"group": group, "resource": a.Kind, "subresource": subresource, "namespace": a.Namespace, "name": a.Name, "verb": verb}
	body, err := c.request(ctx, http.MethodPost, "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews", nil, map[string]any{"apiVersion": "authorization.k8s.io/v1", "kind": "SelfSubjectAccessReview", "spec": map[string]any{"resourceAttributes": attrs}}, "application/json", 64<<10)
	if err != nil {
		return nil, err
	}
	var response struct {
		Status struct {
			Allowed         *bool  `json:"allowed"`
			Denied          bool   `json:"denied"`
			EvaluationError string `json:"evaluationError"`
		} `json:"status"`
	}
	if json.Unmarshal(body, &response) != nil || response.Status.Allowed == nil || response.Status.EvaluationError != "" {
		return nil, errors.New("Kubernetes 权限预检未能确定结果；未执行变更")
	}
	result := c.connection.Metadata()
	result["action"], result["attributes"], result["allowed"] = a.Action, attrs, *response.Status.Allowed && !response.Status.Denied
	result["source"] = "kubernetes_self_subject_access_review"
	return c.safe(result), nil
}

func (c *Client) Act(ctx context.Context, a Action) (result map[string]any, err error) {
	sent := false
	defer func() {
		if err != nil && !sent {
			err = &NotExecutedError{Err: err}
		}
	}()
	a, path, err := c.actionTarget(a)
	if err != nil {
		return nil, err
	}
	for _, identity := range []string{a.UID, a.ResourceVersion} {
		if identity == "" || len(identity) > 256 || strings.ContainsAny(identity, "\r\n\x00") {
			return nil, errors.New("变更前须查询对象的 UID 和 resourceVersion")
		}
	}
	if a.Action == "scale" && (a.Replicas == nil || *a.Replicas < 0 || *a.Replicas > 10000) {
		return nil, errors.New("副本数须为 0～10000 的明确整数")
	}
	if a.Action != "scale" && a.Replicas != nil {
		return nil, errors.New("此操作不接受副本数")
	}
	permission, err := c.Capabilities(ctx, a)
	if err != nil {
		return nil, err
	}
	if permission["allowed"] != true {
		return nil, errors.New("当前账号没有本次 Kubernetes 操作权限；未修改工作负载")
	}
	meta := map[string]any{"name": a.Name, "namespace": a.Namespace, "uid": a.UID, "resourceVersion": a.ResourceVersion}
	method, contentType := http.MethodPatch, "application/merge-patch+json"
	var payload any
	switch a.Action {
	case "scale":
		method, contentType, path = http.MethodPut, "application/json", path+"/scale"
		payload = map[string]any{"apiVersion": "autoscaling/v1", "kind": "Scale", "metadata": meta, "spec": map[string]any{"replicas": *a.Replicas}}
	case "restart":
		payload = map[string]any{"metadata": meta, "spec": map[string]any{"template": map[string]any{"metadata": map[string]any{"annotations": map[string]any{"kubectl.kubernetes.io/restartedAt": time.Now().UTC().Format(time.RFC3339Nano)}}}}}
	case "delete_pod":
		method, contentType = http.MethodDelete, "application/json"
		payload = map[string]any{"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": map[string]any{"uid": a.UID, "resourceVersion": a.ResourceVersion}}
	}
	sent = true
	body, err := c.request(ctx, method, path, nil, payload, contentType, 4<<20)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && (apiErr.Status == 401 || apiErr.Status == 403 || apiErr.Status == 404 || apiErr.Status == 409 || apiErr.Status == 422) {
			return nil, &NotExecutedError{Err: err}
		}
		return nil, err
	} // No transport or conflict retries: outcome may be unknown.
	var response map[string]any
	if json.Unmarshal(body, &response) != nil {
		return nil, errors.New("操作响应无法解析，请只读核对对象；不要重复变更")
	}
	result = c.connection.Metadata()
	result["action"], result["kind"], result["namespace"], result["name"] = a.Action, a.Kind, a.Namespace, a.Name
	result["uid"], result["resource_version"] = a.UID, short(obj(response["metadata"])["resourceVersion"], 256)
	result["status"], result["exitCode"] = "accepted", 0
	result["note"] = "API 已接受请求；必须重新查询工作负载、Pod 和事件确认实际结果，不能据此宣布业务恢复"
	if a.Replicas != nil {
		result["requested_replicas"] = *a.Replicas
	}
	if a.Action == "delete_pod" {
		result["note"] = fmt.Sprintf("已请求删除 Pod %s；控制器可能重建，需重新查询确认", a.Name)
	}
	return c.safe(result), nil
}
