package web

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

// 巡检一个目录下的节点应当在一个模型往返内批量下发：模型两次调用
// （出方案 + 汇总）即可覆盖全部节点，而不是每台节点一次往返。
func TestClusterInspectionBatchesNodeChecksInOneModelRoundTrip(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	root := testDirectory(t, b, project, "南京公司", "")
	group := testDirectory(t, b, project, "新k8s集群", root)
	names := []string{"192.168.2.75", "192.168.2.76", "192.168.2.77", "192.168.2.78", "192.168.2.79"}
	nodes := []Object{}
	for _, name := range names {
		node := b.Store.CreateResource(project, name, "local", Object{})
		// These synthetic hosts run harmless fixture commands locally; this is a
		// legacy test layout, not an exception to the production move restriction.
		b.Store.update(func() any {
			b.Store.exec("UPDATE resourceTree SET parentId=? WHERE resourceId=?", group, node["id"])
			return nil
		})
		nodes = append(nodes, node)
	}
	var modelCalls atomic.Int32
	var scopeSeen atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		context := jsonText(body["messages"])
		if strings.Contains(context, "[LAKE_TARGET_SCOPE]") && strings.Contains(context, "192.168.2.79") {
			scopeSeen.Store(true)
		}
		if modelCalls.Add(1) == 1 {
			calls := []ai.Call{}
			for i, node := range nodes {
				alias := fmt.Sprintf("a_%x", sha256.Sum256([]byte(stringOf(node["id"]))))[:18]
				calls = append(calls, ai.Call{ID: fmt.Sprintf("node-%d", i), Name: "shell", Arguments: jsonText(Object{"command": "uname -s", "runtime": "local", "asset_ref": alias})})
			}
			emitModel(w, "", calls)
			return
		}
		emitModel(w, "巡检完成：5 台节点均已返回检查结果。", nil)
	}))
	defer provider.Close()
	b.Models.Save(b.Models.Input(Object{"url": provider.URL, "name": "cluster inspection fixture", "protocol": "openai"}))
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "silentCommands": true, "silentTerminalCreation": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "对k8s新集群进行运检"}, 202)
	view := waitAI(t, b, id, "completed")
	if !scopeSeen.Load() {
		t.Fatal("模型上下文缺少目录目标集合")
	}
	if modelCalls.Load() != 2 {
		t.Fatalf("节点巡检未在一个往返内批量下发：模型调用 %d 次", modelCalls.Load())
	}
	executed := 0
	for _, card := range view.Cards {
		if card.Type == "operation" {
			executed++
		}
	}
	if executed != len(names) {
		t.Fatalf("批量命令未逐台执行：%d", executed)
	}
}
