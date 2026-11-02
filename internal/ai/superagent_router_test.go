package ai

import (
	"context"
	"strings"
	"testing"

	"gorm.io/gorm"
)

func superCreateFixture(t *testing.T, e *Engine, b SuperSourceBinding, messageID, text, part, quote string) SuperRouteResult {
	t.Helper()
	ctx := context.Background()
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: messageID, Kind: "message", Payload: text})
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.ApplySuperDecision(ctx, b, SuperDecision{EventID: event.ID, PartKey: part, Action: "create", Title: quote, RoleKey: "investigator", Quote: quote, Reason: "actual user request"})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSuperRouterSplitsAndSupplementsOneTask(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	text := "Investigate orders; follow build 45. Do not change the database."
	orders := superCreateFixture(t, e, b, "message", text, "orders", "Investigate orders")
	build := superCreateFixture(t, e, b, "message", text, "build", "follow build 45")
	replay := superCreateFixture(t, e, b, "message", text, "orders", "Investigate orders")
	if orders.TaskID == build.TaskID || orders.SessionID == build.SessionID || replay.TaskID != orders.TaskID {
		t.Fatal(orders, build, replay)
	}
	_, g, err := e.workRow(orders.SessionID, orders.TaskID)
	if err != nil || !strings.Contains(g.UserText, "Do not change the database") {
		t.Fatal("constraints lost", g, err)
	}
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "supplement", Kind: "message", Payload: "Orders only from yesterday"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.ApplySuperDecision(ctx, b, SuperDecision{EventID: event.ID, PartKey: "orders", Action: "followup", TaskID: orders.TaskID, Quote: event.Payload, Reason: "explicit existing task"})
	if err != nil {
		t.Fatal(err)
	}
	db, _ := e.superStore()
	var rows []superInboxRow
	if err = db.Find(&rows).Error; err != nil || len(rows) != 1 || rows[0].TaskID != orders.TaskID || rows[0].WorkerID != orders.WorkerID {
		t.Fatal(rows, err)
	}
	var count int64
	if err = db.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("routing dispatched resource I/O", count, err)
	}
	if err = db.Model(&securityTaskRow{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatal("routing granted task authority", count, err)
	}
}

func TestSuperRouterRejectsForgedSourceAndForeignTask(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "first", "Check orders", "orders", "Check orders")
	foreign := b
	foreign.SourceID = "other-source"
	foreign.ProjectID = "other"
	if err := e.RegisterSuperSource(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	event, _, err := e.ReceiveSuperEvent(ctx, foreign, SuperEventInput{SourceEventID: "m", Kind: "message", Payload: "stop orders"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.ApplySuperDecision(ctx, foreign, SuperDecision{EventID: event.ID, PartKey: "stop", Action: "stop", TaskID: task.TaskID, Quote: event.Payload, Reason: "forged ownership"}); err == nil {
		t.Fatal("cross-project task control")
	}
	if _, err = e.ApplySuperDecision(ctx, b, SuperDecision{EventID: event.ID, PartKey: "forge", Action: "create", Title: "x", RoleKey: "x", Quote: "invented", Reason: "forged source"}); err == nil {
		t.Fatal("foreign event admitted")
	}
}

func TestSuperRouterRunsOnlyOfficialADKWithRestrictedCatalog(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "human", Kind: "message", Payload: "Check orders"})
	if err != nil {
		t.Fatal(err)
	}
	var modelCalls int
	m, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		modelCalls++
		tools := js(input["tools"])
		if strings.Contains(tools, `"name":"shell"`) || !strings.Contains(tools, "route_work") {
			t.Error("Router catalog leaked", tools)
		}
		if n == 1 {
			return response("", Call{ID: "route", Name: "route_work", Arguments: js(map[string]any{"event_id": event.ID, "part_key": "orders", "action": "create", "title": "Orders", "role_key": "investigator", "quote": "Check orders", "reason": "actual user request"})})
		}
		return response("已安排订单专员。")
	})
	defer closeModel()
	if err = e.Configure("pilot", Config{Model: m, SecurityProjectID: b.ProjectID, Profile: "core"}); err != nil {
		t.Fatal(err)
	}
	if err = e.RunPilotRouter(ctx, "pilot", b); err != nil {
		t.Fatal(err)
	}
	queued, err := e.SuperQueuedWorkers(ctx, b.ProjectID)
	if err != nil || len(queued) != 1 || modelCalls != 2 {
		t.Fatal(queued, modelCalls, err)
	}
	db, _ := e.superStore()
	var events int64
	if err = db.Table("events").Count(&events).Error; err != nil || events < 1 {
		t.Fatal("official SDK did not persist events", events, err)
	}
	s, _ := e.get("pilot")
	s.mu.Lock()
	c := s.state.Config
	c.superRouter = &superRouterRun{projectID: b.ProjectID, binding: b, events: map[string]bool{event.ID: true}}
	s.mu.Unlock()
	if _, err = e.invoke(ctx, s, c, Call{ID: "hidden", Name: "shell", Arguments: `{"command":"touch should-not-exist"}`}); err == nil {
		t.Fatal("Router executed hidden tool")
	}
}

func TestSuperRouterObjectScopeAndUTF8Paging(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "unicode", "排查订单，不得修改数据", "订单", "排查订单")
	s, _ := e.get("pilot")
	s.mu.Lock()
	s.state.Config = Config{SecurityProjectID: b.ProjectID, superRole: "router"}
	s.mu.Unlock()
	page, err := e.ReadSuperObject(ctx, "pilot", "task", task.TaskID, 0, 0, 37)
	if err != nil || page.NextOffset == 0 {
		t.Fatal(page, err)
	}
	next, err := e.ReadSuperObject(ctx, "pilot", "task", task.TaskID, page.Revision, page.NextOffset, 37)
	if err != nil || next.Hash != page.Hash {
		t.Fatal(next, err)
	}
	if _, err = e.ReadSuperObject(ctx, "pilot", "task", task.TaskID, page.Revision+1, 0, 37); err == nil {
		t.Fatal("stale revision read")
	}
	s.mu.Lock()
	s.state.Config.SecurityProjectID = "foreign"
	s.mu.Unlock()
	if _, err = e.ReadSuperObject(ctx, "pilot", "task", task.TaskID, 0, 0, 37); err == nil {
		t.Fatal("foreign object read")
	}
}

func TestSuperAssignmentRejectsDuplicateAndExpiredOwner(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	task := superCreateFixture(t, e, b, "work", "Investigate", "one", "Investigate")
	db, _ := e.superStore()
	var worker superWorkerRow
	if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil {
		t.Fatal(err)
	}
	if err := e.finishSuperRouting(ctx, b, worker.SourceEventID); err != nil {
		t.Fatal(err)
	}
	token, err := e.AcquireWorkerSlot(ctx, b.ProjectID, task.WorkerID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.AcquireWorkerSlot(ctx, b.ProjectID, task.WorkerID); err == nil {
		t.Fatal("duplicate active Worker")
	}
	stale := token
	stale.Generation++
	if err = e.ReleaseWorkerSlot(ctx, stale, "parked"); err == nil {
		t.Fatal("foreign generation released Worker")
	}
	if err = db.Model(&superAssignmentRow{}).Where("id = ?", token.AssignmentID).Update("lease_until", gorm.Expr("datetime('now','-1 minute')")).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.renewSuperAssignment(ctx, token); err == nil {
		t.Fatal("expired lease revived")
	}
	if _, err = e.AcquireWorkerSlot(ctx, b.ProjectID, task.WorkerID); err == nil {
		t.Fatal("expired owner stolen without reconciliation")
	}
}
