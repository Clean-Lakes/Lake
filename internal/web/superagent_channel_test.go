package web

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestSuperChannelHistoryOmitsEmptyReplyPlaceholders(t *testing.T) {
	b, _, _, worker, ch := roleWorkspaceFixture(t)
	state := ai.State{View: ai.View{Session: worker.SessionID, Status: "paused", Cards: []ai.Card{
		{ID: "empty", Type: "message", At: "2026-11-03T01:00:00Z"},
		{ID: "blank", Type: "text", Content: " \n ", At: "2026-11-03T01:00:01Z"},
		{ID: "reply", Type: "message", Content: "Actual reply", At: "2026-11-03T01:00:02Z"},
	}}}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.Engine.Dir, worker.SessionID+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	// Also cover rows indexed by an earlier version while the reply was empty.
	b.Store.update(func() any {
		b.Store.exec("INSERT INTO superagentChannelTimeline(channelId,kind,sourceSessionId,sourceId,createdAt) VALUES(?,'card',?,'empty',?)", ch.ID, worker.SessionID, channelEntryTime("2026-11-03T01:00:00Z"))
		return nil
	})
	page := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)
	cards := 0
	for _, entry := range page["entries"].([]roleChannelEntry) {
		if entry.Card != nil {
			cards++
			if entry.Card.ID != "reply" {
				t.Fatal("empty historical reply remained visible", entry.Card.ID)
			}
		}
	}
	if cards != 1 {
		t.Fatal("actual reply lost", cards)
	}
}

func TestSuperChannelStagedRecoveryRestoresRoleBeforeAdmission(t *testing.T) {
	b, pid, pilot, _, ch := roleWorkspaceFixture(t)
	message := b.Store.AddMessage(ch.SessionID, "user", "Check another host", nil)
	event, err := b.ReceiveUserEvent(t.Context(), ch.SessionID, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	data := jsonText(superHostInput{TargetOptions: Object{"profile": "core"}})
	digest := sha256.Sum256([]byte(data))
	b.Store.update(func() any {
		b.Store.exec("INSERT INTO superagentInputs(eventId,sessionId,messageId,data,requestHash,ready) VALUES(?,?,?,?,?,0)", event.ID, ch.SessionID, message["id"], data, hex.EncodeToString(digest[:]))
		return nil
	})
	domain, _, err := b.Engine.SuperProject(t.Context(), pid)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		b.reconcileSuperSourceContexts(domain)
	}
	ready := b.Store.read(func() any {
		return integer(b.Store.row("SELECT ready FROM superagentInputs WHERE eventId=?", event.ID)["ready"])
	}).(int)
	if ready != 1 {
		t.Fatal("staged source was not repaired")
	}
	_, err = b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: event.ID, PartKey: "wrong-role", Action: "create", Title: event.Payload, RoleKey: "invented-role", Quote: event.Payload, Reason: "Must fail before any new worker"})
	if err == nil {
		t.Fatal("recovered source lost its host-bound role")
	}
}

