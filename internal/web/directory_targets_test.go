package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func testDirectory(t *testing.T, b *Server, project, name, parent string) string {
	t.Helper()
	before := map[string]bool{}
	for _, n := range objects(b.Store.Catalog()["resourceTree"]) {
		before[stringOf(n["id"])] = true
	}
	for _, node := range b.Store.EditResourceTree(project, Object{"operation": "create", "name": name, "parentId": parent}) {
		if !before[stringOf(node["id"])] {
			return stringOf(node["id"])
		}
	}
	t.Fatal("missing created directory")
	return ""
}

func TestQuestionAnswerRecoversDirectoryTargetInSameTurn(t *testing.T) {
	b, h := fixture(t)
	id, old := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	root := testDirectory(t, b, project, "志梦亿", "")
	group := testDirectory(t, b, project, "隆泰", root)
	hostIDs := []string{}
	for i := 1; i <= 27; i++ {
		resource := b.Store.CreateResource(project, fmt.Sprintf("172.16.31.%d", i), "local", Object{})
		hostIDs = append(hostIDs, stringOf(resource["id"]))
		// Test-only synthetic hosts execute locally; seed their legacy grouping directly.
		b.Store.update(func() any {
			b.Store.exec("UPDATE resourceTree SET parentId=? WHERE resourceId=?", group, resource["id"])
			return nil
		})
	}
	for _, name := range []string{"隆泰生产-sr", "隆泰生产-pg"} {
		resource := b.Store.CreateResource(project, name, "database", Object{"driver": "postgres", "host": "192.0.2.69"})
		b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": resource["id"], "parentId": group})
	}
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		must(json.NewDecoder(r.Body).Decode(&body))
		messages := objects(body["messages"])
		switch requests.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{
				{ID: "question", Name: "ask_user_question", Arguments: `{"questions":[{"id":"target","title":"选择要检查的主机","options":["全部隆泰主机（172.16.31.1-27，共27台）","只查其他主机"]}]}`},
				{ID: "same-batch-probe", Name: "shell", Arguments: jsonText(Object{"asset_ref": ai.AssetAlias(hostIDs[0]), "runtime": "local", "command": "printf scope-recovered"})},
			})
		case 2:
			var result Object
			must(json.Unmarshal([]byte(stringOf(messages[len(messages)-2]["content"])), &result))
			scope := object(result["target_scope"])
			if scope["needsClarification"] != false || len(objects(scope["resources"])) != 27 {
				t.Error("human answer did not publish the recovered host scope")
			}
			probe := stringOf(messages[len(messages)-1]["content"])
			if strings.Contains(probe, `"error"`) || !strings.Contains(probe, "scope-recovered") {
				t.Error("same-batch probe used the stale target scope")
			}
			emitModel(w, "", []ai.Call{{ID: "probe", Name: "shell", Arguments: jsonText(Object{"asset_ref": ai.AssetAlias(hostIDs[1]), "runtime": "local", "command": "printf scope-recovered"})}})
		case 3:
			result := stringOf(messages[len(messages)-1]["content"])
			if strings.Contains(result, `"error"`) || !strings.Contains(result, "scope-recovered") {
				t.Errorf("authorized probe did not execute after answering: %s", result)
			}
			emitModel(w, "目标范围已恢复。", nil)
		default:
			latestUser := ""
			for _, message := range messages {
				if message["role"] == "user" {
					latestUser = stringOf(message["content"])
				}
			}
			if !strings.Contains(latestUser, `"needsClarification":false`) || strings.Contains(latestUser, "隆泰生产-pg") || strings.Contains(latestUser, "隆泰生产-sr") {
				t.Error("follow-up lost or expanded the confirmed host scope")
			}
			emitModel(w, "继续使用已确认的27台主机。", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "target recovery fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"multiAgentMode": "off", "asset_ref": old, "runtime": "local", "silentCommands": true, "silentTerminalCreation": true, "blockUnreferencedAssets": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "不确定的资源目录下有哪些主机"}, 202)
	var request *ai.QuestionRequest
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		view, err := b.Engine.Snapshot(id)
		must(err)
		if view.Question != nil {
			request = view.Question
			break
		}
		time.Sleep(time.Millisecond)
	}
	if request == nil {
		t.Fatal("target question was not displayed")
	}
	blocked, err := b.Engine.TargetScope(id)
	must(err)
	if blocked == nil || !blocked.NeedsClarification {
		t.Fatal("test did not start with an unresolved directory scope")
	}
	// Proposed options, skipped answers and expired replies cannot select hosts.
	if b.questionTargetScope(id, nil) != nil || b.questionTargetScope(id, map[string][]string{"target": {"继续"}}) != nil {
		t.Fatal("unanswered or unrelated question inferred a target")
	}
	answers := Object{"target": []string{"全部隆泰主机（172.16.31.1-27，共27台）"}}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/questionReply", Object{"id": "expired", "answers": answers}, 409)
	stillBlocked, err := b.Engine.TargetScope(id)
	must(err)
	if stillBlocked == nil || !stillBlocked.NeedsClarification {
		t.Fatal("expired answer changed the scope")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/questionReply", Object{"id": request.ID, "answers": answers}, 200)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	if view.Pending != nil || view.Question != nil || requests.Load() != 3 {
		t.Fatal("existing permissions did not allow the investigation to continue")
	}
	scope, err := b.Engine.TargetScope(id)
	must(err)
	if scope == nil || scope.NeedsClarification || !reflect.DeepEqual(scope.DirectoryIDs, []string{group}) || len(scope.ResourceIDs) != 27 {
		t.Fatal("confirmed scope was not persisted")
	}
	snapshot := b.Store.Snapshot(id)
	groups, _ := directoryInventory(snapshot)
	direct, _ := b.directoryTurnScope(id, "继续检查志梦亿/隆泰的全部主机", nil, groups, objects(snapshot["resources"]))
	if direct == nil || direct.NeedsClarification || len(direct.ResourceIDs) != 27 {
		t.Fatal("a new mention of confirmed hosts expanded to databases")
	}
	if len(b.Store.ResourceTerminals(old)) != 0 {
		t.Fatal("recovery accessed the old host")
	}
	permissions := b.Store.Options(id)
	if permissions["silentCommands"] != true || permissions["blockUnreferencedAssets"] != true {
		t.Fatal("recovery changed user permissions")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "应该是nfs目录 说错了，继续检查导出目录和挂载目录"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	restarted, err := ai.New(b.Engine.Dir, nil, nil)
	must(err)
	defer restarted.Shutdown()
	scope, err = restarted.TargetScope(id)
	must(err)
	if scope == nil || scope.NeedsClarification || len(scope.ResourceIDs) != 27 {
		t.Fatal("restart lost the confirmed scope")
	}
}

