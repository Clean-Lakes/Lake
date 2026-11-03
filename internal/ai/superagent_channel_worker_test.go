package ai

import (
	"strings"
	"testing"
)

func TestSuperRoleChannelDoesNotInjectAnotherWorkerTranscript(t *testing.T) {
	observed := []string{}
	model, closeModel := fakeModel(t, func(n int, input map[string]any) any {
		messages := js(input["messages"])
		observed = append(observed, messages)
		if strings.Contains(messages, "Check host B only") {
			if strings.Contains(messages, "ALPHA_PRIVATE_OBSERVATION") || strings.Contains(messages, "Check host A only") {
				t.Error("B received A's Worker transcript")
			}
			return response("BETA_PRIVATE_OBSERVATION")
		}
		return response("ALPHA_PRIVATE_OBSERVATION")
	})
	defer closeModel()
	e := managedEngineFixture(t, model)
	b := SuperSourceBinding{SourceID: "user", ProjectID: "project", Kind: "user", ActorRef: "owner", Revision: "1"}
	if err := e.RegisterSuperSource(t.Context(), b); err != nil {
		t.Fatal(err)
	}
	a := superCreateFixture(t, e, b, "a", "Check host A only", "a", "Check host A only")
	channels, err := e.ListSpecialistChannels(t.Context(), b.ProjectID)
	if err != nil || len(channels) != 1 {
		t.Fatal(channels, err)
	}
	event := channelEventFixture(t, e, b, channels[0], "b", "Check host B only")
	second, err := e.ApplySuperDecision(t.Context(), b, SuperDecision{EventID: event.ID, PartKey: "b", Action: "create", Title: event.Payload, RoleKey: "investigator", Quote: event.Payload, Reason: "Different target"})
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []SuperRouteResult{a, second} {
		db, _ := e.superStore()
		var worker superWorkerRow
		if err := db.First(&worker, "id = ?", task.WorkerID).Error; err != nil {
			t.Fatal(err)
		}
		if err := e.FinishSuperUserRouting(t.Context(), b, worker.SourceEventID); err != nil {
			t.Fatal(err)
		}
		if err := e.ConfigureTaskWorker(t.Context(), b.ProjectID, worker.ID, Config{Model: model, SecurityProjectID: b.ProjectID, Profile: "core", MaxSteps: 12}); err != nil {
			t.Fatal(err)
		}
		if err := e.StartTaskWorker(t.Context(), b.ProjectID, worker.ID); err != nil {
			t.Fatal(err)
		}
	}
	seenA, seenB := false, false
	for _, messages := range observed {
		seenA = seenA || strings.Contains(messages, "Check host A only")
		seenB = seenB || strings.Contains(messages, "Check host B only")
	}
	if !seenA || !seenB {
		t.Fatal("both task contexts were not observed")
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := store.DB.Table("sessions").Where("id = ?", channels[0].SessionID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("presentation channel acquired an ADK session")
	}
}
