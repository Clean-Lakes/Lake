package kubernetes

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestQueryRedactsBasicAuthenticationReflections(t *testing.T) {
	const password = "synthetic-basic-password"
	encoded := base64.StdEncoding.EncodeToString([]byte("reader:" + password))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "reader" || pass != password {
			t.Error("basic authentication was lost")
		}
		fmt.Fprintf(w, `{"items":[{"metadata":{"name":"warning"},"message":%q}]}`, password+" Basic "+encoded)
	}))
	defer server.Close()
	raw := fmt.Sprintf("apiVersion: v1\nkind: Config\ncurrent-context: selected\nclusters:\n- name: cluster\n  cluster:\n    server: %s\ncontexts:\n- name: selected\n  context:\n    cluster: cluster\n    user: reader\nusers:\n- name: reader\n  user:\n    username: reader\n    password: %s\n", server.URL+"/", password)
	client, err := New(map[string]any{"authMethod": "kubeconfig", "endpoint": server.URL}, map[string]string{"kubeconfig": raw})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	result, err := client.Query(context.Background(), Query{Metric: "events"})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), password) || strings.Contains(string(data), encoded) {
		t.Fatal("authentication reflected into result")
	}
}

func TestQueriesAreBoundToSavedEndpointAndProjectOnlyNonsecretFields(t *testing.T) {
	const token = "synthetic-api-only-token"
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("unexpected mutation or authentication")
			w.WriteHeader(401)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/selected/") {
			t.Error("lost saved API prefix")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/selected/version":
			fmt.Fprint(w, `{"gitVersion":"v1.28.11"}`)
		case "/selected/api/v1/nodes":
			if r.URL.Query().Get("limit") != "100" {
				t.Error("missing bound")
			}
			fmt.Fprint(w, `{"metadata":{"continue":"page-two"},"items":[{"metadata":{"name":"master-01","uid":"node-uid","annotations":{"secret":"must-not-project"}},"spec":{"providerID":"must-not-project"},"status":{"addresses":[{"type":"InternalIP","address":"192.0.2.75"}],"conditions":[{"type":"Ready","status":"True"}],"capacity":{"cpu":"4","memory":"8Gi"},"allocatable":{"cpu":"3900m"},"nodeInfo":{"kubeletVersion":"v1.28.11","containerRuntimeVersion":"containerd://1.7"}}}]}`)
		case "/selected/api/v1/namespaces/saved-ns/pods":
			if r.URL.Query().Get("continue") != "opaque+/=" {
				t.Error("lost opaque page token")
			}
			fmt.Fprintf(w, `{"metadata":{},"items":[{"metadata":{"name":"workload","namespace":"saved-ns"},"spec":{"nodeName":"master-01","containers":[{"env":[{"name":"PASSWORD","value":"must-not-project"}]}]},"status":{"phase":"Running","containerStatuses":[{"name":"app","ready":true,"restartCount":2,"state":{"waiting":{"reason":%q,"message":"must-not-project"}}}]}}]}`, token)
		case "/selected/api/v1/namespaces/other/events":
			if r.URL.Query().Get("fieldSelector") != "type=Warning" {
				t.Error("missing warning filter")
			}
			fmt.Fprintf(w, `{"metadata":{},"items":[{"metadata":{"name":"event"},"message":%q,"reason":"Failed","involvedObject":{"name":"workload","kind":"Pod"}}]}`, token)
		case "/selected/api/v1/namespaces/saved-ns/pods/workload/log":
			q := r.URL.Query()
			if q.Get("tailLines") != "150" || q.Get("limitBytes") != "65536" || q.Get("sinceSeconds") != "1200" || q.Get("container") != "app" || q.Get("previous") != "true" || q.Get("follow") != "" {
				t.Error("unsafe log read")
			}
			fmt.Fprint(w, token+" log line")
		case "/selected/api/v1/namespaces":
			fmt.Fprint(w, `{"items":[{"metadata":{"name":"saved-ns"},"status":{"phase":"Active"}}]}`)
		default:
			t.Error("unrecognized API path")
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	client, err := New(map[string]any{"endpoint": server.URL + "/selected", "namespace": "saved-ns"}, map[string]string{"token": token})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, q := range []Query{{Metric: "identity"}, {Metric: "nodes"}, {Metric: "resources"}, {Metric: "pods", Continue: "opaque+/="}, {Metric: "events", Namespace: "other"}, {Metric: "namespaces"}, {Metric: "logs", Pod: "workload", Container: "app", Previous: true}} {
		result, err := client.Query(context.Background(), q)
		if err != nil {
			t.Fatal(q.Metric, err)
		}
		data, _ := json.Marshal(result)
		if strings.Contains(string(data), token) || strings.Contains(string(data), "must-not-project") {
			t.Fatal("projected a secret or Pod spec")
		}
		if q.Metric == "nodes" && (result["truncated"] != true || result["continue_token"] != "page-two") {
			t.Fatal("pagination was hidden")
		}
		if q.Metric == "identity" && result["context"] != "" {
			t.Fatal("invented a context")
		}
	}
	before := requests.Load()
	for _, q := range []Query{{Metric: "secrets"}, {Metric: "exec"}, {Metric: "/api/v1/secrets"}, {Metric: "logs", Pod: "app/../../secret"}, {Metric: "pods", Namespace: "../bad"}, {Metric: "pods", Continue: "bad\n"}, {Metric: "logs", Pod: "app", SinceMinutes: 61}} {
		if _, err := client.Query(context.Background(), q); err == nil {
			t.Fatal("accepted unbounded query")
		}
	}
	if requests.Load() != before {
		t.Fatal("invalid query reached cluster")
	}
}

func TestQueryRejectsRedirectsAndRBACBodiesAndMarksSourceLimits(t *testing.T) {
	var destinationCalls atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
	defer destination.Close()
	var mode atomic.Value
	mode.Store("redirect")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch mode.Load().(string) {
		case "redirect":
			http.Redirect(w, r, destination.URL, 302)
		case "forbidden":
			w.WriteHeader(403)
			fmt.Fprint(w, "synthetic-sensitive-body")
		case "oversize":
			fmt.Fprint(w, strings.Repeat("x", (4<<20)+1))
		case "malformed":
			fmt.Fprint(w, `{"items":"synthetic-sensitive-body"}`)
		case "many":
			fmt.Fprint(w, `{"items":[`)
			for i := 0; i < 101; i++ {
				if i > 0 {
					fmt.Fprint(w, ",")
				}
				fmt.Fprint(w, `{"metadata":{"name":"node"}}`)
			}
			fmt.Fprint(w, `]}`)
		}
	}))
	defer server.Close()
	client, err := New(map[string]any{"endpoint": server.URL}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, value := range []string{"redirect", "forbidden", "oversize", "malformed"} {
		mode.Store(value)
		_, err := client.Query(context.Background(), Query{Metric: "nodes"})
		if err == nil || strings.Contains(err.Error(), "synthetic-sensitive-body") {
			t.Fatal("accepted unsafe response or echoed body")
		}
	}
	if destinationCalls.Load() != 0 {
		t.Fatal("redirect forwarded credentials")
	}
	mode.Store("many")
	result, err := client.Query(context.Background(), Query{Metric: "nodes"})
	if err != nil || result["truncated"] != true || result["source_truncated"] != true || result["count"] != float64(100) {
		t.Fatal("unbounded list was not marked")
	}
}
