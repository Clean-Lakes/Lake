package ai

import (
	"context"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func configureContextRouter(t *testing.T, e *Engine, b SuperSourceBinding) {
	t.Helper()
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { return response("unused") })
	t.Cleanup(closeModel)
	if err := e.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core", superRole: "router", superRouter: &superRouterRun{projectID: b.ProjectID, readCursors: map[string]int{}, readComplete: map[string]bool{}}}); err != nil {
		t.Fatal(err)
	}
}
func TestTaskDigestExactReferencesAndChangedHash(t *testing.T) {
	e, b := superFixture(t)
	task := superCreateFixture(t, e, b, "source", "只读检查，绝不重启。", "task", "只读检查")
	configureContextRouter(t, e, b)
	digest, err := e.BuildTaskDigest(t.Context(), "pilot", task.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if len(js(digest)) > TaskDigestBytes || digest.TaskID != task.TaskID || digest.RoleID != task.RoleID || digest.AcceptanceState == "pass" {
		t.Fatal(digest)
	}
	ref := digest.Refs[0]
	page, err := e.ReadSuperObjectChecked(t.Context(), "pilot", ref.Kind, ref.ID, ref.Revision, 0, 16384, ref.Hash)
	if err != nil || !strings.Contains(page.Text, "绝不重启") {
		t.Fatal(page, err)
	}
	if _, err = e.ReadSuperObjectChecked(t.Context(), "pilot", ref.Kind, ref.ID, ref.Revision, 0, 100, strings.Repeat("0", 64)); err == nil {
		t.Fatal("wrong hash accepted")
	}
	if _, err = e.BuildTaskDigest(t.Context(), "pilot", "foreign-task"); err == nil {
		t.Fatal("foreign task admitted")
	}
	if _, err = DecodeTaskDigestV1(js(digest)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{strings.Replace(js(digest), `"version":1`, `"version":2`, 1), strings.TrimSuffix(js(digest), "}") + `,"unknown":true}`, js(digest) + ` {}`} {
		if _, err = DecodeTaskDigestV1(raw); err == nil {
			t.Fatal("bad contract accepted")
		}
	}
	// A failed hash check must not advance the original-event read cursor.
	db, _ := e.superStore()
	var event superEventRow
	if err = db.Where("source_event_id = ?", "source").First(&event).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = e.ReadSuperObjectChecked(t.Context(), "pilot", "event", event.ID, 1, 0, 16384, strings.Repeat("0", 64)); err == nil {
		t.Fatal("wrong event hash accepted")
	}
	c, _ := e.ConfigForSession("pilot")
	if c.superRouter.readComplete[event.ID] {
		t.Fatal("failed read marked original event complete")
	}
}
func TestPilotWorkingSetPreservesUnknownCurrentInputsAndToolPairs(t *testing.T) {
	e, b := superFixture(t)
	configureContextRouter(t, e, b)
	event, _, err := e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "old", Kind: "message", Payload: "old readonly instruction"})
	if err != nil {
		t.Fatal(err)
	}
	old := routerHistoryMessage(event, "")
	h := []Message{{Role: "system", Content: "policy"}, old, {Role: "assistant", Calls: []Call{{ID: "old-read", Name: "read_super_object", Arguments: `{}`}}}, {Role: "tool", CallID: "old-read", Name: "read_super_object", Content: strings.Repeat("ARCHIVED", 2000)}, {Role: "user", HostTurnID: "current", SourceMessageID: "new", Content: "CURRENT USER: 不得重启"}, {Role: "assistant", Calls: []Call{{ID: "new-read", Name: "read_super_object", Arguments: `{}`}}}, {Role: "tool", CallID: "new-read", Name: "read_super_object", Content: "current exact evidence"}}
	before := js(h)
	c, _ := e.ConfigForSession("pilot")
	pending, err := e.BuildPilotWorkingSet(t.Context(), "pilot", c, h, "current")
	if err != nil || !reflect.DeepEqual(pending, h) {
		t.Fatal("unconsumed event was omitted", err)
	}
	if err = e.finishSuperRouting(t.Context(), b, event.ID); err != nil {
		t.Fatal(err)
	}
	out, err := e.BuildPilotWorkingSet(t.Context(), "pilot", c, h, "current")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(js(out), "ARCHIVED") || !strings.Contains(js(out), "不得重启") || !strings.Contains(js(out), "current exact evidence") || validHistory(out) != nil || js(h) != before {
		t.Fatal("invalid or destructive projection", err)
	}
	if !strings.Contains(js(out), event.ID) {
		t.Fatal("original event reference lost")
	}
	for _, turn := range []string{"", "missing-current"} {
		unchanged, err := e.BuildPilotWorkingSet(t.Context(), "pilot", c, h, turn)
		if err != nil || !reflect.DeepEqual(unchanged, h) {
			t.Fatal("history omitted without current host anchor", err)
		}
	}
	unknown := append([]Message(nil), h[:4]...)
	unknown = append(unknown, Message{Role: "user", Content: "extra human constraint"})
	unknown = append(unknown, h[4:]...)
	unchanged, err := e.BuildPilotWorkingSet(t.Context(), "pilot", c, unknown, "current")
	if err != nil || !reflect.DeepEqual(unchanged, unknown) {
		t.Fatal("unanchored human constraint omitted", err)
	}
	fake := append([]Message(nil), h...)
	fake[1].SourceMessageID = "unregistered"
	unchanged, err = e.BuildPilotWorkingSet(t.Context(), "pilot", c, fake, "current")
	if err != nil || !reflect.DeepEqual(unchanged, fake) {
		t.Fatal("unverified history omitted", err)
	}
	ordinary, err := e.BuildPilotWorkingSet(t.Context(), "pilot", Config{}, h, "current")
	if err != nil || !reflect.DeepEqual(ordinary, h) {
		t.Fatal("ordinary history projected", err)
	}
}
func TestPilotActualProviderRequestStaysBoundedWithHundredArchivedTasks(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	var calls atomic.Int32
	var exactTask string
	m, closeModel := fakeModel(t, func(_ int, input map[string]any) any {
		calls.Add(1)
		body := js(input["messages"])
		if strings.Contains(body, "ARCHIVED_LARGE_OUTPUT") || strings.Contains(body, "handoff summary") {
			t.Error("archive or unnecessary compaction reached provider")
		}
		if !strings.Contains(body, "CURRENT: 查询GOS，不得重启") {
			t.Error("current requirement lost")
		}
		if len(body) > 80*1024 {
			t.Error("actual provider request grew with archive", len(body))
		}
		t.Logf("actual provider messages: %d bytes", len(body))
		if calls.Load() == 1 {
			return response("", Call{ID: "current-read", Name: "read_super_object", Arguments: js(map[string]any{"kind": "task", "id": exactTask, "offset": 0, "limit": 16384})})
		}
		if !strings.Contains(body, "originalRequirements") {
			t.Error("current exact tool result was omitted")
		}
		return response("已收到当前查询要求。")
	})
	defer closeModel()
	m.ContextWindow = 128000
	if err := e.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core"}); err != nil {
		t.Fatal(err)
	}
	history := []Message{{Role: "system", Content: "read only policy"}}
	large := strings.Repeat("ARCHIVED_LARGE_OUTPUT ", 12800)[:256*1024]
	workerSessions := []string{}
	for i := 0; i < 100; i++ {
		id := uid()
		task := superCreateFixture(t, e, b, id, "old readonly task "+id, id, "old readonly task")
		exactTask = task.TaskID
		workerSessions = append(workerSessions, task.SessionID)
		// Each task owns a 256 KiB archive. Pilot also contains a historical
		// detail page, within the existing 24 MiB single-session artifact cap.
		worker, err := e.get(task.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		worker.mu.Lock()
		worker.state.History = []Message{{Role: "user", Content: "original task"}, {Role: "assistant", Content: large}}
		err = e.saveNativeMutationLocked(worker)
		worker.mu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		db, _ := e.superStore()
		var event superEventRow
		if err := db.Where("source_event_id = ?", id).First(&event).Error; err != nil {
			t.Fatal(err)
		}
		if err := e.finishSuperRouting(ctx, b, event.ID); err != nil {
			t.Fatal(err)
		}
		if err := e.CancelWorkGoals(ctx, task.SessionID); err != nil {
			t.Fatal(err)
		}
		history = append(history, routerHistoryMessage(event.event(), ""), Message{Role: "assistant", Calls: []Call{{ID: task.TaskID, Name: "read_super_object", Arguments: `{}`}}}, Message{Role: "tool", CallID: task.TaskID, Name: "read_super_object", Content: large[:128*1024]})
	}
	s, _ := e.get("pilot")
	s.mu.Lock()
	s.state.History = history
	old := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	s.state.View.StartedAt, s.state.View.TurnStartedAt, s.state.View.TurnFinishedAt = old, old, old
	if !shouldCompactResumedConversation(s.state, time.Now()) {
		s.mu.Unlock()
		t.Fatal("fixture did not exercise the idle-session gate")
	}
	if err := e.saveNativeMutationLocked(s); err != nil {
		s.mu.Unlock()
		t.Fatal(err)
	}
	s.mu.Unlock()
	e.Shutdown()
	restored, err := New(e.Dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restored.Shutdown)
	e = restored
	if err = e.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "current", ThreadRef: "pilot", Kind: "message", Payload: "CURRENT: 查询GOS，不得重启"}); err != nil {
		t.Fatal(err)
	}
	e.compactionTimeout = 1 // Any accidental summarization must fail, not hang.
	// This fixture deliberately retains 100 large archives through restart and
	// real SDK/model/persistence calls. Race instrumentation on hosted runners
	// can exceed the normal 90-second production budget; latency is not this
	// test's contract. Preserve every archive, task and provider-size assertion.
	if err := e.runPilotRouter(ctx, "pilot", b, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("extra provider calls", calls.Load())
	}
	saved, err := e.History("pilot")
	if err != nil || !strings.Contains(js(saved), "ARCHIVED_LARGE_OUTPUT") {
		t.Fatal("original archive removed", err)
	}
	for _, id := range workerSessions {
		archive, err := e.History(id)
		if err != nil || len(archive) != 2 || archive[1].Content != large {
			t.Fatal("independent task archive changed after restart", id, err)
		}
	}
	view, err := e.Snapshot("pilot")
	if err != nil || view.Context == nil || view.Context.EstimatedUsed > 40000 {
		t.Fatal("context usage counted retained archive as provider input", view.Context, err)
	}
}
func TestContextBudgetViewIsExplicitEstimate(t *testing.T) {
	m := Model{ContextWindow: 2048, MaxOutput: 512}
	h := []Message{{Role: "user", Content: strings.Repeat("中文", 1000)}}
	v := BuildContextBudgetView(m, h, nil)
	if !v.OverBudget || v.EstimateMethod == "" || v.SerializedBytes != historyCost(h)+len(js([]Tool(nil))) || v.EstimatedInputTokens != (v.SerializedBytes+1)/2 {
		t.Fatal(v)
	}
}
