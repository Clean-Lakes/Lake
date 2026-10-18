package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureRole(body map[string]any) string {
	for _, msg := range arr(body["messages"]) {
		if str(obj(msg)["role"]) == "system" {
			text := str(obj(msg)["content"])
			for role, name := range agentNames {
				if strings.Contains(text, "You are "+name+", an independent") {
					return role
				}
			}
		}
	}
	return "parent"
}
func fixtureMultiEngine(t *testing.T, m Model, silentRead bool) (*Engine, string, string) {
	t.Helper()
	e := engineFor(t, m, nil)
	dir := t.TempDir()
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(real, "service.log")
	if err = os.WriteFile(log, []byte("FIXTURE_RAW_EVIDENCE timeout acquiring connection\n"), 0600); err != nil {
		t.Fatal(err)
	}
	p := DefaultPermissions()
	p.SilentReadFiles = silentRead
	p.BlockUnreferencedAssets = true
	c := Config{legacyInvestigations: true, MultiAgentMode: "auto", Model: m, Profile: "core", Runtime: "local", Assets: []Asset{{ID: "fixture-host", Name: "Fixture host", Kind: "local"}}, Workspace: real, Permissions: &p}
	if err = e.Configure("case", c); err != nil {
		t.Fatal(err)
	}
	return e, log, assetAlias("fixture-host")
}
func multiReferences() []map[string]any {
	return []map[string]any{{"asset_ref": "fixture-host", "name": "Fixture host"}}
}
func TestIndependentAgentsParallelAndVerified(t *testing.T) {
	var rootCalls atomic.Int32
	var started atomic.Int32
	gate := make(chan struct{})
	var closeGate sync.Once
	var mu sync.Mutex
	childCalls := map[string]int{}
	var logPath, alias string
	m, closeModel := fakeModel(t, func(_ int, b map[string]any) any {
		role := fixtureRole(b)
		serialized := js(b["messages"])
		if role == "parent" {
			switch rootCalls.Add(1) {
			case 1:
				return response("", Call{"delegate", "delegate_investigation", js(map[string]any{"tasks": []investigationSpec{{Role: "application", Task: "ONLY_CHILD_A", AssetRefs: []string{alias}}, {Role: "application", Task: "ONLY_CHILD_B", AssetRefs: []string{alias}}}})})
			case 2:
				return response("", Call{"verify", "delegate_investigation", js(map[string]any{"tasks": []investigationSpec{{Role: "verify", Task: "Review actual evidence"}}})})
			default:
				return response("VERIFIED_FINAL_RESULT")
			}
		}
		if strings.Contains(serialized, "UNVERIFIED_ROOT_CANDIDATE") {
			t.Error("candidate conclusion leaked into independent child history")
		}
		key := role
		if role == "application" {
			if strings.Contains(serialized, "ONLY_CHILD_A") {
				key = "a"
				if strings.Contains(serialized, "ONLY_CHILD_B") {
					t.Error("child A inherited sibling task")
				}
			} else {
				key = "b"
			}
		}
		mu.Lock()
		childCalls[key]++
		n := childCalls[key]
		mu.Unlock()
		if role == "application" && n == 1 {
			if started.Add(1) == 2 {
				closeGate.Do(func() { close(gate) })
			}
			select {
			case <-gate:
			case <-time.After(2 * time.Second):
				t.Error("investigations were not parallel")
			}
			return response("", Call{"observe", "observe_logs", js(map[string]any{"asset_ref": alias, "path": logPath})})
		}
		if role == "verify" && n == 1 {
			return response("", Call{"raw", "read_evidence", `{}`})
		}
		if !strings.Contains(serialized, "FIXTURE_RAW_EVIDENCE") {
			t.Error("child result had no raw observations")
		}
		refs := evidenceReference.FindAllString(serialized, -1)
		return response("Evidence-backed result with explicit remaining uncertainty: " + strings.Join(refs, ", "))
	})
	defer closeModel()
	e, path, ref := fixtureMultiEngine(t, m, true)
	logPath, alias = path, ref
	if err := e.Chat(context.Background(), "case", "Investigate the fixture independently", multiReferences()); err != nil {
		t.Fatal(err)
	}
	v, err := e.Snapshot("case")
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != "completed" || len(v.AgentRuns) != 3 || rootCalls.Load() != 3 {
		t.Fatalf("wrong completion gate: status=%s agents=%d root calls=%d", v.Status, len(v.AgentRuns), rootCalls.Load())
	}
	for _, run := range v.AgentRuns {
		if run.Status != "completed" || run.RootTurnID != v.RootTurnID || run.CanCancel || run.FinishedAt == "" || len(run.EvidenceIDs) == 0 {
			t.Fatalf("incomplete child journal: %+v", run)
		}
		view, err := e.AgentDetails("case", run.ID)
		if err != nil || view.Session != run.ID {
			t.Fatal("missing isolated history", err)
		}
		st, err := os.Stat(filepath.Join(e.Dir, "children", "case", run.ID+".json"))
		if err != nil || st.Mode().Perm() != 0600 {
			t.Fatal("child state is not private", err)
		}
	}
	if v.DelegatedUsage.Total <= 0 || v.Usage.Total <= v.DelegatedUsage.Total {
		t.Fatal("child model usage was not accounted")
	}
	for _, card := range v.Cards {
		if card.Content == "UNVERIFIED_ROOT_CANDIDATE" && card.Type != "draft" {
			t.Fatal("unverified candidate became a final visible response")
		}
	}
	history, _ := e.History("case")
	if err := validHistory(history); err != nil {
		t.Fatal(err)
	}
}

