package ai

import (
	"strings"
	"testing"
)

func TestSuperChannelADKRouterCreatesBReturnsAAndRegistersComparison(t *testing.T) {
	e, b := superFixture(t)
	var event SuperEvent
	var a, second, comparison SuperRouteResult
	stage := 0
	calls := 0
	model, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		calls++
		tools := js(input["tools"])
		if strings.Contains(tools, `"name":"shell"`) || !strings.Contains(tools, "search_super_tasks") {
			t.Error("Router lost read-only routing boundary")
		}
		if n%2 == 0 {
			return response("已按原任务归属安排。")
		}
		args := map[string]any{"event_id": event.ID, "part_key": "request", "action": "create", "title": event.Payload, "role_key": "investigator", "quote": event.Payload, "reason": "Actual independent requirement"}
		if stage == 2 {
			args["action"] = "followup"
			args["task_id"] = a.TaskID
			delete(args, "title")
			delete(args, "role_key")
		}
		if stage == 3 {
			args["evidence_task_ids"] = []string{a.TaskID, second.TaskID}
		}
		return response("", Call{ID: "route", Name: "route_work", Arguments: js(args)})
	})
	defer closeModel()
	if err := e.Configure("pilot", Config{Model: model, SecurityProjectID: b.ProjectID, Profile: "core", MaxSteps: 12}); err != nil {
		t.Fatal(err)
	}
	var ch SpecialistChannel
	var beforeA SuperTaskDetail
	for stage = 0; stage < 4; stage++ {
		text := []string{"Check host A", "Check host B", "Continue host A", "Compare host A and host B"}[stage]
		var err error
		if stage == 0 {
			event, _, err = e.ReceiveSuperEvent(t.Context(), b, SuperEventInput{SourceEventID: "first", ThreadRef: "pilot", Kind: "message", Payload: text})
		} else {
			event = channelEventFixture(t, e, b, ch, text, text)
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := e.RunPilotRouter(t.Context(), "pilot", b); err != nil {
			t.Fatal("stage", stage, err)
		}
		db, _ := e.superStore()
		var row superDecisionRow
		if err := db.First(&row, "event_id = ? AND part_key = ?", event.ID, "request").Error; err != nil {
			t.Fatal(err)
		}
		result, err := superRouteResult(db, row)
		if err != nil {
			t.Fatal(err)
		}
		switch stage {
		case 0:
			a = result
			channels, err := e.ListSpecialistChannels(t.Context(), b.ProjectID)
			if err != nil || len(channels) != 1 {
				t.Fatal(channels, err)
			}
			ch = channels[0]
			beforeA, err = e.SuperTaskDetail(a.SessionID, a.TaskID)
			if err != nil {
				t.Fatal(err)
			}
		case 1:
			second = result
			if second.TaskID == a.TaskID || second.SessionID == a.SessionID {
				t.Fatal("new host entered A")
			}
		case 2:
			if result.TaskID != a.TaskID || result.SessionID != a.SessionID {
				t.Fatal("A was not recalled")
			}
		case 3:
			comparison = result
			var refs []superTaskReferenceRow
			if err := db.Where("task_id = ?", comparison.TaskID).Find(&refs).Error; err != nil || len(refs) != 2 {
				t.Fatal(refs, err)
			}
		}
	}
	channels, err := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	afterA, err := e.SuperTaskDetail(a.SessionID, a.TaskID)
	if err != nil || js(beforeA) != js(afterA) {
		t.Fatal("routing rewrote A authority", err)
	}
	if comparison.TaskID == a.TaskID || comparison.TaskID == second.TaskID || calls != 8 {
		t.Fatal("comparison context was not independent", calls)
	}
}
