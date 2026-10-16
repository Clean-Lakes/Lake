package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestMultipleReferencesKeepTheirScopeAcrossTurnsWithoutTargetApproval(t *testing.T) {
	b, h := fixture(t)
	id, first := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ids := []string{first}
	for i := 2; i <= 3; i++ {
		r := b.Store.CreateResource(project, fmt.Sprintf("selected node %d", i), "local", Object{})
		ids = append(ids, stringOf(r["id"]))
	}
	outside := b.Store.CreateResource(project, "unselected node", "local", Object{})
	dir := t.TempDir()
	must(os.WriteFile(filepath.Join(dir, "fixture-plugin.jar"), []byte("synthetic plugin"), 0600))
	var requests atomic.Int32
	var outsideProbe atomic.Bool
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		must(json.NewDecoder(r.Body).Decode(&body))
		if len(objects(body["tools"])) == 0 {
			emitModel(w, "已读取三台选定节点的插件目录，继续使用原目标集合。", nil)
			return
		}
		n := requests.Add(1)
		if n%2 == 0 {
			emitModel(w, "目录检查完成。", nil)
			return
		}
		selected := ids
		if outsideProbe.Load() {
			selected = []string{stringOf(outside["id"])}
		}
		calls := []ai.Call{}
		for i, ref := range selected {
			calls = append(calls, ai.Call{ID: fmt.Sprintf("list-%d-%d", n, i), Name: "ls", Arguments: jsonText(Object{"runtime": "local", "asset_ref": ai.AssetAlias(ref), "path": dir})})
		}
		emitModel(w, "检查选定节点上的目录。", calls)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "multi-reference scope fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": true, "silentTerminalCreation": true, "silentReadFiles": true, "blockUnreferencedAssets": true}, 200)
	waitTurn := func(turn int, status string) ai.View {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
			view, err := b.Engine.Snapshot(id)
			must(err)
			if view.Turns >= turn && view.Status == status {
				return view
			}
			if view.Turns >= turn && view.Pending != nil && status != "waiting_approval" {
				t.Fatalf("unexpected confirmation in turn %d: %s", turn, view.Pending.Kind)
			}
			time.Sleep(time.Millisecond)
		}
		view, _ := b.Engine.Snapshot(id)
		t.Fatalf("turn %d did not reach %s (turns=%d status=%s)", turn, status, view.Turns, view.Status)
		return view
	}
	for i, text := range []string{"检查这些节点", "分析一下集群有没有这两个目录", "继续啊 你有权限", "继续"} {
		data := Object{"text": text}
		if i == 0 || i == 3 {
			data["resourceIds"] = ids
		}
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", data, 202)
		view := waitTurn(i+1, "completed")
		b.workers.Wait()
		if view.Pending != nil || requests.Load() != int32((i+1)*2) {
			t.Fatal("explicit/follow-up targets required another confirmation")
		}
		scope, err := b.Engine.TargetScope(id)
		must(err)
		if scope == nil || scope.NeedsClarification || !reflect.DeepEqual(scope.ResourceIDs, ids) || len(scope.DirectoryIDs) != 0 {
			t.Fatalf("multi-reference scope lost or expanded: %+v", scope)
		}
		completed := 0
		for _, card := range view.Cards {
			if card.Title == "ls" {
				if card.Status != "completed" || !strings.Contains(card.Content, "fixture-plugin.jar") {
					t.Fatalf("actual selected-node directory read failed: %s %s", card.Status, card.Content)
				}
				completed++
			}
		}
		if completed != (i+1)*3 {
			t.Fatal("not all selected nodes were read", completed)
		}
	}
	// Scope is independent of model history compaction and persists on reload.
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/compact", Object{}, 200)
	reopened, err := ai.New(b.Engine.Dir, nil, nil)
	must(err)
	scope, err := reopened.TargetScope(id)
	must(err)
	reopened.Shutdown()
	if scope == nil || !reflect.DeepEqual(scope.ResourceIDs, ids) {
		t.Fatal("compaction/reload lost selected resources")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "继续读取这几个目录"}, 202)
	view := waitTurn(5, "completed")
	b.workers.Wait()
	if requests.Load() != 10 || view.Pending != nil {
		t.Fatal("compacted follow-up required re-selection")
	}
	// A model-chosen fourth node remains outside the current user selection,
	// even if it is remembered for context and visible under the permission set.
	must(b.Engine.RememberResource(id, stringOf(outside["id"])))
	outsideProbe.Store(true)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "继续检查"}, 202)
	view = waitTurn(6, "completed")
	b.workers.Wait()
	blocked := false
	history, err := b.Engine.History(id)
	must(err)
	for _, message := range history {
		if message.Role == "tool" && message.CallID == "list-11-0" && strings.Contains(message.Content, "目标") && !strings.Contains(message.Content, "fixture-plugin.jar") {
			blocked = true
		}
	}
	if !blocked {
		t.Fatal("remembered but unselected resource escaped the scope")
	}
	// Selecting targets does not grant read permission after the user revokes it.
	outsideProbe.Store(false)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentReadFiles": false}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "继续"}, 202)
	view = waitTurn(7, "waiting_approval")
	if view.Pending == nil || view.Pending.Kind != "file_read" {
		t.Fatal("target selection bypassed read permission or re-requested resource selection")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
	b.workers.Wait()
}