func TestSuperChannelOptionsSeedNewTaskWithoutChangingExistingTask(t *testing.T) {
	b, pid, pilot, _, ch := roleWorkspaceFixture(t)
	b.Store.SaveOptions(ch.SessionID, Object{"maxSteps": 42, "maxOutput": 2048, "reasoningEffort": "", "contextBudgetMode": "manual", "contextWindow": 32000})
	m := b.Store.AddMessage(ch.SessionID, "user", "Explain host B", nil)
	event, err := b.ReceiveUserEvent(t.Context(), ch.SessionID, stringOf(m["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	worker, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: event.ID, PartKey: "b", Action: "create", Title: event.Payload, RoleKey: "运维专员", Quote: event.Payload, Reason: "Independent request"})
	if err != nil {
		t.Fatal(err)
	}
	b.ensureSuperWorkerSession(pid, worker.SessionID, event.Payload)
	initial := b.superWorkerTargetOptions(pid, worker.WorkerID, worker.SessionID)
	if initial["maxSteps"] != float64(42) || initial["maxOutput"] != float64(2048) {
		t.Fatal("channel defaults not captured", initial)
	}
	b.Store.SaveOptions(worker.SessionID, Object{"maxSteps": 77, "maxOutput": 4096})
	b.Store.SaveOptions(ch.SessionID, Object{"maxSteps": 99, "maxOutput": 8192})
	next := b.superWorkerTargetOptions(pid, worker.WorkerID, worker.SessionID)
	if _, changed := next["maxSteps"]; changed {
		t.Fatal("channel replaced in-flight task settings")
	}
	if integer(b.Store.Options(worker.SessionID)["maxSteps"]) != 77 {
		t.Fatal("task setting changed")
	}
}

func roleWorkspaceFixture(t *testing.T) (*Server, string, string, ai.SuperRouteResult, ai.SpecialistChannel) {
	t.Helper()
	b, _ := fixture(t)
	project := b.Store.CreateProject("Continuous specialist")
	pid := stringOf(project["id"])
	domain, err := b.ensureSuperProject(t.Context(), pid)
	if err != nil {
		t.Fatal(err)
	}
	message := b.Store.AddMessage(domain.RouterSessionID, "user", "Check host A", nil)
	event, err := b.ReceiveUserEvent(t.Context(), domain.RouterSessionID, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	a, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, domain.RouterSessionID), ai.SuperDecision{EventID: event.ID, PartKey: "a", Action: "create", Title: event.Payload, RoleKey: "运维专员", Quote: event.Payload, Reason: "Independent task A"})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Engine.FinishSuperUserRouting(t.Context(), b.superUserSource(pid, domain.RouterSessionID), event.ID); err != nil {
		t.Fatal(err)
	}
	channels := b.reconcileSpecialistChannels(t.Context(), pid)
	if len(channels) != 1 {
		t.Fatal(channels)
	}
	b.ensureSuperWorkerSession(pid, a.SessionID, "Check host A")
	return b, pid, domain.RouterSessionID, a, channels[0]
}

func TestSuperChannelProjectionPreservesContinuousSourcesAndPagination(t *testing.T) {
	b, pid, pilot, a, ch := roleWorkspaceFixture(t)
	first := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)
	if entries := first["entries"].([]roleChannelEntry); len(entries) != 1 || entries[0].SourceSessionID != pilot {
		t.Fatal(first)
	}
	for i := 0; i < 53; i++ {
		b.Store.AddMessage(a.SessionID, "assistant", "same independent report", nil)
		if i == 30 {
			b.Store.AddMessage(ch.SessionID, "user", "Return to host A", nil)
		}
	}
	page := b.roleChannelPage(t.Context(), ch.SessionID, "", 20)
	ids := map[string]bool{}
	cursor := ""
	for range 5 {
		entries := page["entries"].([]roleChannelEntry)
		for _, entry := range entries {
			if ids[entry.ID] {
				t.Fatal("duplicate source after paging")
			}
			ids[entry.ID] = true
		}
		cursor = stringOf(page["nextCursor"])
		if cursor == "" {
			break
		}
		page = b.roleChannelPage(t.Context(), ch.SessionID, cursor, 20)
	}
	if len(ids) != 55 {
		t.Fatal("distinct identical bodies were removed", len(ids))
	}
	again := b.roleChannelPage(t.Context(), ch.SessionID, "", 100)
	if len(again["entries"].([]roleChannelEntry)) != 55 {
		t.Fatal("reconciliation duplicated rows")
	}
	workers, err := b.Engine.SpecialistChannelWorkers(t.Context(), pid, ch.SessionID, "", 100)
	if err != nil || len(workers) != 1 || workers[0].ID != a.WorkerID {
		t.Fatal(workers, err)
	}
}

func TestSuperChannelSourceRemainsRouterPendingUntilDecision(t *testing.T) {
	b, pid, pilot, a, ch := roleWorkspaceFixture(t)
	message := b.Store.AddMessage(ch.SessionID, "user", "Check host B", nil)
	event, err := b.ReceiveUserEvent(t.Context(), ch.SessionID, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	pending, err := b.Engine.SpecialistChannelRouting(t.Context(), pid, ch.SessionID)
	if err != nil || !pending {
		t.Fatal(pending, err)
	}
	inputs, err := b.Engine.RouteSubscribedEvent(t.Context(), pid, event.ID)
	if err != nil || len(inputs) != 0 {
		t.Fatal("new host went to A", inputs, err)
	}
	bTask, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: event.ID, PartKey: "b", Action: "create", Title: event.Payload, RoleKey: "运维专员", Quote: event.Payload, Reason: "Independent host B"})
	if err != nil {
		t.Fatal(err)
	}
	if bTask.TaskID == a.TaskID || bTask.SessionID == a.SessionID {
		t.Fatal("contexts merged")
	}
	if err := b.Engine.FinishSuperUserRouting(t.Context(), b.superUserSource(pid, pilot), event.ID); err != nil {
		t.Fatal(err)
	}
	pending, err = b.Engine.SpecialistChannelRouting(t.Context(), pid, ch.SessionID)
	if err != nil || pending {
		t.Fatal(pending, err)
	}
	page := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)
	if len(page["workers"].([]ai.SuperWorkerView)) != 2 || len(b.reconcileSpecialistChannels(t.Context(), pid)) != 1 {
		t.Fatal("multiple navigation channels")
	}
}

