package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func fixedReadManagedFixture(t *testing.T, as Asset, rule security.Rule) (*Engine, Config) {
	t.Helper()
	e, definition, in := managedWorkflowFixture(t)
	ctx := context.Background()
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	metadata := SecurityCatalogResource{Local: as.Kind == "local", ID: as.ID, ProjectID: "project", Kind: as.Kind, MetadataDigest: hash("fixed-metadata-" + as.ID), ConnectionIdentity: "nonsecret-fixed-" + as.ID}
	digest, _, err := catalogConnectionDigest(metadata, map[string]security.CredentialRevision{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityResourceRevisionRow{}).Where("resource_id = ?", as.ID).Updates(map[string]any{"kind": as.Kind, "local": metadata.Local, "metadata_digest": metadata.MetadataDigest, "connection_digest": digest, "connection_identity": metadata.ConnectionIdentity, "credential_ids": "[]"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.SetSecurityCatalogResolver(func(_ context.Context, q SecurityCatalogQuery) (SecurityCatalogView, error) {
		view := SecurityCatalogView{ExecutionAssets: []Asset{as}}
		if q.All || slices.Contains(q.ResourceIDs, as.ID) {
			view.Resources = []SecurityCatalogResource{metadata}
		}
		return view, nil
	}); err != nil {
		t.Fatal(err)
	}
	_, err = e.PutSecurityProjectPolicy(ctx, SecurityPolicyAction{ActorID: "user", ActionID: "fixed-policy", ProjectID: "project", ExpectedRevision: 2}, security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", ResourceIDs: []string{as.ID}, Rules: []security.Rule{rule}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.BeginSecurityWorkflowRun(ctx, in); err != nil {
		t.Fatal(err)
	}
	if _, err = e.ActivateSecurityWorkflowRun(ctx, in.RunID); err != nil {
		t.Fatal(err)
	}
	plan := SREPlanRevision{ID: "plan", Goal: definition.Goal, Steps: []SREPlanStep{{ID: "inspect", Description: definition.Steps[0].Title, Role: SREInvestigator, ResourceIDs: []string{as.ID}}}}
	task := SRETask{ID: "sre", SessionID: "case", ProjectID: "project", Status: "active", Plans: []SREPlanRevision{plan}}
	e.SetSRERepository(&srePolicyRepository{task: task})
	if err = e.BindSecuritySREPlan(ctx, "case", task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = e.prepareSecuritySRERole(ctx, "case", task, plan.Steps[0], "attempt", false); err != nil {
		t.Fatal(err)
	}
	_ = storeID
	_ = epoch
	return e, Config{Profile: "core", SecurityProjectID: "project", Assets: []Asset{as}}
}

func runFixedReadPermit(t *testing.T, e *Engine, c Config, call Call) (any, error) {
	t.Helper()
	a, err := args(call)
	if err != nil {
		return nil, err
	}
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil {
		return nil, err
	}
	if prepared == nil || decision.Effect != security.EffectAllow {
		t.Fatalf("preparation %+v %v", decision, err)
	}
	if prepared.read == nil {
		t.Fatal("no typed read executor")
	}
	ctx := SecurityOperationContext(t.Context(), prepared)
	s, _ := e.get("case")
	operation, err := e.dispatchNativeOperation(ctx, s, prepared.executionConfig, call, "readonly", "resource", prepared.digest)
	if err != nil {
		return nil, err
	}
	if operation == nil || operation.permit == nil {
		t.Fatal("no original native permit")
	}
	result, readErr := e.executeSecurityReadProbe(securityPermitContext(ctx, operation.permit), prepared.executionConfig, call.Name, prepared.executionArgs)
	if persistErr := e.finishNativeOperation(operation, c, result, readErr); persistErr != nil {
		t.Fatal(persistErr)
	}
	return result, readErr
}

func TestSecurityInspectHostRequiresRegisteredSSHOSAndRejectsRawInputs(t *testing.T) {
	as := Asset{ID: "resource", Kind: "ssh", SSH: &SSH{Host: "127.0.0.1", Port: 1, Username: "fixture"}}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "command.diagnostics", Effect: security.EffectAllow})
	a := map[string]any{"asset_ref": assetAlias(as.ID), "runtime": "ssh"}
	if prepared, _, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "missing-os", Name: "inspect_host"}, a); err == nil || prepared != nil {
		t.Fatal("unconfigured SSH target silently fell back to raw terminal execution")
	}
	if _, err := e.PutSecurityCommandTarget(t.Context(), SecurityCommandTargetAction{SecurityPolicyAction: SecurityPolicyAction{ActorID: "user", ActionID: "linux-target", ProjectID: "project"}, ResourceID: as.ID, OS: "linux", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"command", "terminal_id", "profile_arguments", "environment"} {
		injected := map[string]any{"asset_ref": assetAlias(as.ID), "runtime": "ssh", key: "untrusted"}
		if prepared, _, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "reject-" + key, Name: "inspect_host"}, injected); err == nil || prepared != nil {
			t.Fatal("fixed inspection accepted arbitrary input", key)
		}
	}
}