func TestResourceSelectionRevalidationDoesNotWidenOrGuessMissingMembers(t *testing.T) {
	resources := []Object{{"id": "a"}, {"id": "b"}, {"id": "new"}}
	scope := resourceSelectionScope([]string{"a", "b", "a"}, resources)
	if scope.NeedsClarification || !reflect.DeepEqual(scope.ResourceIDs, []string{"a", "b"}) {
		t.Fatal("selection was not kept exact", scope)
	}
	for _, ids := range [][]string{{"a", "deleted"}, {}, {"foreign-project"}} {
		scope = resourceSelectionScope(ids, resources)
		if !scope.NeedsClarification || len(scope.ResourceIDs) != 0 {
			t.Fatal("missing selection silently widened or shrank", scope)
		}
	}
}

func TestSubmittedHostAnswerRecoversUnresolvedTargetInSameBatch(t *testing.T) {
	b, h := fixture(t)
	id, _ := newSession(t, h)
	project := stringOf(b.Store.Session(id)["projectId"])
	ids := []string{}
	names := []string{"192.0.2.64", "192.0.2.65", "192.0.2.66"}
	for _, name := range names {
		r := b.Store.CreateResource(project, name, "local", Object{})
		ids = append(ids, stringOf(r["id"]))
	}
	dir := t.TempDir()
	must(os.WriteFile(filepath.Join(dir, "answer-recovered.jar"), []byte("fixture"), 0600))
	answer := strings.Join(names, "、")
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			emitModel(w, "请确认检查哪些节点。", []ai.Call{
				{ID: "question", Name: "ask_user_question", Arguments: jsonText(Object{"questions": []Object{{"id": "targets", "title": "确认节点", "options": []string{answer, "不检查"}}}})},
				{ID: "after-answer", Name: "ls", Arguments: jsonText(Object{"runtime": "local", "asset_ref": ai.AssetAlias(ids[0]), "path": dir})},
			})
			return
		}
		emitModel(w, "目标已确认，目录已读取。", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "host answer fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentReadFiles": true, "silentCommands": true, "silentTerminalCreation": true, "blockUnreferencedAssets": true}, 200)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "看看集群有没有这两个目录"}, 202)
	var question *ai.QuestionRequest
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		view, err := b.Engine.Snapshot(id)
		must(err)
		if view.Question != nil {
			question = view.Question
			break
		}
		time.Sleep(time.Millisecond)
	}
	if question == nil {
		t.Fatal("target question was not emitted")
	}
	if b.questionTargetScope(id, nil) != nil || b.questionTargetScope(id, map[string][]string{"targets": {"继续啊 你有权限"}}) != nil || b.questionTargetScope(id, map[string][]string{"targets": {"不要查 " + answer}}) != nil {
		t.Fatal("unsubmitted, unrelated or negative answer authorized nodes")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/questionReply", Object{"id": question.ID, "answers": Object{"targets": []string{answer}}}, 200)
	view := waitAI(t, b, id, "completed")
	b.workers.Wait()
	read := false
	for _, card := range view.Cards {
		if card.Title == "ls" && card.Status == "completed" && strings.Contains(card.Content, "answer-recovered.jar") {
			read = true
		}
	}
	scope, err := b.Engine.TargetScope(id)
	must(err)
	if !read || requests.Load() != 2 || scope == nil || scope.NeedsClarification || !reflect.DeepEqual(scope.ResourceIDs, ids) {
		t.Fatal("submitted hosts did not recover the same-batch read", scope)
	}
	b.Store.CreateResource(project, names[0], "local", Object{})
	if got := b.questionTargetScope(id, map[string][]string{"targets": {names[0]}}); got == nil || !got.NeedsClarification || len(got.ResourceIDs) != 0 {
		t.Fatal("duplicate host names were guessed")
	}
}