func TestSuperChannelControlRequiresExactExecutionSession(t *testing.T) {
	b, h := fixture(t)
	project := b.Store.CreateProject("Exact control")
	pid := stringOf(project["id"])
	d, err := b.ensureSuperProject(t.Context(), pid)
	if err != nil {
		t.Fatal(err)
	}
	m := b.Store.AddMessage(d.RouterSessionID, "user", "Check target", nil)
	event, err := b.ReceiveUserEvent(t.Context(), d.RouterSessionID, stringOf(m["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	worker, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, d.RouterSessionID), ai.SuperDecision{EventID: event.ID, PartKey: "target", Action: "create", Title: event.Payload, RoleKey: "运维专员", Quote: event.Payload, Reason: "New target"})
	if err != nil {
		t.Fatal(err)
	}
	ch := b.reconcileSpecialistChannels(t.Context(), pid)[0]
	apiTest(t, h, "GET", fmt.Sprintf("/api/sessions/%s/snapshot", ch.SessionID), nil, 200)
	apiTest(t, h, "GET", fmt.Sprintf("/api/sessions/%s/channel", ch.SessionID), nil, 200)
	for _, op := range []string{"abort", "questionReply", "workControl", "executePlan"} {
		apiTest(t, h, "POST", "/api/sessions/"+ch.SessionID+"/ai/"+op, Object{}, 409)
	}
	apiTest(t, h, "DELETE", "/api/sessions/"+ch.SessionID, nil, 409)
	b.ensureSuperWorkerSession(pid, worker.SessionID, "Check target")
	for _, source := range []string{ch.SessionID, worker.SessionID} {
		message := apiTest(t, h, "POST", "/api/sessions/"+source+"/messages", Object{"text": "Check a different host; route before dispatch"}, 202)
		if source == worker.SessionID && message["pilotSessionId"] != ch.SessionID {
			t.Fatal("old Worker link did not return the role channel", message)
		}
		if stringOf(message["id"]) == "" {
			t.Fatal("channel lost actual user input")
		}
		pending, err := b.Engine.SpecialistChannelRouting(t.Context(), pid, ch.SessionID)
		if err != nil || !pending {
			t.Fatal("ordinary channel input bypassed Router", pending, err)
		}
	}
}

func TestSuperChannelStopHTTPUsesOwnedCanonicalTasks(t *testing.T) {
	b, h := fixture(t)
	p := b.Store.CreateProject("Channel stop")
	pid := stringOf(p["id"])
	domain, err := b.ensureSuperProject(t.Context(), pid)
	if err != nil {
		t.Fatal(err)
	}
	m := b.Store.AddMessage(domain.RouterSessionID, "user", "Inspect only this task", nil)
	event, err := b.ReceiveUserEvent(t.Context(), domain.RouterSessionID, stringOf(m["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	worker, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, domain.RouterSessionID), ai.SuperDecision{EventID: event.ID, PartKey: "task", Action: "create", Title: event.Payload, RoleKey: "运维专员", Quote: event.Payload, Reason: "Original request"})
	if err != nil {
		t.Fatal(err)
	}
	ch := b.reconcileSpecialistChannels(t.Context(), pid)[0]
	apiTest(t, h, "POST", "/api/sessions/"+ch.SessionID+"/channel", Object{"action": "invalid"}, 400)
	apiTest(t, h, "POST", "/api/sessions/"+ch.SessionID+"/channel", Object{"action": "stop"}, 200)
	view, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
	if err != nil || view.State != "cancelled" {
		t.Fatal(view, err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+ch.SessionID+"/ai/abort", Object{}, 409)
}