func TestSecurityFixedRedisProbeOriginalPermitAndNoArbitraryCommands(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	commands := make(chan string, 2)
	go func() {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		defer connection.Close()
		value, err := respRead(bufio.NewReader(connection), 0)
		if err != nil {
			return
		}
		parts, _ := value.([]any)
		if len(parts) > 0 {
			commands <- str(parts[0])
		}
		connection.Write([]byte("+PONG\r\n"))
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	as := Asset{ID: "resource", Kind: "redis", Settings: map[string]any{"host": "127.0.0.1", "port": port, "db": 0}}
	limits := security.ScopeLimits{DatabaseID: "0", Schemas: []string{"redis_diagnostics"}, MaxRows: 64, MaxDurationMS: 5000}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "db.read", Effect: security.EffectAllow, Limits: limits})
	result, err := runFixedReadPermit(t, e, c, Call{ID: "health", Name: "observe_data", Arguments: js(map[string]any{"asset_ref": assetAlias(as.ID), "metric": "health"})})
	if err != nil || obj(result)["result"] != "PONG" {
		t.Fatalf("actual Redis probe %v %v", result, err)
	}
	select {
	case command := <-commands:
		if command != "PING" {
			t.Fatal(command)
		}
	case <-time.After(time.Second):
		t.Fatal("no real Redis I/O")
	}
	op := security.PreparedOperation{Tool: "observe_data", ProjectID: "project", Resources: []security.ResourceRevision{{ID: as.ID}}}
	if _, err = e.prepareSecurityReadProbe(t.Context(), c, &op, map[string]any{"asset_ref": as.ID, "metric": "health", "command": "FLUSHALL"}); err == nil {
		t.Fatal("arbitrary Redis command became structured")
	}
	op.Tool = "redis_command"
	op.Proof = security.ProofOpaque
	if probe, err := e.prepareSecurityReadProbe(t.Context(), c, &op, map[string]any{"command": "PING"}); err != nil || probe != nil || op.Proof != security.ProofOpaque {
		t.Fatal("raw Redis command upgraded")
	}
}

