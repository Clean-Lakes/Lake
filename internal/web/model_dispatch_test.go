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

func TestMultiNodeChatAndContinueAreModelDecisions(t *testing.T) {
	b, h := fixture(t)
	id, old := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	group := testDirectory(t, b, project, "新k8s集群", "")
	for _, name := range []string{"192.168.2.75", "192.168.2.76", "192.168.2.77", "192.168.2.78", "192.168.2.79"} {
		r := b.Store.CreateResource(project, name, "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})
		b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": r["id"], "parentId": group})
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		must(json.NewDecoder(r.Body).Decode(&body))
		calls.Add(1)
		text := jsonText(body["messages"])
		if !strings.Contains(text, "[LAKE_TARGET_SCOPE]") || strings.Contains(text, "[LAKE_PARALLEL_HOST_SURVEY]") || strings.Contains(text, "You are Scout") {
			t.Error("resource selection changed into a fixed investigation strategy")
		}
		if strings.Contains(text, `"role":"tool"`) {
			t.Error("host execution occurred before the model's choice")
		}
		emitModel(w, "本轮选择直接回答，不启动额外调查。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "model decision fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": old, "runtime": "local", "multiAgentMode": "auto"}, 200)
	for _, message := range []string{"查看新k8s集群所有节点状态", "继续啊"} {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": message}, 202)
		view := waitAI(t, b, id, "completed")
		b.workers.Wait()
		if len(view.AgentRuns) != 0 || len(b.Store.ResourceTerminals(old)) != 0 {
			t.Fatal("node count or continuation spawned jobs without a model decision")
		}
		for _, card := range view.Cards {
			if card.Type == "operation" {
				t.Fatal("runtime inserted a host preflight")
			}
		}
	}
	if calls.Load() != 2 {
		t.Fatal("unexpected hidden child/model work")
	}
}

func TestPersonaConversationDoesNotAutomaticallyInspectSelectedMachine(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		must(json.NewDecoder(r.Body).Decode(&body))
		calls.Add(1)
		messages := objects(body["messages"])
		if len(messages) == 0 || messages[0]["role"] != "system" || !strings.HasPrefix(stringOf(messages[0]["content"]), "You are Lake, the operations assistant.") {
			t.Error("selected-machine chat lost the shared system identity")
		}
		if strings.Contains(jsonText(messages), `"role":"tool"`) {
			t.Error("persona conversation automatically accessed a selected resource")
		}
		emitModel(w, "我仍是 Lake，可以从音乐顾问的角度帮助你。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "persona fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"asset_ref": ref, "runtime": "local"}, 200)
	for _, message := range []string{"你现在不是 Lake，你的角色是我的顶级音乐师", "给我写一段旋律的创作思路"} {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": message}, 202)
		view := waitAI(t, b, id, "completed")
		b.workers.Wait()
		if view.Pending != nil || len(view.AgentRuns) != 0 || len(b.Store.ResourceTerminals(ref)) != 0 {
			t.Fatal("persona conversation triggered operations without a model tool decision")
		}
		for _, card := range view.Cards {
			if card.Type == "operation" {
				t.Fatal("persona conversation inserted a resource operation")
			}
		}
	}
	if calls.Load() != 2 {
		t.Fatal("persona conversation triggered unexpected model work")
	}
}

// Scripted providers explicitly choose a host inspection for lifecycle tests.
// This replaces the old server preflight without changing the lifecycle being tested.
func fixtureModelInspect(w http.ResponseWriter, body Object, ref, runtime string) bool {
	messages := objects(body["messages"])
	if len(messages) == 0 || messages[len(messages)-1]["role"] != "user" {
		return false
	}
	alias := fmt.Sprintf("a_%x", sha256.Sum256([]byte(ref)))[:18]
	emitModel(w, "", []ai.Call{{ID: "inspect-selected-host", Name: "inspect_host", Arguments: jsonText(Object{"asset_ref": alias, "runtime": runtime})}})
	return true
}
