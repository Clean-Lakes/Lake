package web

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestScheduleManagerProjectIsolationAndRevision(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	value, err := b.scheduleTool(context.Background(), session, project, "schedule_create", Object{"name": "Fixture reminder", "kind": "reminder", "message": "Only test data", "at": time.Now().Add(time.Hour).Format(time.RFC3339), "interval_seconds": 60}, true)
	if err != nil {
		t.Fatal(err)
	}
	id := stringOf(object(value)["id"])
	base := "/api/projects/" + project + "/schedules"
	path := base + "/" + id
	list := apiTest(t, h, "GET", base, nil, 200)
	items := objects(list["items"])
	if len(items) != 1 || items[0]["options"] != nil || items[0]["history"] != nil {
		t.Fatal("invalid public list")
	}
	other := stringOf(b.Store.CreateProject("Other")["id"])
	apiTest(t, h, "GET", "/api/projects/"+other+"/schedules/"+id, nil, 404)
	if len(objects(apiTest(t, h, "GET", "/api/projects/"+other+"/schedules", nil, 200)["items"])) != 0 {
		t.Fatal("project data leaked")
	}
	apiTest(t, h, "PATCH", path, Object{"enabled": false, "expectedRevision": 0}, 409)
	apiTest(t, h, "PATCH", path, Object{"enabled": false, "expectedRevision": 1, "options": Object{}}, 400)
	paused := apiTest(t, h, "PATCH", path, Object{"enabled": false, "expectedRevision": 1}, 200)
	if paused["enabled"] != false || integer(paused["revision"]) != 2 {
		t.Fatal(paused)
	}
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	if err != nil {
		t.Fatal(err)
	}
	options := jsonText(rows[0].Options)
	rows[0].At = time.Now().Add(-time.Hour).Format(time.RFC3339)
	must(b.writeSchedules(rows))
	b.scheduleMu.Unlock()
	resumed := apiTest(t, h, "PATCH", path, Object{"enabled": true, "expectedRevision": 2}, 200)
	at, err := time.Parse(time.RFC3339, stringOf(resumed["at"]))
	if err != nil || !at.After(time.Now()) {
		t.Fatal("resume did not skip overdue occurrence")
	}
	if len(objects(b.Store.Snapshot(session)["messages"])) != 0 {
		t.Fatal("resume executed a task")
	}
	b.scheduleMu.Lock()
	rows, err = b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil || jsonText(rows[0].Options) != options {
		t.Fatal("saved permission snapshot changed")
	}
	detail := apiTest(t, h, "GET", path, nil, 200)
	if detail["options"] != nil || len(objects(detail["history"])) != 0 {
		t.Fatal("invalid history/secret projection")
	}
}

func TestScheduleExecutionHistoryPersistenceAndPauseRunning(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	now := time.Now()
	row := toolSchedule{ID: ident(), Project: project, Session: session, Name: "History fixture", Kind: "reminder", Message: "Test only", At: now.Add(-time.Second).Format(time.RFC3339), Interval: 60, Enabled: true, Revision: 1, Status: "scheduled"}
	b.scheduleMu.Lock()
	must(b.writeSchedules([]toolSchedule{row}))
	b.scheduleMu.Unlock()
	b.tickSchedules(now)
	b.tickSchedules(now)
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil || len(rows[0].History) != 1 || rows[0].History[0].Status != "completed" || rows[0].History[0].FinishedAt == "" {
		t.Fatal("completion history missing")
	}
	if len(objects(b.Store.Snapshot(session)["messages"])) != 1 {
		t.Fatal("duplicate effect")
	}
	row = rows[0]
	row.Status = "running"
	row.TaskID = "fixture-run"
	appendScheduleExecution(&row, scheduleExecution{ID: ident(), ScheduledAt: row.At, StartedAt: now.Format(time.RFC3339), Status: "running"})
	b.scheduleMu.Lock()
	must(b.writeSchedules([]toolSchedule{row}))
	b.scheduleMu.Unlock()
	path := "/api/projects/" + project + "/schedules/" + row.ID
	paused := apiTest(t, h, "PATCH", path, Object{"enabled": false, "expectedRevision": row.Revision}, 200)
	if paused["enabled"] != false || paused["status"] != "running" || paused["task_id"] != "fixture-run" {
		t.Fatal("pause cancelled active occurrence")
	}
	b.scheduleMu.Lock()
	restored, err := b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil || len(restored[0].History) != 2 {
		t.Fatal("history not durable")
	}
	restored[0].Status = "failed"
	restored[0].Error = "fixture failure"
	finishScheduleExecution(&restored[0], now)
	if restored[0].History[1].Status != "failed" {
		t.Fatal("failure missing")
	}
	for i := 0; i < 110; i++ {
		appendScheduleExecution(&restored[0], scheduleExecution{ID: ident(), Status: "completed"})
	}
	if len(restored[0].History) != 100 {
		t.Fatal("unbounded history")
	}
}

