package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func workflowFixtureInput(ref string) Object {
	return Object{"name": "Application workflow", "goal": "Investigate application errors", "steps": []Object{{"id": "logs", "role": "application", "task": "Read fixture app log", "resourceIds": []string{ref}}}}
}
func TestWorkflowTemplateCRUDScopeVersionAndSnapshots(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	base := "/api/projects/" + project + "/workflows"
	saved := apiTest(t, h, "POST", base, workflowFixtureInput(ref), 201)
	id := stringOf(saved["id"])
	if integer(saved["version"]) != 1 {
		t.Fatal("missing initial version")
	}
	apiTest(t, h, "POST", base+"/"+id+"/run", Object{"version": 1}, 409)
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": true}, 200)
	apiTest(t, h, "POST", base+"/"+id+"/run", Object{"version": 1}, 400)
	snapshot := b.Store.CreateWorkflowRun(project, id, 1)
	input := workflowFixtureInput(ref)
	input["name"] = "Changed template"
	input["version"] = 1
	apiTest(t, h, "PUT", base+"/"+id, input, 200)
	apiTest(t, h, "PUT", base+"/"+id, input, 409)
	if object(b.Store.WorkflowRun(project, stringOf(snapshot["id"]))["template"])["name"] != "Application workflow" {
		t.Fatal("editing mutated run snapshot")
	}
	apiTest(t, h, "DELETE", base+"/"+id, Object{"version": 1}, 409)
	apiTest(t, h, "DELETE", base+"/"+id, Object{"version": 2}, 200)
	history := b.Store.WorkflowRun(project, stringOf(snapshot["id"]))
	if history["workflowId"] != nil || object(history["template"])["name"] != "Application workflow" {
		t.Fatal("template deletion lost history")
	}
	other := b.Store.CreateProject("Other project")
	otherBase := "/api/projects/" + stringOf(other["id"]) + "/workflows"
	apiTest(t, h, "POST", otherBase, workflowFixtureInput(ref), 400)
	apiTest(t, h, "GET", "/api/projects/"+stringOf(other["id"])+"/workflow-runs/"+stringOf(snapshot["id"]), nil, 404)
	for _, role := range []string{"change", "verify", "data"} {
		bad := workflowFixtureInput(ref)
		bad["steps"] = []Object{{"id": "step", "role": role, "task": "test", "resourceIds": []string{ref}}}
		apiTest(t, h, "POST", base, bad, 400)
	}
	bad := workflowFixtureInput(ref)
	bad["steps"] = []Object{{"id": "same", "role": "host", "task": "test", "resourceIds": []string{ref}}, {"id": "same", "role": "host", "task": "test", "resourceIds": []string{ref}}}
	apiTest(t, h, "POST", base, bad, 400)
	b.Store.FinishWorkflowRun(stringOf(snapshot["id"]), "cancelled", "Stopped")
	if b.Store.WorkflowRun(project, stringOf(snapshot["id"]))["status"] != "cancelled" {
		t.Fatal("run did not finish")
	}
}
func TestWorkflowRestartInterruptsWithoutReplay(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	saved := apiTest(t, h, "POST", "/api/projects/"+project+"/workflows", workflowFixtureInput(ref), 201)
	run := b.Store.CreateWorkflowRun(project, stringOf(saved["id"]), 1)
	dir := b.Store.Dir
	b.Close()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recovered := store.WorkflowRun(project, stringOf(run["id"]))
	if recovered["status"] != "interrupted" || recovered["finishedAt"] == nil {
		t.Fatal("running workflow was not interrupted")
	}
}
func TestWorkflowHTTPStartsRealAgentsAndCancelsFromConversation(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": true}, 200)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(dir, "fixture.log")
	if err := os.WriteFile(log, []byte("WORKFLOW_HTTP_RAW timeout\n"), 0600); err != nil {
		t.Fatal(err)
	}
	refs := regexp.MustCompile(`a_[a-f0-9]{16}`)
	evidence := regexp.MustCompile(`ev_[0-9a-f]{32}`)
	var mu sync.Mutex
	calls := map[string]int{}
	blocked := make(chan struct{}, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body Object
		json.NewDecoder(r.Body).Decode(&body)
		content := jsonText(body["messages"])
		role := "parent"
		if strings.Contains(content, "You are Lake's investigator") {
			role = "Trace"
		}
		if strings.Contains(content, "You are Lake's independent verifier") {
			role = "Beacon"
		}
		mu.Lock()
		calls[role]++
		n := calls[role]
		mu.Unlock()
		if role == "Trace" && n == 3 {
			blocked <- struct{}{}
			<-r.Context().Done()
			return
		}
		if role == "parent" {
			emitModel(w, "Workflow root report", nil)
			return
		}
		if n%2 == 1 {
			if role == "Beacon" {
				emitModel(w, "", []ai.Call{{ID: "raw", Name: "read_evidence", Arguments: `{}`}})
			} else {
				emitModel(w, "", []ai.Call{{ID: "logs", Name: "observe_logs", Arguments: jsonText(Object{"asset_ref": refs.FindString(content), "path": log})}})
			}
			return
		}
		emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "已取得工作流日志", "facts": []Object{{"statement": "读取到实际日志", "evidenceIds": evidence.FindAllString(content, -1)}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "workflow fixture", "protocol": "openai"}, 200)
	base := "/api/projects/" + project + "/workflows"
	saved := apiTest(t, h, "POST", base, workflowFixtureInput(ref), 201)
	run := apiTest(t, h, "POST", base+"/"+stringOf(saved["id"])+"/run", Object{"version": 1}, 202)
	deadline := time.Now().Add(6 * time.Second)
	for {
		current := apiTest(t, h, "GET", "/api/projects/"+project+"/workflow-runs/"+stringOf(run["id"]), nil, 200)
		if current["status"] != "running" {
			if current["status"] != "completed" || len(objects(current["agentRuns"])) != 2 {
				t.Fatal(current)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("workflow did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Block the second run at a real child model request, then use the chat stop button.
	run = apiTest(t, h, "POST", base+"/"+stringOf(saved["id"])+"/run", Object{"version": 1}, 202)
	id := stringOf(run["sessionId"])
	deadline = time.Now().Add(5 * time.Second)
	select {
	case <-blocked:
	case <-time.After(5 * time.Second):
		t.Fatal("child request did not start")
	}
	apiTest(t, h, "POST", "/api/sessions/"+id+"/messages", Object{"text": "Must not inject an extra workflow step"}, 409)
	apiTest(t, h, "POST", "/api/sessions/"+id+"/ai/abort", Object{}, 200)
	for {
		current := b.Store.WorkflowRun(project, stringOf(run["id"]))
		if current["status"] != "running" {
			if current["status"] != "cancelled" {
				t.Fatal(current)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("abort did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