func TestSecurityFixedKubernetesReadNamespaceAndRedirectContainment(t *testing.T) {
	var paths atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths.Add(1)
		if r.Method != "GET" || r.URL.Path != "/api/v1/namespaces/production/pods" || r.URL.Query().Get("limit") != "100" {
			t.Errorf("unbounded request %s %s", r.Method, r.URL)
		}
		json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{"metadata": map[string]any{"name": "pod-one", "namespace": "production", "uid": "uid-one"}, "status": map[string]any{"phase": "Running"}}}})
	}))
	defer server.Close()
	as := Asset{ID: "resource", Kind: "kubernetes", Settings: map[string]any{"endpoint": server.URL, "namespace": "production", "authMethod": "token"}}
	limits := security.ScopeLimits{ClusterID: as.ID, Namespaces: []string{"production"}, ResourceKinds: []string{"pods"}, Verbs: []string{"list"}}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "cluster.read", Effect: security.EffectAllow, Limits: limits})
	result, err := runFixedReadPermit(t, e, c, Call{ID: "pods", Name: "query_kubernetes", Arguments: js(map[string]any{"asset_ref": assetAlias(as.ID), "metric": "pods"})})
	if err != nil || paths.Load() != 1 || !strings.Contains(js(result), "pod-one") {
		t.Fatal(result, err, paths.Load())
	}
	args := map[string]any{"asset_ref": assetAlias(as.ID), "metric": "nodes"}
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "outside", Name: "query_kubernetes", Arguments: js(args)}, args)
	if err == nil && prepared != nil && decision.Effect == security.EffectAllow {
		t.Fatal("namespace ceiling authorized cluster-wide nodes")
	}
	if paths.Load() != 1 {
		t.Fatal("rejected scope reached I/O")
	}
	var foreign atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { foreign.Add(1) }))
	defer other.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/secrets", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	p := &securityReadProbe{asset: Asset{Kind: "kubernetes", Settings: map[string]any{"endpoint": redirect.URL, "namespace": "production"}}, metric: "pods", scope: security.OperationScope{Namespace: "production"}}
	if _, err = executeSecurityKubernetesProbe(t.Context(), Config{}, p, nil, map[string]string{}); err == nil || foreign.Load() != 0 {
		t.Fatalf("foreign redirect used %v %d", err, foreign.Load())
	}
}

func TestSecurityFixedNetworkFetchPinsIPAndStopsForeignRedirect(t *testing.T) {
	var requests, foreign atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { foreign.Add(1) }))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, other.URL, http.StatusFound)
			return
		}
		w.Write([]byte("bounded actual response"))
	}))
	defer server.Close()
	u, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(u.Port())
	as := Asset{ID: "resource", Kind: "redis", Settings: map[string]any{"host": "127.0.0.1"}}
	rule := security.Rule{Capability: "network.fetch", Effect: security.EffectAsk, Grantable: true, Confirmation: security.ConfirmTask, Limits: security.ScopeLimits{NetworkTargets: []security.NetworkLimit{{Scheme: "http", Host: "127.0.0.1", Port: port, AddressCIDRs: []string{"127.0.0.1/32"}}}}}
	e, c := fixedReadManagedFixture(t, as, rule)
	execution, err := e.CurrentSecurityExecution(t.Context(), "case")
	if err != nil {
		t.Fatal(err)
	}
	grant, err := e.IssueSecurityTaskGrant(t.Context(), SecurityTaskGrantAction{Action: SecurityTaskAction{ActorID: "user", ActionID: "network-task-once", ProjectID: "project", SessionID: "case", GoalID: execution.GoalID, TaskID: execution.Task.ID, ExpectedRevision: execution.Task.StateRevision}, Grant: security.TaskGrant{Capabilities: []string{"network.fetch"}, Limits: rule.Limits, RemainingUses: 2, ExpiresAt: time.Now().UTC().Add(10 * time.Minute)}})
	if err != nil || len(grant.Resources) != 0 {
		t.Fatal("resource-less network grant", grant, err)
	}

	result, err := runFixedReadPermit(t, e, c, Call{ID: "fetch", Name: "web_fetch", Arguments: js(map[string]any{"url": server.URL + "/health"})})
	if err != nil || obj(result)["content"] != "bounded actual response" {
		t.Fatal(result, err)
	}
	if _, err = runFixedReadPermit(t, e, c, Call{ID: "redirect", Name: "web_fetch", Arguments: js(map[string]any{"url": server.URL + "/redirect"})}); err == nil || foreign.Load() != 0 {
		t.Fatal("foreign redirect reached network", err, foreign.Load())
	}
	a := map[string]any{"url": other.URL}
	if _, _, err = e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "foreign", Name: "web_fetch", Arguments: js(a)}, a); err == nil {
		t.Fatal("unconfigured host/port accepted")
	}
	exhaustedArgs := map[string]any{"url": server.URL + "/health"}
	prepared, decision, prepareErr := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "exhausted", Name: "web_fetch", Arguments: js(exhaustedArgs)}, exhaustedArgs)
	if prepareErr == nil && prepared != nil && decision.Effect == security.EffectAllow {
		t.Fatal("network task budget was bypassed")
	}
	if requests.Load() != 2 {
		t.Fatal(requests.Load())
	}
}

