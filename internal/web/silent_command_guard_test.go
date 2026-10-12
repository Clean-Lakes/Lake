package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSilentComplexCommandsAndCatastrophicBoundary(t *testing.T) {
	b, h := fixture(t)
	id, ref := newSession(t, h)
	dir := t.TempDir()
	file := filepath.Join(dir, "must-remain.txt")
	must(os.WriteFile(file, []byte("isolated fixture"), 0600))
	commands := []string{
		"find " + quote(dir) + " -type f -exec stat {} \\; | head -5",
		"sh -c 'printf complex-command-completed'",
		"rm -rf " + quote(dir) + "/*",
	}
	var steps atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request Object
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid model request")
			return
		}
		if len(objects(request["tools"])) == 0 {
			emitModel(w, "Prior fixture operations summarized", nil)
			return
		}
		n := int(steps.Add(1))
		if n%2 == 1 {
			emitModel(w, "", []ai.Call{{ID: "silent-complex", Name: "shell", Arguments: jsonText(Object{"command": commands[(n-1)/2]})}})
		} else {
			emitModel(w, "done", nil)
		}
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "silent execution fixture", Protocol: "openai"})
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/configure", Object{"silentCommands": true, "silentTerminalCreation": false, "asset_ref": ref}, 200)
	for i := range commands {
		apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "测试隔离命令"}, 202)
		if i < 2 {
			view := waitAI(t, b, id, "completed")
			b.workers.Wait()
			if view.Pending != nil {
				t.Fatal("complex command ignored silent setting")
			}
			actions := objects(b.Store.Snapshot(id)["actions"])
			last := actions[len(actions)-1]
			if last["status"] != "succeeded" || stringOf(last["terminalId"]) == "" {
				t.Fatal("command did not execute on a persistent terminal")
			}
		} else {
			view := waitAI(t, b, id, "waiting_approval")
			if view.Pending == nil || view.Pending.Kind != "delete" || view.Pending.Confirmation == "" {
				t.Fatal("broad deletion lost explicit confirmation")
			}
			apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/decision", Object{"id": view.Pending.ID, "accept": false}, 200)
			waitAI(t, b, id, "completed")
			b.workers.Wait()
		}
		if _, err := os.Stat(file); err != nil {
			t.Fatal("unapproved broad deletion executed")
		}
	}
}
