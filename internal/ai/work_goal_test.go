package ai

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkGoalParksBackgroundAndResumesOriginalWithoutReplay(t *testing.T) {
	var requests atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, _ map[string]any) any {
		n := requests.Add(1)
		if n == 1 {
			return response("", Call{ID: "start-job", Name: "shell", Arguments: `{"command":"sleep 0.1; printf observed-completion","run_in_background":true}`})
		}
		if n == 2 {
			return response("工作已经启动，等待实际结果。")
		}
		if n == 3 {
			return response("原任务已核对完成，没有重复执行。")
		}
		return response("independent topic")
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	s, _ := e.get("case")
	s.mu.Lock()
	permissions := DefaultPermissions()
	permissions.SilentCommands = true
	s.state.Config.Permissions = &permissions
	s.mu.Unlock()
	if err := e.Chat(context.Background(), "case", "完成这个后台任务并核对结果", nil); err != nil {
		t.Fatal(err)
	}
	goals, err := e.WorkGoals("case")
	if err != nil || len(goals) != 1 {
		t.Fatal(goals, err)
	}
	g := goals[0]
	if g.Status != "waiting_external" || requests.Load() != 2 || e.SessionReserved("case") {
		t.Fatal("wait did not park", g.Status, requests.Load())
	}
	row, g, err := e.workRow("case", g.ID)
	if err != nil || row.Checkpoint == "" || row.WaitCallID == "" {
		t.Fatal("missing durable wait", err)
	}
	// Virtual time: no sleep-based polling, and no new model call while running.
	g.Items[0].Watch.NextCheckAt = time.Now().Add(-time.Second)
	if err = e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if err = e.workTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	goals, err = e.WorkGoals("case")
	if err != nil {
		t.Fatal(err)
	}
	if goals[0].Status != "completed" || !strings.Contains(goals[0].Summary, "没有重复") {
		t.Fatalf("did not finish original goal: %+v requests %d", goals[0], requests.Load())
	}
	retired, _, err := e.workRow("case", g.ID)
	if err != nil || retired.Checkpoint != "" || retired.WaitCallID != "" || retired.WaitState != "" || retired.LeaseOwner != "" || !retired.LeaseUntil.IsZero() {
		t.Fatal("completed work kept a resumable invocation", retired, err)
	}
	if _, active := e.workActive.Load(g.ID); active {
		t.Fatal("completed work retained active runtime")
	}
	if _, statErr := os.Stat(filepath.Join(e.Dir, "work-goals", g.ID)); !os.IsNotExist(statErr) {
		t.Fatal("completed continuation cache retained", statErr)
	}
	beforeRequests := requests.Load()
	if err = e.workTick(context.Background()); err != nil || requests.Load() != beforeRequests {
		t.Fatal("retired work resumed again", err)
	}
	view, err := e.Snapshot("case")
	if err != nil || view.Status != "completed" {
		t.Fatal("projection did not reflect goal completion", view.Status, err)
	}
	if requests.Load() != 3 {
		t.Fatal("extra polling model requests", requests.Load())
	}
	if err = e.Chat(context.Background(), "case", "unrelated topic", nil); err != nil {
		t.Fatal(err)
	}
	view, _ = e.Snapshot("case")
	if view.RootTurnID == g.OriginRootTurnID || view.Status != "completed" {
		t.Fatal("old work contaminated foreground")
	}
	store, _ := e.adkStore()
	var count int64
	store.DB.Model(&nativeOperation{}).Where("session_id = ? AND call_id = ?", "case", "start-job").Count(&count)
	if count != 1 {
		t.Fatal("original operation replayed", count)
	}
}

func TestWorkGoalDependenciesCASAndOwnership(t *testing.T) {
	e := engineFor(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"}, nil)
	s, _ := e.get("case")
	s.state.View.RootTurnID = "source-turn"
	g, err := e.beginWork(s, "发布与数据库依赖", []WorkItem{{ID: "db", Title: "由用户完成数据库"}, {ID: "deploy", Title: "依赖部署", DependsOn: []string{"db"}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.invokeWorkTool(context.Background(), s, s.state.Config, Call{Name: "work_update"}, map[string]any{"item_id": g.Items[1].ID, "status": "running"})
	if err == nil {
		t.Fatal("unfulfilled dependency was ignored")
	}
	if err = e.WorkControl(context.Background(), "other", g.ID, "cancel", g.Revision); err == nil {
		t.Fatal("cross-session control allowed")
	}
	if err = e.WorkControl(context.Background(), "case", g.ID, "pause", g.Revision); err != nil {
		t.Fatal(err)
	}
	if err = e.WorkControl(context.Background(), "case", g.ID, "resume", g.Revision); err == nil {
		t.Fatal("stale revision changed goal")
	}
	_, err = e.beginWork(s, "cycle", []WorkItem{{ID: "a", Title: "a", DependsOn: []string{"b"}}, {ID: "b", Title: "b", DependsOn: []string{"a"}}})
	// A paused goal cannot be extended behind the user's back.
	if err == nil {
		t.Fatal(err)
	}
}

func TestReleaseWatchRejectsMismatchedAndUnknownResults(t *testing.T) {
	for _, result := range []any{map[string]any{"status": "success"}, map[string]any{"structuredContent": map[string]any{"id": "other", "status": "success"}}, map[string]any{"structuredContent": map[string]any{"id": "original", "status": "new-unknown"}}} {
		if _, err := releaseWatchState(result, "original"); err == nil {
			t.Fatal("untrusted status completed original job")
		}
	}
	for status, want := range map[string]string{"building": "running", "deploying": "running", "success": "completed", "failed": "failed"} {
		got, err := releaseWatchState(map[string]any{"structuredContent": map[string]any{"id": "original", "status": status}}, "original")
		if err != nil || got != want {
			t.Fatal(got, err)
		}
	}
}

func TestRejectedWorkFinishKeepsOfficialLoopRunning(t *testing.T) {
	var calls atomic.Int32
	m, closeModel := fakeModel(t, func(_ int, body map[string]any) any {
		switch calls.Add(1) {
		case 1:
			return response("", Call{ID: "begin", Name: "work_begin", Arguments: `{"title":"实际前置条件","items":[{"title":"需要用户处理"}]}`})
		case 2:
			return response("", Call{ID: "invalid-finish", Name: "work_finish", Arguments: `{"summary":"不应显示的假完成"}`})
		default:
			if !strings.Contains(js(body["messages"]), "不能结束目标") {
				t.Error("official loop did not receive rejection")
			}
			return response("当前工作未完成，等待实际前置条件。")
		}
	})
	defer closeModel()
	e := engineFor(t, m, nil)
	if err := e.Chat(context.Background(), "case", "核对前置条件", nil); err != nil {
		t.Fatal(err)
	}
	goals, err := e.WorkGoals("case")
	if err != nil || len(goals) != 1 || goals[0].Status == "completed" || calls.Load() < 3 {
		t.Fatal("rejected finish ended invocation", err, goals, calls.Load())
	}
	view, _ := e.Snapshot("case")
	for _, card := range view.Cards {
		if card.Type == "text" && card.Content == "不应显示的假完成" {
			t.Fatal("invalid completion published")
		}
	}
}