func TestQuestionDirectoryTargetStillRequiresUnambiguousResources(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	root := testDirectory(t, b, project, "志梦亿", "")
	group := testDirectory(t, b, project, "隆泰", root)
	host := b.Store.CreateResource(project, "172.16.31.1", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})
	b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": host["id"], "parentId": group})
	other := testDirectory(t, b, project, "测试环境", "")
	testDirectory(t, b, project, "隆泰", other)
	for _, answer := range []string{"全部隆泰主机", "志梦亿/隆泰主机"} {
		scope := b.questionTargetScope(id, map[string][]string{"target": {answer}})
		if answer == "全部隆泰主机" {
			if scope == nil || !scope.NeedsClarification || len(scope.ResourceIDs) != 0 {
				t.Fatal("ambiguous answer selected hosts")
			}
		} else if scope == nil || scope.NeedsClarification || !reflect.DeepEqual(scope.ResourceIDs, []string{stringOf(host["id"])}) {
			t.Fatal("full directory path did not resolve ambiguity")
		}
	}
	if b.questionTargetScope(id, map[string][]string{"target": {"不要查志梦亿/隆泰主机"}}) != nil {
		t.Fatal("negative answer selected hosts")
	}
	snapshot := b.Store.Snapshot(id)
	groups, _ := directoryInventory(snapshot)
	initial, _ := b.directoryTurnScope(id, "应该是nfs目录 说错了", nil, groups, objects(snapshot["resources"]))
	if initial == nil || !initial.NeedsClarification {
		t.Fatal("an NFS filesystem directory without a confirmed host scope became executable")
	}
	testDirectory(t, b, project, "空目录", root)
	scope := b.questionTargetScope(id, map[string][]string{"target": {"志梦亿/空目录"}})
	if scope == nil || !scope.NeedsClarification || len(scope.ResourceIDs) != 0 {
		t.Fatal("empty directory answer fell back to another host")
	}
}
func TestDirectoryScopeResolvesNestedNodesAndAmbiguity(t *testing.T) {
	b, h := fixture(t)
	id, old := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	root := testDirectory(t, b, project, "南京公司", "")
	group := testDirectory(t, b, project, "新k8s集群", root)
	workers := testDirectory(t, b, project, "Workers", group)
	a := b.Store.CreateResource(project, "192.168.2.79", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})
	c := b.Store.CreateResource(project, "192.168.2.75", "ssh", Object{"host": "fixture.invalid", "username": "fixture", "port": 22})
	b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": a["id"], "parentId": group})
	b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": c["id"], "parentId": workers})
	snapshot := b.Store.Snapshot(id)
	groups, paths := directoryInventory(snapshot)
	if !reflect.DeepEqual(paths[stringOf(c["id"])], []string{"南京公司", "新k8s集群", "Workers"}) {
		t.Fatal("nested resource path missing")
	}
	scope, refs := b.directoryTurnScope(id, "k8s新集群 目录下就是新集群的节点啊", nil, groups, objects(snapshot["resources"]))
	if scope == nil || scope.NeedsClarification || len(scope.ResourceIDs) != 2 || len(refs) != 2 {
		t.Fatal("word-order folder reference did not select both descendants")
	}
	for _, ref := range scope.ResourceIDs {
		if ref == old {
			t.Fatal("old host entered new directory scope")
		}
	}
	scope, _ = b.directoryTurnScope(id, "南京公司目录下的新k8s集群节点", nil, groups, objects(snapshot["resources"]))
	if len(scope.DirectoryIDs) != 1 || scope.DirectoryIDs[0] != group {
		t.Fatal("parent qualifier broadened target beyond named child")
	}
	secondRoot := testDirectory(t, b, project, "测试环境", "")
	testDirectory(t, b, project, "新k8s集群", secondRoot)
	snapshot = b.Store.Snapshot(id)
	groups, _ = directoryInventory(snapshot)
	scope, _ = b.directoryTurnScope(id, "新k8s集群目录下的节点", nil, groups, objects(snapshot["resources"]))
	if scope == nil || !scope.NeedsClarification || len(scope.ResourceIDs) != 0 {
		t.Fatal("duplicate leaf name was guessed")
	}
	scope, _ = b.directoryTurnScope(id, "检查南京公司/新k8s集群目录下的节点", nil, groups, objects(snapshot["resources"]))
	if scope.NeedsClarification || len(scope.DirectoryIDs) != 1 || scope.DirectoryIDs[0] != group {
		t.Fatal("full path did not resolve duplicate leaf")
	}
	empty := testDirectory(t, b, project, "空集群", "")
	snapshot = b.Store.Snapshot(id)
	groups, _ = directoryInventory(snapshot)
	scope, _ = b.directoryTurnScope(id, "空集群目录下的节点", nil, groups, objects(snapshot["resources"]))
	if !scope.NeedsClarification || scope.DirectoryIDs[0] != empty || len(scope.ResourceIDs) != 0 {
		t.Fatal("empty group fell back to an unrelated host")
	}
	scope, _ = b.directoryTurnScope(id, "不存在的集群目录下有哪些节点", nil, groups, objects(snapshot["resources"]))
	if scope == nil || !scope.NeedsClarification {
		t.Fatal("unknown directory fell back to old binding")
	}
	scope, _ = b.directoryTurnScope(id, "读取 /var/log 目录里的日志", []Object{{"asset_ref": old}}, groups, objects(snapshot["resources"]))
	if scope != nil {
		t.Fatal("filesystem path was mistaken for project directory")
	}
}
func TestDirectoryCorrectionSkipsOldHostPreflightAndBlocksLocalFallback(t *testing.T) {
	b, h := fixture(t)
	id, old := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	root := testDirectory(t, b, project, "南京公司", "")
	group := testDirectory(t, b, project, "新k8s集群", root)
	for _, host := range []string{"192.168.2.79", "192.168.2.75"} {
		resource := b.Store.CreateResource(project, host, "ssh", Object{"host": "192.0.2.79", "port": 22, "username": "fixture"})
		b.Store.EditResourceTree(project, Object{"operation": "move", "nodeId": resource["id"], "parentId": group})
	}
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		must(json.NewDecoder(r.Body).Decode(&body))
		n := requests.Add(1)
		messages := objects(body["messages"])
		content := jsonText(body["messages"])
		if n == 1 {
			if !strings.Contains(content, "[LAKE_TARGET_SCOPE]") || !strings.Contains(content, "南京公司/新k8s集群") {
				t.Error("model did not get actual directory target")
			}
			for _, message := range messages {
				for _, call := range objects(message["tool_calls"]) {
					if object(call["function"])["name"] == "inspect_host" {
						t.Error("old bound host was inspected before resolving new directory")
					}
				}
			}
			emitModel(w, "", []ai.Call{{ID: "lookup", Name: "list_assets", Arguments: `{"pattern":"k8s新集群"}`}})
			return
		}
		if n == 2 {
			var result []Object
			must(json.Unmarshal([]byte(stringOf(messages[len(messages)-1]["content"])), &result))
			if len(result) != 2 {
				t.Errorf("expected directory's two nodes, got %d", len(result))
			}
			for _, resource := range result {
				if resource["name"] == "Local machine" || resource["folder_path"] != "南京公司/新k8s集群" {
					t.Error("directory lookup returned old/outside host")
				}
			}
			emitModel(w, "", []ai.Call{{ID: "wrong-local", Name: "shell", Arguments: `{"runtime":"local","command":"uname -s"}`}})
			return
		}
		if n == 3 {
			if !strings.Contains(stringOf(messages[len(messages)-1]["content"]), "目录") {
				t.Error("local fallback was not blocked by the resolved directory scope")
			}
			emitModel(w, "已识别新集群目录的两个节点，没有执行本地配置推断。", nil)
			return
		}
		if !strings.Contains(content, "[LAKE_TARGET_SCOPE]") {
			t.Error("follow-up lost the directory target")
		}
		emitModel(w, "继续使用已选择的目录范围。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "directory fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"multiAgentMode": "off", "asset_ref": old, "runtime": "local", "silentTerminalCreation": true, "silentCommands": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "k8s新集群 目录下就是新集群的节点啊"}, 202)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	if requests.Load() != 3 {
		t.Fatal("wrong model call count")
	}
	if len(b.Store.ResourceTerminals(old)) != 0 {
		t.Fatal("old host was accessed")
	}
	for _, card := range view.Cards {
		if card.Title == "list_assets" && object(card.Data)["target"] != "项目资源目录" {
			t.Fatal("lookup UI still showed old host")
		}
	}
	scope, err := b.Engine.TargetScope(id)
	must(err)
	if scope == nil || len(scope.ResourceIDs) != 2 {
		t.Fatal("directory scope was not retained")
	}
	scope.ResourceIDs[0] = "tamper"
	again, _ := b.Engine.TargetScope(id)
	if again.ResourceIDs[0] == "tamper" {
		t.Fatal("caller could mutate stored scope")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "再看看内存"}, 202)
	waitAI(t, b, id, "completed")
	b.workers.Wait()
	if len(b.Store.ResourceTerminals(old)) != 0 {
		t.Fatal("follow-up rechecked old host")
	}
	snapshot := b.Store.Snapshot(id)
	groups, _ := directoryInventory(snapshot)
	selected, _ := b.directoryTurnScope(id, "检查这台主机", []Object{{"asset_ref": old}}, groups, objects(snapshot["resources"]))
	if selected != nil {
		t.Fatal("explicit asset reference could not switch away from directory")
	}
	outside := b.Store.CreateResource(project, "192.168.2.200", "local", Object{})
	snapshot = b.Store.Snapshot(id)
	groups, _ = directoryInventory(snapshot)
	switched, selectedRefs := b.directoryTurnScope(id, "查看 192.168.2.200 的内存", nil, groups, objects(snapshot["resources"]))
	if switched != nil || len(selectedRefs) != 1 || selectedRefs[0]["asset_ref"] != outside["id"] {
		t.Fatal("an explicit IP could not switch directory selection")
	}
	kept, _ := b.directoryTurnScope(id, "不要查 192.168.2.200，继续看这个目录", nil, groups, objects(snapshot["resources"]))
	if kept == nil || len(kept.ResourceIDs) != 2 {
		t.Fatal("negative IP mention switched the intended directory")
	}
	b.Store.EditResourceTree(project, Object{"operation": "delete", "nodeId": group})
	snapshot = b.Store.Snapshot(id)
	groups, _ = directoryInventory(snapshot)
	selected, _ = b.directoryTurnScope(id, "再检查一次", nil, groups, objects(snapshot["resources"]))
	if selected == nil || !selected.NeedsClarification || len(selected.ResourceIDs) != 0 {
		t.Fatal("deleted directory silently widened the resource scope")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/clearReferences", Object{}, 200)
	cleared, err := b.Engine.TargetScope(id)
	if err != nil || cleared != nil {
		t.Fatal("clearing referenced resources retained the old directory scope")
	}
}
