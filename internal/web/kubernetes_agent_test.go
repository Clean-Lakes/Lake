package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestKubernetesResourceWorksThroughConversationWithoutSSHOrNameMatch(t *testing.T) {
	b, h := fixture(t)
	sid, local := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	const token = "synthetic-kube-agent-private-token"
	var reads atomic.Int32
	cluster := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if r.Method != "GET" || r.URL.Path != "/cluster/api/v1/nodes" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("wrong cluster, operation or credential")
			w.WriteHeader(403)
			return
		}
		fmt.Fprint(w, `{"metadata":{},"items":[{"metadata":{"name":"selected-master","annotations":{"password":"must-not-reach-model"}},"status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"kubeletVersion":"v1.28.11"}},"spec":{"secret":"must-not-reach-model"}}]}`)
	}))
	defer cluster.Close()
	raw := withKubeCA(syntheticKubeconfig(cluster.URL+"/cluster", token), cluster.Certificate())
	r := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"name": "Nanjing-k1", "kind": "kubernetes", "settings": kubeSettings(raw)}, 201)
	ref := stringOf(r["id"])
	var modelCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		must(json.NewDecoder(r.Body).Decode(&body))
		text := jsonText(body)
		if strings.Contains(text, token) || strings.Contains(text, "must-not-reach-model") || strings.Contains(text, "certificate-authority-data") {
			t.Error("credential or Pod spec reached model")
		}
		switch modelCalls.Add(1) {
		case 1:
			if !strings.Contains(text, `query_kubernetes`) {
				t.Error("native Kubernetes tool missing")
			}
			emitModel(w, "", []ai.Call{{ID: "discover-kube", Name: "list_assets", Arguments: `{"pattern":"Nanjing-k1"}`}})
		case 2:
			if !strings.Contains(text, `query_tool`) || !strings.Contains(text, `production`) {
				t.Error("discovery omitted Kubernetes connection/capabilities")
			}
			emitModel(w, "", []ai.Call{{ID: "query-native-kube", Name: "query_kubernetes", Arguments: jsonText(Object{"asset_ref": ai.AssetAlias(ref), "metric": "nodes"})}})
		default:
			if !strings.Contains(text, "selected-master") || !strings.Contains(text, "Ready") {
				t.Error("actual selected cluster status did not reach model")
			}
			emitModel(w, "Nanjing-k1 的 selected-master 节点 Ready，版本 v1.28.11。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "kubernetes fixture", Protocol: "openai", ContextWindow: 64000})
	old := b.Terminals.Open(context.Background(), sid, local)
	tid := stringOf(old["id"])
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/configure", Object{"asset_ref": local, "terminal_id": tid, "blockUnreferencedAssets": true}, 200)
	policy, err := b.bridge(context.Background(), sid, "policy", Object{"name": "query_kubernetes", "arguments": Object{"asset_ref": ref, "metric": "nodes"}, "terminal_id": tid}, false)
	if err != nil || object(policy)["terminal_id"] != nil || object(policy)["asset_ref"] != ref || object(policy)["target"] != "Nanjing-k1" {
		t.Fatal("query inherited old terminal or target")
	}
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/messages", Object{"text": "Nanjing-k1 状态如何", "resourceIds": []string{ref}}, 202)
	view := waitAI(t, b, sid, "completed")
	b.workers.Wait()
	if view.Pending != nil || reads.Load() != 1 || modelCalls.Load() != 3 {
		t.Fatalf("native Kubernetes query did not complete: reads=%d modelCalls=%d", reads.Load(), modelCalls.Load())
	}
	for _, value := range []any{view, b.Store.Snapshot(sid), b.Store.Catalog()} {
		if text := jsonText(value); strings.Contains(text, token) || strings.Contains(text, "must-not-reach-model") {
			t.Fatal("secret persisted in public history")
		}
	}
}

func TestKubernetesActionsPolicyDoesNotBorrowOldHostTerminal(t *testing.T) {
	b, h := fixture(t)
	sid, local := newSession(t, h)
	project := stringOf(b.Store.Session(sid)["projectId"])
	cluster := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("policy must not contact cluster") }))
	defer cluster.Close()
	raw := withKubeCA(syntheticKubeconfig(cluster.URL, "synthetic-policy-token"), cluster.Certificate())
	r := apiTest(t, h, "POST", "/api/projects/"+project+"/resources", Object{"name": "Nanjing-k1", "kind": "kubernetes", "settings": kubeSettings(raw)}, 201)
	ref := stringOf(r["id"])
	old := b.Terminals.Open(context.Background(), sid, local)
	tid := stringOf(old["id"])
	apiTest(t, h, "POST", "/api/sessions/"+sid+"/ai/configure", Object{"asset_ref": local, "terminal_id": tid}, 200)
	for _, name := range []string{"query_kubernetes", "kubernetes_capabilities", "kubernetes_action"} {
		for _, terminalID := range []string{tid, "deleted-old-terminal"} {
			policy, err := b.bridge(context.Background(), sid, "policy", Object{"name": name, "arguments": Object{"asset_ref": ref, "action": "scale", "kind": "replicasets", "namespace": "production", "name": "uwb"}, "terminal_id": terminalID}, false)
			p := object(policy)
			if err != nil || p["terminal_id"] != nil || p["asset_ref"] != ref || p["target"] != "Nanjing-k1" || p["runtime"] != "kubernetes" || p["needsTerminal"] == true {
				t.Fatal("Kubernetes operation borrowed SSH policy", p, err)
			}
		}
	}
}
