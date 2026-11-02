package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityStdioActualHomeCatalogManagedFileReadAndHostBinding(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bounded FD adapter deliberately unavailable on Windows")
	}
	b, httpServer := fixture(t)
	session, resource := newSession(t, httpServer)
	project := stringOf(b.Store.Session(session)["projectId"])
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "actual-stdio.txt")
	content := "ACTUAL_STDIO_HOME_BOUNDED_READ\n"
	if err = os.WriteFile(file, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	current, _ := b.Engine.SecurityProjectPolicy(t.Context(), project)
	policy := security.ProjectPolicy{ProjectID: project, SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{resource}, Rules: []security.Rule{{Capability: "file.read", Effect: security.EffectAllow, Limits: security.ScopeLimits{FileRoots: []string{root}}}, {Capability: "local.execute", Effect: security.EffectAllow}, {Capability: "workflow.read", Effect: security.EffectAllow}}}
	if _, err = b.Engine.PutSecurityProjectPolicy(t.Context(), ai.SecurityPolicyAction{ActorID: "user", ActionID: "stdio-read-policy", ProjectID: project, ExpectedRevision: current.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	assets, err := b.Engine.SecurityCatalogResources(t.Context(), project)
	if err != nil {
		t.Fatal(err)
	}
	var revision int64
	for _, row := range assets {
		if row.ID == resource {
			revision = row.ConnectionRevision
		}
	}
	alias := ai.AssetAlias(resource)
	args := Object{"asset_ref": alias, "path": file}
	definition := ai.SecurityWorkflowDefinition{ProjectID: project, WorkflowID: "stdio-confirmed", TemplateVersion: 1, TemplateDigest: security.ContentDigest([]byte("confirmed stdio read plan")), Goal: "Read the actual Home local resource", Steps: []ai.SecurityWorkflowStep{{ID: "inspect", Title: "Inspect actual file", Role: "investigator", ResourceIDs: []string{resource}}}, Acceptance: map[string]ai.WorkStepContract{"inspect": {Required: true, Criteria: []security.AcceptanceCriterion{{ID: "actual-content", Target: resource, ConnectionRevision: revision, SourceDigest: security.ObservationSourceDigest("read", security.ContentDigest([]byte(jsonText(args))), resource, revision), Method: "json_equal", Pointer: "/content", Expected: json.RawMessage(jsonText(content))}}}}}
	if _, err = b.Engine.PutSecurityWorkflowDefinition(t.Context(), ai.SecurityWorkflowDefinitionAction{ActorID: "user", ActionID: "confirm-stdio-plan", ProjectID: project, WorkflowID: definition.WorkflowID}, definition); err != nil {
		t.Fatal(err)
	}
	binding, err := b.Engine.BeginSecurityWorkflowRun(t.Context(), ai.SecurityWorkflowRunInput{RunID: "stdio-approved-run", ProjectID: project, SessionID: session, WorkflowID: definition.WorkflowID, TemplateVersion: 1, TemplateDigest: definition.TemplateDigest, ActorID: "user", ActionID: "start-stdio-plan", SourceKind: "workflow_run", SourceEventID: "stdio-approved-run", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = b.Engine.ActivateSecurityWorkflowRun(t.Context(), binding.RunID); err != nil {
		t.Fatal(err)
	}
	if err = b.Engine.SelectSecurityGoal(t.Context(), ai.SecurityGoalSelection{ActorID: "user", ActionID: "select-confirmed-stdio-goal", ProjectID: project, SessionID: session, GoalID: binding.GoalID, SourceMessageID: "stdio-confirmed-plan-selection", ExpectedGoalRevision: 1}); err != nil {
		t.Fatal(err)
	}
	permissions := ai.DefaultPermissions()
	if err = json.Unmarshal([]byte(jsonText(b.sessionOptions(session))), &permissions); err != nil {
		t.Fatal(err)
	}
	if err = b.Engine.Configure(session, ai.Config{Model: ai.Model{URL: "http://127.0.0.1:1", Name: "prior actual Web configure", Protocol: "openai"}, Profile: "core", Runtime: "local", SecurityProjectID: project, Assets: b.sessionAssets(session), CredentialDir: filepath.Join(b.Models.Home, "secrets"), Permissions: &permissions, MaxSteps: 12}); err != nil {
		t.Fatal(err)
	}
	originalLegacy, err := b.Engine.SecurityLegacySessionPolicy(t.Context(), project, session)
	if err != nil || originalLegacy.Source != "web" {
		t.Fatal("Web fixture did not capture original seven settings", originalLegacy, err)
	}
	home := b.Models.Home
	httpServer.Close()
	b.Close()
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch requests.Add(1) {
		case 1:
			emitModel(w, "", []ai.Call{{ID: "start-existing-step", Name: "work_update", Arguments: `{"item_id":"inspect","status":"running"}`}})
		case 2:
			emitModel(w, "", []ai.Call{{ID: "actual-Home-project-bridge", Name: "list_workflows", Arguments: `{}`}})
		case 3:
			emitModel(w, "", []ai.Call{{ID: "actual-stdio-read", Name: "read", Arguments: jsonText(args)}})
		case 4:
			emitModel(w, "", []ai.Call{{ID: "verify-existing-step", Name: "work_update", Arguments: `{"item_id":"inspect","status":"completed"}`}})
		case 5:
			emitModel(w, "", []ai.Call{{ID: "verify-existing-goal", Name: "work_finish", Arguments: `{"summary":"actual bounded file evidence recorded"}`}})
		default:
			emitModel(w, "actual bounded file evidence recorded", nil)
		}
	}))
	defer provider.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	input, inputWriter := io.Pipe()
	output, outputWriter := io.Pipe()
	frames := make(chan ai.Frame, 512)
	go func() {
		defer close(frames)
		decoder := json.NewDecoder(output)
		for {
			var f ai.Frame
			if decoder.Decode(&f) != nil {
				return
			}
			frames <- f
		}
	}()
	engineReady := make(chan *ai.Engine, 1)
	done := make(chan error, 1)
	go func() {
		done <- ai.ServeHome(ctx, home, input, outputWriter, func(ctx context.Context, h *ai.SecurityHome, e *ai.Engine) (ai.SecurityStdioHost, error) {
			host, err := NewSecurityStdioHost(ctx, h, e)
			if err == nil {
				engineReady <- e
			}
			return host, err
		})
		outputWriter.Close()
	}()
	var engine *ai.Engine
	select {
	case engine = <-engineReady:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("stdio host initialization did not finish")
	}
	t.Cleanup(func() {
		cancel()
		inputWriter.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("stdio did not shut down")
		}
		output.Close()
	})
	send := func(f ai.Frame) ai.Frame {
		t.Helper()
		if err := json.NewEncoder(inputWriter).Encode(f); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case reply, ok := <-frames:
				if !ok {
					t.Fatal("stdio closed before reply")
				}
				if reply.Callback != "" {
					t.Fatal("managed bounded read delegated external callback", reply.Method)
				}
				if reply.ID == f.ID {
					return reply
				}
			case <-time.After(8 * time.Second):
				t.Fatal("stdio request timeout", f.Method)
			}
		}
	}
	data := json.RawMessage(jsonText(Object{"model": Object{"url": provider.URL, "name": "stdio actual fixture", "protocol": "openai"}, "profile": "core", "maxSteps": 12, "runtime": "local", "asset_ref": alias, "credentialDir": "/caller-controlled", "permissions": Object{"silentReadFiles": true, "silentWriteFiles": true, "silentReadSQL": true, "silentCommands": true, "silentTerminalCreation": true, "denyLocalExecution": false, "blockUnreferencedAssets": false}, "assets": []Object{{"id": resource, "kind": "ssh", "ssh": Object{"host": "caller-controlled.invalid", "port": 22, "username": "attacker"}}}}))
	bad := send(ai.Frame{ID: "wrong-project", Method: "configure", Session: session, HostProjectID: "foreign-project", Data: data})
	if bad.Error == "" || requests.Load() != 0 {
		t.Fatal("caller project spoof reached model", bad.Error, requests.Load())
	}
	good := send(ai.Frame{ID: "configure", Method: "configure", Session: session, HostProjectID: project, Data: data})
	if good.Error != "" {
		t.Fatal(good.Error)
	}
	legacy, err := engine.SecurityLegacySessionPolicy(t.Context(), project, session)
	if err != nil || legacy.Source != "web" || legacy.Revision != originalLegacy.Revision || legacy.Permissions != originalLegacy.Permissions {
		t.Fatal("stdio rewrote original Web seven-setting authority or source", legacy, err)
	}
	audit, auditErr := engine.SecurityAudit(t.Context(), project, "", 0, 200)
	if auditErr != nil {
		t.Fatal(auditErr)
	}
	foundEntry := false
	for _, event := range audit.Events {
		if event.Kind == "session.entry" && event.ObjectID == session && event.ActorID == "host:stdio" {
			foundEntry = true
		}
	}
	if !foundEntry {
		t.Fatal("current standalone entry was not audited separately")
	}

	reply := send(ai.Frame{ID: "chat", Method: "chat", Session: session, Data: json.RawMessage(`{"message":"继续确认过的任务，读取实际文件并逐条件验收"}`)})
	if reply.Error != "" {
		t.Fatal(reply.Error)
	}
	history, err := engine.History(session)
	if err != nil {
		t.Fatal(err)
	}
	found, foundActualBridge := false, false
	for _, message := range history {
		if message.Role == "tool" && strings.Contains(message.Content, strings.TrimSpace(content)) {
			found = true
		}
		if message.Role == "tool" && message.CallID == "actual-Home-project-bridge" {
			var actualWorkflows []any
			if json.Unmarshal([]byte(message.Content), &actualWorkflows) == nil && len(actualWorkflows) == 0 {
				foundActualBridge = true
			}
		}
	}
	if !foundActualBridge {
		t.Fatal("managed stdio did not execute actual Home project bridge", jsonText(history))
	}
	if !found || requests.Load() < 2 {
		t.Fatal("stdio never executed actual bounded local read", jsonText(history), requests.Load())
	}
	goals, err := engine.WorkGoals(session)
	if err != nil || len(goals) != 1 || goals[0].Status != "completed" {
		t.Fatal("stdio read did not retain genuine original acceptance", goals, err)
	}
	after, err := engine.SecurityCatalogResources(t.Context(), project)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range after {
		if row.ID == resource && (row.ConnectionRevision != revision || !row.Local) {
			t.Fatal("caller connection metadata replaced actual stable catalog", row)
		}
	}
}
