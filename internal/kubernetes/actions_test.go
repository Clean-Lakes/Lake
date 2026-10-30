package kubernetes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestActionsUseSavedTargetPermissionsAndIdentityPreconditions(t *testing.T) {
	for _, tc := range []struct{ action, kind, method, suffix string }{
		{"scale", "replicasets", "PUT", "/scale"}, {"scale", "deployments", "PUT", "/scale"}, {"scale", "statefulsets", "PUT", "/scale"},
		{"restart", "deployments", "PATCH", ""}, {"restart", "statefulsets", "PATCH", ""}, {"restart", "daemonsets", "PATCH", ""}, {"delete_pod", "pods", "DELETE", ""},
	} {
		t.Run(tc.action+tc.kind, func(t *testing.T) {
			var mutations, checks atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer synthetic-test-token" {
					t.Error("missing saved credential")
				}
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					t.Error("missing JSON body")
				}
				if r.URL.Path == "/saved/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" {
					checks.Add(1)
					attrs := obj(obj(body["spec"])["resourceAttributes"])
					verb, sub := "patch", ""
					if tc.action == "scale" {
						verb, sub = "update", "scale"
					}
					if tc.action == "delete_pod" {
						verb = "delete"
					}
					if r.Method != "POST" || attrs["resource"] != tc.kind || attrs["name"] != "uwb-old" || attrs["namespace"] != "production" || attrs["verb"] != verb || attrs["subresource"] != sub {
						t.Error("incorrect permission target", attrs)
					}
					fmt.Fprint(w, `{"status":{"allowed":true}}`)
					return
				}
				mutations.Add(1)
				prefix := "/saved/apis/apps/v1/namespaces/production/"
				if tc.kind == "pods" {
					prefix = "/saved/api/v1/namespaces/production/"
				}
				if r.Method != tc.method || r.URL.Path != prefix+tc.kind+"/uwb-old"+tc.suffix || checks.Load() != 1 {
					t.Error("wrong mutation target or no preflight")
				}
				identity := obj(body["metadata"])
				if tc.action == "delete_pod" {
					identity = obj(body["preconditions"])
				}
				if identity["uid"] != "original-uid" || identity["resourceVersion"] != "opaque-rv" {
					t.Error("missing identity preconditions")
				}
				if tc.action == "scale" && obj(body["spec"])["replicas"] != float64(0) {
					t.Error("scale to zero lost")
				}
				if tc.action == "restart" {
					annotations := obj(obj(obj(obj(body["spec"])["template"])["metadata"])["annotations"])
					if annotations["kubectl.kubernetes.io/restartedAt"] == nil || r.Header.Get("Content-Type") != "application/merge-patch+json" {
						t.Error("invalid restart patch")
					}
				}
				fmt.Fprint(w, `{"metadata":{"resourceVersion":"new-rv","annotations":{"secret":"must-not-project"}},"spec":{"secret":"must-not-project"}}`)
			}))
			defer server.Close()
			client, err := New(map[string]any{"endpoint": server.URL + "/saved", "namespace": "production"}, map[string]string{"token": "synthetic-test-token"})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			a := Action{Action: tc.action, Kind: tc.kind, Name: "uwb-old", UID: "original-uid", ResourceVersion: "opaque-rv"}
			zero := 0
			if tc.action == "scale" {
				a.Replicas = &zero
			}
			result, err := client.Act(context.Background(), a)
			if err != nil || mutations.Load() != 1 {
				t.Fatal(result, err)
			}
			raw, _ := json.Marshal(result)
			if strings.Contains(string(raw), "must-not-project") || result["status"] != "accepted" {
				t.Fatal("unsafe or overclaimed mutation result", string(raw))
			}
		})
	}
}