func TestSecurityFixedSQLProfilesFiniteAndRawQueryNotQualified(t *testing.T) {
	for _, driver := range []string{"postgres", "mysql"} {
		for _, metric := range []string{"health", "connections", "activity"} {
			query, schema, err := securitySQLProbe(driver, metric)
			if err != nil || schema == "" || !strings.HasPrefix(query, "SELECT ") || strings.Contains(query, ";") {
				t.Fatal(query, schema, err)
			}
		}
	}
	for _, metric := range []string{"health;DROP DATABASE x", "SET", "pg_read_file"} {
		if _, _, err := securitySQLProbe("postgres", metric); err == nil {
			t.Fatal(metric)
		}
	}
	if _, ok := SecurityReadVerifierProfile(security.PreparedOperation{Tool: "execute_sql", Proof: security.ProofOpaque, Scope: security.OperationScope{ProbeID: "sql.health", ProbeVersion: 1}}); ok {
		t.Fatal("raw SELECT constant qualified as verifier")
	}
}

func TestSecurityFixedDatabaseRejectsEnvironmentServiceAndBoundsWire(t *testing.T) {
	t.Setenv("PGSERVICE", "synthetic-unrelated-profile")
	as := Asset{Kind: "database", Settings: map[string]any{"driver": "postgres", "host": "127.0.0.1", "database": "fixture", "username": "fixture", "sslmode": "disable"}}
	if db, _, err := databaseOpenWithCredentials(as, true, "", map[string]string{}, true); err == nil {
		db.Close()
		t.Fatal("fixed probe loaded environment service")
	}
	reader, writer := net.Pipe()
	defer reader.Close()
	defer writer.Close()
	done := make(chan struct{})
	go func() { defer close(done); writer.Write([]byte("oversized-wire-response")); writer.Close() }()
	bounded := &securityReadBoundConn{Conn: reader, remaining: 4}
	value, err := io.ReadAll(bounded)
	if err == nil || string(value) != "over" {
		t.Fatalf("wire limit %d %v", len(value), err)
	}
	reader.Close()
	<-done
}

func TestSecurityFixedHostProcessesUsesFrozenProfileAndOtherMetricsStayOpaque(t *testing.T) {
	as := Asset{ID: "resource", Kind: "local"}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "command.diagnostics", Effect: security.EffectAllow})
	c.Runtime = "local"
	policy, err := e.SecurityProjectPolicy(t.Context(), "project")
	if err != nil {
		t.Fatal(err)
	}
	policy.Rules = append(policy.Rules, security.Rule{Capability: "local.execute", Effect: security.EffectAllow})
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "local-probe", ProjectID: "project", ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	result, err := runFixedReadPermit(t, e, c, Call{ID: "processes", Name: "observe_host", Arguments: js(map[string]any{"asset_ref": assetAlias(as.ID), "metric": "processes"})})
	if err != nil || !strings.Contains(str(obj(result)["output"]), "PID") {
		t.Fatal("actual bounded process probe failed", err)
	}
	a := map[string]any{"asset_ref": assetAlias(as.ID), "metric": "overview"}
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, Call{ID: "unsupported", Name: "observe_host", Arguments: js(a)}, a)
	if err == nil && prepared != nil && decision.Effect != security.EffectDeny {
		t.Fatal("composite raw Shell host probe received structured proof", decision)
	}
}
