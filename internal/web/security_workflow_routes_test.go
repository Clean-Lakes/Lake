package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
)

func workflowContractHTTP(t *testing.T, b *Server, method, path string, payload Object, auth bool, expected int) Object {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost:4177"+path, strings.NewReader(jsonText(payload)))
	r.Host = "localhost:4177"
	if payload != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	if auth {
		r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	}
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if value := recover(); value != nil {
				if failure, ok := value.(*Failure); ok {
					reply(w, failure.Status, Object{"error": failure.Message})
				} else {
					panic(value)
				}
			}
		}()
		if !b.securityWorkflowRoute(w, r) {
			t.Fatal("workflow contract route not recognized")
		}
	}()
	if w.Code != expected {
		t.Fatalf("%s: %d %s", method, w.Code, w.Body.String())
	}
	var result Object
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSecurityWorkflowRealSREObservationUsesOriginalTaskAndAcceptance(t *testing.T) {
	verifyRealWorkflowObservation(t, false)
}

func TestSuperWorkflowRealSREObservationUsesOriginalTaskAndAcceptance(t *testing.T) {
	verifyRealWorkflowObservation(t, true)
}

func verifyRealWorkflowObservation(t *testing.T, super bool) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("bounded local file identity is deliberately unsupported on Windows")
	}
	b, h := fixture(t)
	session, resource := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": true}, 200)
	if super {
		apiTest(t, h, "POST", "/api/projects/"+project+"/superagent", Object{}, 200)
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(dir, "workflow.log")
	if err = os.WriteFile(log, []byte("ACTUAL_MANAGED_WORKFLOW_LOG healthy\n"), 0600); err != nil {
		t.Fatal(err)
	}
	alias := "a_" + security.ContentDigest([]byte(resource))[:16]
	args := Object{"asset_ref": alias, "path": log}
	evidence := regexp.MustCompile(`ev_[a-f0-9]{32}`)
	var mu sync.Mutex
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input Object
		_ = json.NewDecoder(r.Body).Decode(&input)
		content := jsonText(input["messages"])
		if strings.Contains(content, "You are Lake's investigator") {
			mu.Lock()
			calls++
			n := calls
			mu.Unlock()
			if n == 1 {
				emitModel(w, "", []ai.Call{{ID: "actual-read", Name: "observe_logs", Arguments: jsonText(args)}})
				return
			}
			emitModel(w, jsonText(Object{"schemaVersion": 1, "summary": "实际读取了日志", "facts": []Object{{"statement": "日志采集结果已登记", "evidenceIds": evidence.FindAllString(content, -1)}}, "hypotheses": []string{}, "unknowns": []string{}, "nextChecks": []string{}}), nil)
			return
		}
		emitModel(w, "已汇总已登记证据。", nil)
	}))
	defer provider.Close()
	apiTest(t, h, "PUT", "/api/settings/model", Object{"url": provider.URL, "name": "managed workflow fixture", "protocol": "openai"}, 200)
	saved := apiTest(t, h, "POST", "/api/projects/"+project+"/workflows", workflowFixtureInput(resource), 201)
	workflowID := stringOf(saved["id"])
	template := b.Store.Workflow(project, workflowID)
	policy := security.ProjectPolicy{ProjectID: project, SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{resource}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAllow, Limits: security.ScopeLimits{FileRoots: []string{dir}}}, {Capability: "local.execute", Effect: security.EffectAllow}}}
	if _, err = b.Engine.PutSecurityProjectPolicy(t.Context(), ai.SecurityPolicyAction{ActorID: "local-user", ActionID: "managed-workflow-policy", ProjectID: project}, policy); err != nil {
		t.Fatal(err)
	}
	rows, err := b.Engine.SecurityCatalogResources(t.Context(), project)
	if err != nil {
		t.Fatal(err)
	}
	var revision int64
	for _, row := range rows {
		if row.ID == resource {
			revision = row.ConnectionRevision
		}
	}
	if revision == 0 {
		t.Fatal("actual catalog resource missing")
	}
	acceptance := map[string]ai.WorkStepContract{}
	for i, step := range workflowSecuritySteps(template) {
		acceptance[step.ID] = ai.WorkStepContract{Required: i == 0, Criteria: []security.AcceptanceCriterion{{ID: "actual-read", Target: resource, ConnectionRevision: revision, SourceDigest: security.ObservationSourceDigest("observe_logs", security.ContentDigest([]byte(jsonText(args))), resource, revision), Method: "json_equal", Pointer: "/success", Expected: json.RawMessage(`true`)}}}
	}
	workflowContractHTTP(t, b, http.MethodPut, "/api/projects/"+project+"/security/workflows/"+workflowID, Object{"actionId": "accept-workflow", "expectedRevision": 0, "templateVersion": 1, "acceptance": acceptance}, true, 200)
	run := apiTest(t, h, "POST", "/api/projects/"+project+"/workflows/"+workflowID+"/run", Object{"version": 1}, 202)
	deadline := time.Now().Add(10 * time.Second)
	for {
		current := b.Store.WorkflowRun(project, stringOf(run["id"]))
		if current["status"] != "running" {
			if current["status"] != "completed" {
				view, _ := b.Engine.Snapshot(stringOf(run["sessionId"]))
				t.Fatal("managed workflow failed", current, jsonText(view))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("managed workflow did not finish", current)
		}
		time.Sleep(10 * time.Millisecond)
	}
	view, err := b.Engine.Snapshot(stringOf(run["sessionId"]))
	if err != nil {
		t.Fatal(err)
	}
	if len(view.WorkGoals) != 1 || view.WorkGoals[0].Status != "completed" {
		t.Fatal("workflow report bypassed or lost business closure", view.WorkGoals)
	}
	witnessFound := false
	for _, agent := range view.AgentRuns {
		for _, evidence := range agent.Evidence {
			if !evidence.Success {
				continue
			}
			var sample Object
			if err = json.Unmarshal([]byte(evidence.Excerpt), &sample); err != nil {
				t.Fatal(err)
			}
			if stringOf(sample["sample_hash"]) == security.ContentDigest([]byte("ACTUAL_MANAGED_WORKFLOW_LOG healthy\n")) && stringOf(sample["observed_at"]) != "" && integer(sample["sample_file_size"]) == len("ACTUAL_MANAGED_WORKFLOW_LOG healthy\n") {
				witnessFound = true
			}
		}
	}
	if !witnessFound {
		t.Fatal("actual FD sample witness lost before immutable evidence")
	}
}