func TestActionPreflightDenialsErrorsAndConflictsNeverRetry(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		code           int
		mutations      int32
	}{
		{"denied", `{"status":{"allowed":false}}`, 200, 0}, {"unknown", `{"status":{"evaluationError":"missing authorizer"}}`, 200, 0}, {"forbidden", `{}`, 403, 0}, {"unauthenticated", `{}`, 401, 0}, {"conflict", `{"status":{"allowed":true}}`, 409, 1}, {"server error", `{"status":{"allowed":true}}`, 500, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var changes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "selfsubjectaccessreviews") {
					if tc.mutations == 0 {
						w.WriteHeader(tc.code)
					}
					fmt.Fprint(w, tc.response)
					return
				}
				changes.Add(1)
				w.WriteHeader(tc.code)
				fmt.Fprint(w, `{"message":"untrusted-secret"}`)
			}))
			defer server.Close()
			client, _ := New(map[string]any{"endpoint": server.URL}, nil)
			defer client.Close()
			zero := 0
			_, err := client.Act(context.Background(), Action{Action: "scale", Kind: "replicasets", Name: "uwb", UID: "uid", ResourceVersion: "rv", Replicas: &zero})
			var notExecuted *NotExecutedError
			if errors.As(err, &notExecuted) != (tc.code != 500) {
				t.Fatal("incorrect operation uncertainty", err)
			}
			if err == nil || changes.Load() != tc.mutations || strings.Contains(err.Error(), "untrusted-secret") {
				t.Fatal("unexpected dispatch/retry or leaked response", changes.Load(), err)
			}
		})
	}
}

func TestInvalidActionsNeverContactCluster(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer server.Close()
	client, _ := New(map[string]any{"endpoint": server.URL}, nil)
	defer client.Close()
	zero, negative := 0, -1
	for _, a := range []Action{
		{Action: "scale", Kind: "secrets", Name: "x"}, {Action: "delete_pod", Kind: "deployments", Name: "x"}, {Action: "restart", Kind: "replicasets", Name: "x"},
		{Action: "scale", Kind: "deployments", Name: "x/../../bad", UID: "uid", ResourceVersion: "rv", Replicas: &zero}, {Action: "scale", Kind: "deployments", Name: "x", UID: "uid", ResourceVersion: "rv", Replicas: &negative},
		{Action: "scale", Kind: "deployments", Name: "x", UID: "uid", ResourceVersion: "rv"}, {Action: "restart", Kind: "deployments", Name: "x"}, {Action: "delete_pod", Kind: "pods", Name: "x", Namespace: "../bad", UID: "uid", ResourceVersion: "rv"},
	} {
		if _, err := client.Act(context.Background(), a); err == nil {
			t.Fatal("invalid mutation accepted", a)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid requests contacted cluster")
	}
}

func TestWorkloadQueriesProjectRolloutOwnersAndIdentityWithoutSpec(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || !strings.HasPrefix(r.URL.Path, "/apis/apps/v1/namespaces/default/") {
			t.Error("bad workload query")
		}
		fmt.Fprint(w, `{"items":[{"metadata":{"name":"uwb","uid":"uid","resourceVersion":"rv","ownerReferences":[{"kind":"Deployment","name":"uwb","uid":"parent"}],"generation":2},"spec":{"replicas":1,"template":{"secret":"must-not-project"}},"status":{"replicas":1,"readyReplicas":0,"observedGeneration":2,"conditions":[{"type":"Progressing","reason":"ReplicaSetUpdated"}]}}]}`)
	}))
	defer server.Close()
	client, _ := New(map[string]any{"endpoint": server.URL}, nil)
	defer client.Close()
	for _, metric := range []string{"deployments", "replicasets", "statefulsets", "daemonsets"} {
		result, err := client.Query(context.Background(), Query{Metric: metric})
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(result)
		row := obj(list(result["items"])[0])
		if strings.Contains(string(raw), "must-not-project") || row["resource_version"] != "rv" || row["uid"] != "uid" || len(list(row["owners"])) != 1 {
			t.Fatal("incorrect projection", string(raw))
		}
	}
}

func TestLostMutationResponseIsUnknownAndNeverRetried(t *testing.T) {
	var changes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "selfsubjectaccessreviews") {
			fmt.Fprint(w, `{"status":{"allowed":true}}`)
			return
		}
		changes.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer server.Close()
	client, _ := New(map[string]any{"endpoint": server.URL}, nil)
	defer client.Close()
	zero := 0
	_, err := client.Act(context.Background(), Action{Action: "scale", Kind: "replicasets", Name: "uwb", UID: "uid", ResourceVersion: "rv", Replicas: &zero})
	var notExecuted *NotExecutedError
	if err == nil || errors.As(err, &notExecuted) || changes.Load() != 1 {
		t.Fatal("unknown response retried or misreported", changes.Load(), err)
	}
}