func TestChildCancellationAndApprovalOwnership(t *testing.T) {
	var rootCalls atomic.Int32
	var mu sync.Mutex
	calls := map[string]int{}
	var path, ref string
	m, closeModel := fakeModel(t, func(_ int, b map[string]any) any {
		role := fixtureRole(b)
		if role == "parent" {
			if rootCalls.Add(1) == 1 {
				return response("", Call{"delegate", "delegate_investigation", js(map[string]any{"tasks": []investigationSpec{{Role: "application", Task: "FIRST_TASK", AssetRefs: []string{ref}}, {Role: "application", Task: "SECOND_TASK", AssetRefs: []string{ref}}}})})
			}
			return response("partial result")
		}
		key := role
		if strings.Contains(js(b["messages"]), "FIRST_TASK") {
			key = "first"
		} else if role == "application" {
			key = "second"
		}
		mu.Lock()
		calls[key]++
		n := calls[key]
		mu.Unlock()
		if n == 1 {
			if role == "verify" {
				return response("", Call{"raw", "read_evidence", `{}`})
			}
			return response("", Call{"observe", "observe_logs", js(map[string]any{"asset_ref": ref, "path": path})})
		}
		return response("fixture analysis: " + strings.Join(evidenceReference.FindAllString(js(b["messages"]), -1), ", "))
	})
	defer closeModel()
	e, log, alias := fixtureMultiEngine(t, m, false)
	path, ref = log, alias
	finished := make(chan error, 1)
	go func() { finished <- e.Chat(context.Background(), "case", "Investigate fixture", multiReferences()) }()
	var runs []AgentRun
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		v, _ := e.Snapshot("case")
		runs = nil
		for _, r := range v.AgentRuns {
			if r.Pending != nil {
				runs = append(runs, r)
			}
		}
		if len(runs) == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if len(runs) != 2 {
		_ = e.Abort("case")
		t.Fatal("child approvals were not surfaced")
	}
	if err := e.CancelAgent("other-session", runs[0].ID); err == nil {
		t.Fatal("cross-session cancellation was allowed")
	}
	if err := e.AgentDecision("other-session", runs[1].ID, runs[1].Pending.ID, true, ""); err == nil {
		t.Fatal("cross-session approval was allowed")
	}
	if _, err := e.AgentDetails("other-session", runs[0].ID); err == nil {
		t.Fatal("cross-session child history was exposed")
	}
	if err := e.CancelAgent("case", runs[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := e.AgentDecision("case", runs[1].ID, runs[1].Pending.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(4 * time.Second):
		_ = e.Abort("case")
		t.Fatal("individual cancellation stalled the parent")
	}
	v, _ := e.Snapshot("case")
	status := map[string]string{}
	for _, r := range v.AgentRuns {
		status[r.ID] = r.Status
	}
	if status[runs[0].ID] != "cancelled" || status[runs[1].ID] != "completed" {
		t.Fatal("cancelling one child affected its sibling", status)
	}
}

func TestAgentToolScopesAndRestartNoReplay(t *testing.T) {
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { return response("fixture") })
	defer closeModel()
	e, _, ref := fixtureMultiEngine(t, m, true)
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.View.RootTurnID = "test-turn"
	s.state.RootQuestion = "fixture"
	c := s.state.Config
	c.ReferencedAssets = []string{"fixture-host"}
	s.mu.Unlock()
	for _, specs := range [][]investigationSpec{{{Role: "host", Task: "escape", AssetRefs: []string{"unassigned"}}}, {{Role: "network", Task: "unimplemented", AssetRefs: []string{ref}}}, {{Role: "application", Task: "missing scope"}}} {
		if _, err := e.runInvestigations(context.Background(), s, c, specs); err == nil {
			t.Fatal("invalid delegation was accepted")
		}
	}
	child, _ := New(t.TempDir(), nil, nil)
	defer child.Shutdown()
	w := &agentWorker{parent: e, session: s, parentID: "case", runID: "child", role: "application", assets: []string{"fixture-host"}, reads: map[string]int{}}
	child.worker = w
	if err := child.Configure("child", c); err != nil {
		t.Fatal(err)
	}
	cs, _ := child.get("child")
	for _, call := range []Call{{"write", "write", `{"path":"/tmp/escape","content":"no"}`}, {"shell", "shell", `{"command":"touch /tmp/escape"}`}, {"delegate", "delegate_investigation", `{"tasks":[]}`}, {"sql", "observe_logs", js(map[string]any{"asset_ref": ref, "path": "/tmp/no.log", "sql": "DROP TABLE t"})}, {"scope", "observe_logs", `{"asset_ref":"other","path":"/tmp/no.log"}`}} {
		if _, err := child.invoke(context.Background(), cs, c, call); err == nil {
			t.Fatal("child escaped tool scope", call.Name)
		}
	}
	s.mu.Lock()
	s.state.View.Status = "running"
	s.state.View.AgentRuns = []AgentRun{{ID: "orphan", SessionID: "case", RootTurnID: "test-turn", Role: "host", Status: "running", CanCancel: true}}
	if err := e.save(s); err != nil {
		t.Fatal(err)
	}
	s.mu.Unlock()
	restarted, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Shutdown()
	v, err := restarted.Snapshot("case")
	if err != nil || v.Status != "interrupted" || v.AgentRuns[0].Status != "interrupted" || v.AgentRuns[0].CanCancel {
		t.Fatal("restart replayed or retained an active child", err)
	}
	stored, err := os.ReadFile(filepath.Join(e.Dir, "case.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state State
	if json.Unmarshal(stored, &state) != nil || state.View.AgentRuns[0].Status != "interrupted" {
		t.Fatal("recovery state was not persisted")
	}
}

func TestStopTurnCancelsAllChildrenAndReturnsSlots(t *testing.T) {
	var path, ref string
	var rootCalls atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, b map[string]any) any {
		if fixtureRole(b) == "parent" {
			rootCalls.Add(1)
			return response("", Call{"delegate", "delegate_investigation", js(map[string]any{"tasks": []investigationSpec{{Role: "application", Task: "One", AssetRefs: []string{ref}}, {Role: "application", Task: "Two", AssetRefs: []string{ref}}}})})
		}
		return response("", Call{"observe", "observe_logs", js(map[string]any{"asset_ref": ref, "path": path})})
	})
	defer closeModel()
	e, log, alias := fixtureMultiEngine(t, m, false)
	path, ref = log, alias
	finished := make(chan error, 1)
	go func() { finished <- e.Chat(context.Background(), "case", "Investigate fixture", multiReferences()) }()
	deadline := time.Now().Add(3 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		v, _ := e.Snapshot("case")
		pending := 0
		for _, r := range v.AgentRuns {
			if r.Pending != nil {
				pending++
			}
		}
		if pending == 2 {
			ready = true
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !ready {
		_ = e.Abort("case")
		t.Fatal("children never reached their approval gates")
	}
	if err := e.Abort("case"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("stopped turn completed normally")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("stop did not finish the child tasks")
	}
	v, _ := e.Snapshot("case")
	if v.Status != "cancelled" || len(v.AgentRuns) != 2 || rootCalls.Load() != 1 {
		t.Fatal("stopped turn continued model work")
	}
	for _, r := range v.AgentRuns {
		if r.Status != "cancelled" || r.Pending != nil || r.CanCancel {
			t.Fatalf("active child survived stop: status=%s pending=%v canCancel=%v summary=%s", r.Status, r.Pending != nil, r.CanCancel, r.Summary)
		}
	}
	if len(e.agentSlots) != 0 || len(e.modelSlots) != 0 || len(e.childModelSlots) != 0 {
		t.Fatal("cancellation leaked a concurrency slot")
	}
}

func TestObservationTemplatesAndEvidenceReferences(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "metrics.db")
	// Creating the test fixture uses SQLite directly, not an agent tool.
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("CREATE TABLE fixture (id INTEGER)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	value, err := observeDatabase(context.Background(), Config{}, Asset{Kind: "database", Settings: map[string]any{"driver": "sqlite", "path": path}}, "activity")
	if err != nil || !strings.Contains(js(value), "objects") {
		t.Fatal("fixed SQLite observation failed", err)
	}
	id := "ev_0123456789abcdef0123456789abcdef"
	if err = validateAgentReferences("supported by "+id, []string{id}); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"uncited conclusion", "ev_ffffffffffffffffffffffffffffffff"} {
		if err = validateAgentReferences(text, []string{id}); err == nil {
			t.Fatal("unregistered evidence was accepted")
		}
	}
	for _, role := range []string{"host", "application", "data", "verify"} {
		for _, tool := range observationTools(role) {
			if strings.Contains(" shell execute_sql redis_command write delegate_investigation ", " "+tool.Name+" ") {
				t.Fatal("dangerous child tool advertised", role, tool.Name)
			}
		}
	}
}
