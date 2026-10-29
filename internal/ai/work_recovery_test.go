package ai

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkRecoveryKeepsNewTopicAndUsesCurrentConfig(t *testing.T) {
	var calls atomic.Int32
	model, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		n := calls.Add(1)
		if strings.Contains(js(body["messages"]), "independent-new-topic") && !strings.Contains(js(body["messages"]), "host_external_observation") {
			return response("new topic answer")
		}
		switch n {
		case 1:
			return response("", Call{ID: "original-job", Name: "shell", Arguments: `{"command":"printf fixture-result","run_in_background":true}`})
		case 2:
			return response("已提交，等待核对结果。")
		}
		return response("", Call{ID: "recovered-finish", Name: "work_finish", Arguments: `{"summary":"原任务的完成记录已核对。"}`})
	})
	defer closeModel()
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	p := DefaultPermissions()
	p.SilentCommands = true
	s.state.Config.Permissions = &p
	s.mu.Unlock()
	if err := e.Chat(context.Background(), "case", "持续核查原任务结果", nil); err != nil {
		t.Fatal(err)
	}
	goals, _ := e.WorkGoals("case")
	if len(goals) != 1 {
		t.Fatal("no original goal")
	}
	row, g, _ := e.workRow("case", goals[0].ID)
	store, _ := e.adkStore()
	if err := store.DB.Model(&nativeOperation{}).Where("id = ?", g.Items[0].Watch.OperationID).Update("handle", "original-terminal:original-entry").Error; err != nil {
		t.Fatal(err)
	}
	g.Items[0].Watch.NextCheckAt = time.Now().Add(-time.Second)
	if err := e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	dir := e.Dir
	e.Shutdown()
	var observations atomic.Int32
	reopened, err := New(dir, func(_ context.Context, session, name string, a map[string]any, approved bool) (any, error) {
		if name != "terminal_command_status" || session != "case" || a["terminal_id"] != "original-terminal" || a["entry_id"] != "original-entry" || approved {
			t.Fatal("recovery dispatched or changed original identity")
		}
		observations.Add(1)
		return map[string]any{"exitCode": 0, "status": "completed", "output": "recorded original completion"}, nil
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Shutdown()
	model.Key = "fixture-current-secret"
	if err = reopened.Configure("case", Config{Model: model, Profile: "core", Runtime: "local", Permissions: &p}); err != nil {
		t.Fatal(err)
	}
	if err = reopened.Chat(context.Background(), "case", "independent-new-topic", nil); err != nil {
		t.Fatal(err)
	}
	before, _ := reopened.Snapshot("case")
	if err = reopened.workTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	after, _ := reopened.Snapshot("case")
	goals, _ = reopened.WorkGoals("case")
	if goals[0].Status != "completed" || calls.Load() != 4 || observations.Load() < 1 {
		t.Fatal("recovery did not consume original completion once", goals[0].Status, calls.Load(), observations.Load())
	}
	if after.RootTurnID != before.RootTurnID || after.TurnStartedAt != before.TurnStartedAt || after.Status != before.Status {
		t.Fatal("old goal overwrote new topic identity")
	}
	reports := 0
	for _, card := range after.Cards {
		if card.ID == "work-report-"+g.ID {
			reports++
		}
	}
	if reports != 1 {
		t.Fatal("missing named background report", reports)
	}
	if err = reopened.flushWorkOutbox(context.Background()); err != nil {
		t.Fatal(err)
	}
	final, _ := reopened.Snapshot("case")
	if len(final.Cards) != len(after.Cards) {
		t.Fatal("outbox replay duplicated report")
	}
	stored, _, _ := reopened.workRow("case", g.ID)
	if strings.Contains(stored.Checkpoint, model.Key) || strings.Contains(stored.Data, model.Key) {
		t.Fatal("credential persisted in task checkpoint")
	}
}

func TestWorkGoalRejectsExpiredLeaseAndRepeatedCompletedChange(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	s, _ := e.get("case")
	s.state.View.RootTurnID = "work-turn"
	g, err := e.beginWork(s, "single change", []WorkItem{{ID: "change", Title: "specified change"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.invokeWorkTool(context.Background(), s, s.state.Config, Call{Name: "work_update"}, map[string]any{"item_id": g.Items[0].ID, "status": "running"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), adkToolContextKey{}, struct{}{})
	first := Call{ID: "first", Name: "fixture-write", Arguments: `{"target":"original"}`}
	operation, err := e.dispatchNativeOperation(ctx, s, s.state.Config, first, "write", "target", "generation")
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, s.state.Config, map[string]any{"exitCode": 0}, nil); err != nil {
		t.Fatal(err)
	}
	first.ID = "model-generated-new-id"
	if _, err = e.dispatchNativeOperation(ctx, s, s.state.Config, first, "write", "target", "generation"); err == nil {
		t.Fatal("regenerated ID replayed an already successful goal change")
	}
	row, g, _ := e.workRow("case", g.ID)
	store, _ := e.adkStore()
	if err = store.DB.Model(&nativeWorkGoal{}).Where("id = ?", row.ID).Updates(map[string]any{"lease_owner": "old-worker", "lease_until": time.Now().Add(-time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	row.fence = "old-worker"
	g.Status = "completed"
	if err = e.writeWorkGoal(&row, &g, false); err == nil {
		t.Fatal("expired observer published success")
	}
	_, unchanged, _ := e.workRow("case", g.ID)
	if unchanged.Status == "completed" {
		t.Fatal("expired worker changed durable state")
	}
}

func TestAutomaticSummaryDeadlineUsesLiveParentAndKeepsGoal(t *testing.T) {
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { time.Sleep(40 * time.Millisecond); return response("late summary") })
	defer closeModel()
	model.ContextWindow = 72000
	model.MaxOutput = 8192
	e := engineFor(t, model, nil)
	e.compactionTimeout = 5 * time.Millisecond
	s, _ := e.get("case")
	s.state.View.RootTurnID = "long-work"
	g, err := e.beginWork(s, "保留原目标与用户约束", nil)
	if err != nil {
		t.Fatal(err)
	}
	history := []Message{{Role: "system", Content: "policy"}, {Role: "user", Content: strings.Repeat("immutable scope ", 1800)}}
	for i := 0; i < 19; i++ {
		id := uid()
		history = append(history, Message{Role: "assistant", Calls: []Call{{ID: id, Name: "shell", Arguments: `{"command":"already executed"}`}}}, Message{Role: "tool", CallID: id, Name: "shell", Content: js(map[string]any{"exitCode": 0, "output": strings.Repeat("observed ", 400)})})
	}
	s.state.History = history
	s.state.LastRequest = &Usage{InputKnown: true, Input: model.ContextWindow - model.MaxOutput}
	s.state.ContextMeasurement = &ContextMeasurement{ModelID: ModelIdentity(model), HistoryCost: historyCost(history), ToolsCost: len(js(e.sessionCatalog(context.Background(), "case", s.state.Config)))}
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err = e.compact(parent, s, s.state.Config, false); err != nil {
		t.Fatal("summary child timeout aborted parent work", err)
	}
	if parent.Err() != nil || s.state.WorkGoalID != g.ID || validHistory(s.state.History) != nil {
		t.Fatal("deadline lost work identity or tool pairing")
	}
	if !strings.Contains(js(s.state.View.Cards), "工具输出预览") {
		t.Fatal("fixture did not exercise deterministic fallback")
	}
	if raw, marshalErr := json.Marshal(s.state.History[:2]); marshalErr != nil || string(raw) != js(history[:2]) {
		t.Fatal("immutable user scope changed")
	}
}

func TestWorkGoalSurvivesThreeCompactionsWithOriginalUserAndCalls(t *testing.T) {
	summaries := 0
	model, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		if body["tools"] != nil {
			t.Error("summary could execute tools")
		}
		summaries++
		return response("原目标和用户约束保持；已完成的操作不能重发。")
	})
	defer closeModel()
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	s.state.View.RootTurnID = "three-compactions"
	s.state.RootQuestion = "完成原目标，数据库由用户处理"
	goal, err := e.beginWork(s, "连续任务", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.state.History = longFirstTurn()
	originalQuestion := s.state.History[1]
	for round := 0; round < 3; round++ {
		if round > 0 {
			more := longFirstTurn()
			for i := 2; i < len(more); i++ {
				for j := range more[i].Calls {
					more[i].Calls[j].ID += string(rune('a' + round))
				}
				if more[i].CallID != "" {
					more[i].CallID += string(rune('a' + round))
				}
			}
			s.state.History = append(s.state.History, more[2:]...)
		}
		if err = e.compact(context.Background(), s, s.state.Config, true); err != nil {
			t.Fatal(err)
		}
		if validHistory(s.state.History) != nil || s.state.WorkGoalID != goal.ID || js(s.state.History[2]) != js(originalQuestion) {
			t.Fatal("compaction lost original request or tool pairing")
		}
		if err = e.workCheckpoint(s); err != nil {
			t.Fatal(err)
		}
		_, saved, loadErr := e.workRow("case", goal.ID)
		if loadErr != nil || saved.UserText != "完成原目标，数据库由用户处理" {
			t.Fatal("summary rewrote authoritative work scope", loadErr)
		}
	}
	if summaries != 3 {
		t.Fatal("fixture did not compact three times", summaries)
	}
}

func TestWorkIndependentJobsReportWhileUserDependencyRemains(t *testing.T) {
	var modelCalls, reads atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		switch modelCalls.Add(1) {
		case 1:
			return response("", Call{ID: "fixture-checkpoint", Name: "shell", Arguments: `{"command":"printf fixture","run_in_background":true}`})
		case 2:
			return response("等待实际结果")
		default:
			return response("六个独立任务已核对完成；数据库仍由用户处理，依赖部署未执行。")
		}
	})
	defer closeModel()
	e := engineFor(t, m, func(_ context.Context, _ string, name string, args map[string]any, approved bool) (any, error) {
		if name == "policy" {
			return map[string]any{}, nil
		}
		if name == "runtimeCommandExec" {
			return map[string]any{"terminal_id": "fixture-terminal", "entry_id": "fixture-entry", "status": "running"}, nil
		}
		if name == "terminal_wait_command" || name == "terminal_command_status" {
			return map[string]any{"exitCode": 0, "stdout": "fixture"}, nil
		}
		if name != "work_release_observe" || approved {
			t.Fatal("unexpected dispatch", name)
		}
		reads.Add(1)
		return map[string]any{"structuredContent": map[string]any{"id": args["order_id"], "status": "success"}}, nil
	})
	s, _ := e.get("case")
	s.mu.Lock()
	p := DefaultPermissions()
	p.SilentCommands = true
	s.state.Config.Permissions = &p
	s.mu.Unlock()
	if err := e.Chat(context.Background(), "case", "跟进独立任务，数据库由我处理", nil); err != nil {
		t.Fatal(err)
	}
	goals, goalErr := e.WorkGoals("case")
	if goalErr != nil || len(goals) != 1 {
		t.Fatal("no checkpoint goal", goalErr, len(goals))
	}
	row, g, err := e.workRow("case", goals[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	g.Items = []WorkItem{{ID: "db", Title: "用户处理数据库", Status: "waiting_user"}, {ID: "dependent", Title: "依赖数据库的部署", Status: "pending", DependsOn: []string{"db"}}}
	for i := 0; i < 6; i++ {
		handle := uid()
		g.Items = append(g.Items, WorkItem{ID: uid(), Title: "独立构建或发布", Status: "waiting_external", Watch: &ExternalWatch{Adapter: "release-v1", OperationID: "fixture-original-" + handle, Handle: handle, ServerID: "fixture", Revision: "fixture-capability", State: "running", NextCheckAt: time.Now().Add(-time.Second)}})
	}
	if err = e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	if err = e.workTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, after, err := e.workRow("case", g.ID)
	if err != nil || after.Status != "waiting_user" || reads.Load() != 6 || modelCalls.Load() != 3 {
		t.Fatal("independent jobs did not finish honestly", err, after.Status, reads.Load(), modelCalls.Load())
	}
	if after.Items[0].Status != "waiting_user" || after.Items[1].Status != "pending" {
		t.Fatal("human prerequisite bypassed")
	}
	view, _ := e.Snapshot("case")
	reports := 0
	for _, card := range view.Cards {
		if card.ID == "work-report-"+g.ID+"-waiting" {
			reports++
		}
	}
	if reports != 1 {
		t.Fatal("missing partial result for independently completed work", reports)
	}
	if err = e.workTick(context.Background()); err != nil || reads.Load() != 6 || modelCalls.Load() != 3 {
		t.Fatal("waiting for human spun model or observation", err)
	}
}