func TestSecurityWorkflowContractManagementHostTemplateAndCAS(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	saved := apiTest(t, h, "POST", "/api/projects/"+project+"/workflows", workflowFixtureInput(resource), 201)
	workflowID := stringOf(saved["id"])
	template := b.Store.Workflow(project, workflowID)
	path := "/api/projects/" + project + "/security/workflows/" + workflowID
	workflowContractHTTP(t, b, http.MethodGet, path, nil, false, 401)
	acceptance := map[string]ai.WorkStepContract{}
	for i, step := range workflowSecuritySteps(template) {
		acceptance[step.ID] = ai.WorkStepContract{Required: i == 0, Criteria: []security.AcceptanceCriterion{{ID: "actual-logs", Target: resource, ConnectionRevision: 1, SourceDigest: security.ContentDigest([]byte("user-reviewed-log-query")), Method: "text_nonempty"}}}
	}
	payload := Object{"actionId": "confirm-workflow", "expectedRevision": 0, "templateVersion": 1, "acceptance": acceptance}
	workflowContractHTTP(t, b, http.MethodPut, path, payload, true, 200)
	workflowContractHTTP(t, b, http.MethodPut, path, payload, true, 200)
	got, err := b.Engine.SecurityWorkflowDefinition(t.Context(), project, workflowID, 1, workflowSecurityDigest(template))
	if err != nil || got.Goal != template.Goal || got.Revision != 1 || len(got.Steps) != len(template.Steps)+1 || got.Steps[0].Role != string(ai.SREInvestigator) {
		t.Fatal("contract not bound to actual server template", got, err)
	}
	stale := cloneObject(payload)
	stale["actionId"] = "stale"
	workflowContractHTTP(t, b, http.MethodPut, path, stale, true, 409)
	forged := cloneObject(payload)
	forged["actorId"] = "admin"
	workflowContractHTTP(t, b, http.MethodPut, path, forged, true, 400)
	forged = cloneObject(payload)
	forged["steps"] = []Object{{"role": "executor"}}
	workflowContractHTTP(t, b, http.MethodPut, path, forged, true, 400)
	wrongTarget := map[string]ai.WorkStepContract{}
	for id, contract := range acceptance {
		contract.Criteria = append([]security.AcceptanceCriterion(nil), contract.Criteria...)
		contract.Criteria[0].Target = "other-resource"
		wrongTarget[id] = contract
	}
	bad := cloneObject(payload)
	bad["actionId"], bad["expectedRevision"], bad["acceptance"] = "wrong-resource", 1, wrongTarget
	workflowContractHTTP(t, b, http.MethodPut, path, bad, true, 409)
	input := workflowFixtureInput(resource)
	input["version"], input["goal"] = 1, "Changed actual goal"
	apiTest(t, h, "PUT", "/api/projects/"+project+"/workflows/"+workflowID, input, 200)
	workflowContractHTTP(t, b, http.MethodGet, path, nil, true, 409)
	workflowContractHTTP(t, b, http.MethodPut, path, payload, true, 409)
}