func TestScheduleRestartRecordsInterruptedAndMissedWithoutReplay(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	past := time.Now().Add(-time.Hour).Format(time.RFC3339)
	running := toolSchedule{ID: ident(), Project: project, Session: session, At: time.Now().Add(time.Hour).Format(time.RFC3339), Status: "running", Revision: 2, History: []scheduleExecution{{ID: ident(), Status: "running", StartedAt: past}}}
	missed := toolSchedule{ID: ident(), Project: project, Session: session, At: past, Kind: "reminder", Message: "must not replay", Enabled: true, Revision: 1}
	b.scheduleMu.Lock()
	must(b.writeSchedules([]toolSchedule{running, missed}))
	b.scheduleMu.Unlock()
	if err := b.startScheduler(); err != nil {
		t.Fatal(err)
	}
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].History[0].Status != "interrupted" || rows[1].History[0].Status != "missed" || rows[1].Enabled {
		t.Fatal("restart history incorrect")
	}
	b.tickSchedules(time.Now())
	if len(objects(b.Store.Snapshot(session)["messages"])) != 0 {
		t.Fatal("missed occurrence replayed")
	}
	if !strings.Contains(rows[0].History[0].Error, "restarted") {
		t.Fatal("interruption reason missing")
	}
}

func TestScheduleWorkflowHistoryUsesActualResultSession(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	saved := b.Store.SaveWorkflow(project, "", 0, b.validateWorkflowTemplate(project, object(parsed(jsonText(workflowFixtureInput(ref))))))
	run := b.Store.CreateWorkflowRun(project, saved.ID, 1)
	runID := stringOf(run["id"])
	resultSession := stringOf(run["sessionId"])
	row := toolSchedule{ID: ident(), Project: project, Session: session, At: time.Now().Add(time.Hour).Format(time.RFC3339), Status: "running", TaskID: runID, Revision: 2, History: []scheduleExecution{{ID: ident(), Status: "running", SessionID: session}}}
	b.scheduleMu.Lock()
	must(b.writeSchedules([]toolSchedule{row}))
	b.scheduleMu.Unlock()
	b.Store.FinishWorkflowRun(runID, "completed", "")
	b.tickSchedules(time.Now())
	detail := apiTest(t, h, "GET", "/api/projects/"+project+"/schedules/"+row.ID, nil, 200)
	history := objects(detail["history"])
	if len(history) != 1 || history[0]["status"] != "completed" || history[0]["session_id"] != resultSession || resultSession == session {
		t.Fatal("wrong execution result target")
	}
}
func TestScheduleFailedClaimHasDurableFailure(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	other := stringOf(b.Store.CreateProject("Wrong owner")["id"])
	row := toolSchedule{ID: ident(), Project: other, Session: session, Kind: "reminder", Message: "must not execute", Name: "Failure fixture", At: time.Now().Add(-time.Second).Format(time.RFC3339), Enabled: true, Revision: 1}
	b.scheduleMu.Lock()
	must(b.writeSchedules([]toolSchedule{row}))
	b.scheduleMu.Unlock()
	b.tickSchedules(time.Now())
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	b.scheduleMu.Unlock()
	if err != nil || len(rows[0].History) != 1 || rows[0].History[0].Status != "failed" || rows[0].History[0].FinishedAt == "" {
		t.Fatal("failed occurrence not recorded")
	}
	if len(objects(b.Store.Snapshot(session)["messages"])) != 1 {
		t.Fatal("failure notice missing or unexpected effect")
	}
}

func TestScheduleEnableChecksWorkflowPrerequisitesButPauseRemainsAvailable(t *testing.T) {
	b, h := fixture(t)
	session, _ := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	row := toolSchedule{ID: ident(), Project: project, Session: session, Kind: "workflow", Enabled: false, Revision: 1, At: time.Now().Add(time.Hour).Format(time.RFC3339), Status: "scheduled"}
	b.scheduleMu.Lock()
	must(b.writeSchedules([]toolSchedule{row}))
	b.scheduleMu.Unlock()
	path := "/api/projects/" + project + "/schedules/" + row.ID
	result := apiTest(t, h, "PATCH", path, Object{"enabled": true, "expectedRevision": 1}, 409)
	if !strings.Contains(stringOf(result["error"]), "SRE") {
		t.Fatal("missing prerequisite guidance")
	}
	b.Store.SetSREEnabled(project, true)
	result = apiTest(t, h, "PATCH", path, Object{"enabled": true, "expectedRevision": 1}, 409)
	if !strings.Contains(stringOf(result["error"]), "模型") {
		t.Fatal("missing model guidance")
	}
	b.scheduleMu.Lock()
	rows, err := b.readSchedules()
	if err != nil {
		t.Fatal(err)
	}
	rows[0].Enabled = true
	must(b.writeSchedules(rows))
	b.scheduleMu.Unlock()
	apiTest(t, h, "PATCH", path, Object{"enabled": false, "expectedRevision": 1}, 200)
}
