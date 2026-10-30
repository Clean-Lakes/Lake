package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKubernetesActionRequiresApprovalAndIsRecordedWithoutReplay(t *testing.T) {
	for _, accept := range []bool{false, true} {
		t.Run(fmt.Sprint(accept), func(t *testing.T) {
			var mutations, preflights atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "selfsubjectaccessreviews") {
					preflights.Add(1)
					fmt.Fprint(w, `{"status":{"allowed":true}}`)
					return
				}
				if r.Method != "PUT" || r.URL.Path != "/apis/apps/v1/namespaces/prod/replicasets/uwb-old/scale" {
					t.Error("wrong action")
				}
				mutations.Add(1)
				fmt.Fprint(w, `{"metadata":{"resourceVersion":"new-rv"}}`)
			}))
			defer server.Close()
			call := Call{ID: "scale-original", Name: "kubernetes_action", Arguments: js(map[string]any{"asset_ref": assetAlias("kube"), "action": "scale", "kind": "replicasets", "namespace": "prod", "name": "uwb-old", "uid": "uid", "resource_version": "rv", "replicas": 0})}
			m, closeModel := fakeModel(t, func(n int, body map[string]any) any {
				if n == 1 {
					if !strings.Contains(js(body), "Before offering or promising a concrete change") {
						t.Error("capability rule missing")
					}
					return response("", call)
				}
				return response("已核对本次请求状态。")
			})
			defer closeModel()
			e := engineFor(t, m, nil)
			s, _ := e.get("case")
			c := s.state.Config
			p := DefaultPermissions()
			p.SilentCommands = true
			c.Permissions = &p
			c.Assets = []Asset{{ID: "kube", Name: "Nanjing-k1", Kind: "kubernetes", Settings: map[string]any{"endpoint": server.URL}}}
			if err := e.Configure("case", c); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- e.Chat(ctx, "case", "把 Nanjing-k1 prod 的 uwb-old 副本数调为 0", nil) }()
			decided := false
			for !decided {
				select {
				case err := <-done:
					t.Fatal("turn ended before approval", err)
				case <-ctx.Done():
					t.Fatal("no approval")
				default:
				}
				view, _ := e.Snapshot("case")
				if view.Pending != nil {
					if mutations.Load() != 0 || preflights.Load() != 0 || view.Pending.Target != "Nanjing-k1" || view.Pending.Risk != "write" {
						t.Fatal("change escaped approval or target", view.Pending)
					}
					if err := e.Decision("case", view.Pending.ID, accept, view.Pending.Confirmation); err != nil {
						t.Fatal(err)
					}
					decided = true
				}
				time.Sleep(5 * time.Millisecond)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			want := int32(0)
			if accept {
				want = 1
			}
			if mutations.Load() != want || preflights.Load() != want {
				t.Fatal("unexpected dispatch count", mutations.Load())
			}
			if accept {
				store, _ := e.adkStore()
				var op nativeOperation
				if err := store.DB.First(&op, "tool = ? AND call_id = ?", call.Name, call.ID).Error; err != nil || op.Risk != "write" || op.Status != "succeeded" {
					t.Fatal("missing durable action", op.Status, err)
				}
				replayCtx := context.WithValue(context.Background(), adkToolContextKey{}, true)
				if _, err := e.dispatchNativeOperation(replayCtx, s, c, call, "write", "Nanjing-k1", op.Fingerprint); err == nil {
					t.Fatal("operation replay accepted")
				}
			}
		})
	}
}

func TestKubernetesActionScopeSchemaAndRoleIsolation(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	c := Config{Profile: "core", Assets: []Asset{{ID: "kube", Kind: "kubernetes", Settings: map[string]any{"endpoint": "http://127.0.0.1:1"}}}}
	s, _ := e.get("case")
	a := map[string]any{"asset_ref": assetAlias("kube"), "action": "scale", "kind": "replicasets", "namespace": "prod", "name": "uwb", "uid": "uid", "resource_version": "rv", "replicas": 0}
	if ToolRisk("kubernetes_action", a) != "write" || planToolAllowed("kubernetes_action") || !planToolAllowed("kubernetes_capabilities") {
		t.Fatal("incorrect write/plan policy")
	}
	c.targetScope = &TargetScope{ResourceIDs: []string{"other"}}
	if _, err := e.invoke(context.Background(), s, c, Call{ID: "wrong-scope", Name: "kubernetes_action", Arguments: js(a)}); err == nil {
		t.Fatal("cross-scope mutation accepted")
	}
	c.targetScope = nil
	p := DefaultPermissions()
	p.BlockUnreferencedAssets = true
	c.Permissions = &p
	if _, err := e.invoke(context.Background(), s, c, Call{ID: "unreferenced", Name: "kubernetes_action", Arguments: js(a)}); err == nil {
		t.Fatal("unreferenced mutation accepted")
	}
	tool := kubernetesActionTools()[1]
	for k, v := range map[string]any{"path": "/api/v1/secrets", "manifest": "arbitrary", "replicas": 1.5} {
		bad := map[string]any{}
		for k, v := range a {
			bad[k] = v
		}
		bad[k] = v
		if validateTool(tool, bad) == nil {
			t.Fatal("unsafe schema", k)
		}
	}
	for _, role := range []string{"host", "application", "data", "verify"} {
		if strings.Contains(js(childObservationTools(role, c.Assets)), "kubernetes_action") {
			t.Fatal("read-only child received mutation")
		}
	}
}

func TestKubernetesInvalidSavedConnectionIsRecordedAsNotExecuted(t *testing.T) {
	e := &Engine{}
	c := Config{Assets: []Asset{{ID: "kube", Kind: "kubernetes", Settings: map[string]any{"endpoint": "invalid-endpoint"}}}}
	_, err := e.kubernetesOperation(context.Background(), c, "kubernetes_action", map[string]any{"asset_ref": assetAlias("kube"), "action": "scale", "kind": "replicasets", "name": "uwb", "namespace": "prod"})
	var notExecuted *ToolNotExecutedError
	if !errors.As(err, &notExecuted) {
		t.Fatal("known pre-dispatch failure became uncertain", err)
	}
}
