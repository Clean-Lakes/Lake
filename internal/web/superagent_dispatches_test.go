package web

import (
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestPilotDispatchAppearsInBothTranscriptsWithoutRewritingUserSource(t *testing.T) {
	b, pid, pilot, worker, ch := roleWorkspaceFixture(t)
	rawBefore := jsonText(b.Store.Snapshot(pilot)["messages"])
	goalBefore, err := b.Engine.SuperTaskDetail(worker.SessionID, worker.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	dispatches := b.pilotDispatchMessages(t.Context(), pid)
	if len(dispatches) != 1 || dispatches[0]["role"] != "assistant" || dispatches[0]["text"] != "@运维专员，请去做一下：Check host A" {
		t.Fatal(dispatches)
	}
	want := jsonText(dispatches[0])
	// An old client indexed the original Pilot user bubble in this channel.
	d := object(dispatches[0]["dispatch"])
	b.Store.update(func() any {
		b.Store.exec("INSERT OR IGNORE INTO superagentChannelTimeline(channelId,kind,sourceSessionId,sourceId,createdAt) VALUES(?,'message',?,?,?)", ch.ID, pilot, d["sourceMessageId"], dispatches[0]["createdAt"])
		return nil
	})
	for range 2 {
		entries := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)["entries"].([]roleChannelEntry)
		if len(entries) != 1 || entries[0].TaskID != worker.TaskID || entries[0].WorkerID != worker.WorkerID || jsonText(entries[0].Message) != want {
			t.Fatal("channel did not show the original Pilot dispatch exactly once", entries)
		}
		for _, session := range []string{pilot, worker.SessionID} {
			seen := 0
			for _, message := range objects(b.sessionSnapshot(session)["messages"]) {
				if message["dispatch"] != nil {
					seen++
					if jsonText(message) != want {
						t.Fatal("transcript copies diverged", message)
					}
				}
			}
			if seen != 1 {
				t.Fatal("missing or duplicated dispatch", session, seen)
			}
		}
	}
	if jsonText(b.Store.Snapshot(pilot)["messages"]) != rawBefore {
		t.Fatal("presentation rewrote a user message or inserted model history")
	}
	goalAfter, err := b.Engine.SuperTaskDetail(worker.SessionID, worker.TaskID)
	if err != nil || jsonText(goalBefore) != jsonText(goalAfter) {
		t.Fatal("presentation changed the canonical task", err)
	}
	foreign := b.Store.CreateProject("Other project")
	if got := b.pilotDispatchMessages(t.Context(), stringOf(foreign["id"])); len(got) != 0 {
		t.Fatal("cross-project dispatch leak", got)
	}
	rename := b.Store.AddMessage(pilot, "user", "Rename the specialist", nil)
	event, err := b.ReceiveUserEvent(t.Context(), pilot, stringOf(rename["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Engine.ManageSuperSpecialist(t.Context(), b.superUserSource(pid, pilot), ai.SuperSpecialistChange{EventID: event.ID, PartKey: "rename", Action: "update", RoleID: worker.RoleID, Name: "Renamed specialist", Duties: "Same duties", ExpectedRevision: 1, Quote: event.Payload}); err != nil {
		t.Fatal(err)
	}
	if got := b.pilotDispatchMessages(t.Context(), pid); len(got) != 1 || jsonText(got[0]) != want {
		t.Fatal("profile rename rewrote a historical Pilot dispatch", got)
	}
}

func TestPilotDispatchesKeepSplitTasksFollowupsAndDirectUserMessagesDistinct(t *testing.T) {
	b, pid, pilot, original, ch := roleWorkspaceFixture(t)
	admit := func(session, text string) ai.SuperEvent {
		m := b.Store.AddMessage(session, "user", text, nil)
		event, err := b.ReceiveUserEvent(t.Context(), session, stringOf(m["id"]))
		if err != nil {
			t.Fatal(err)
		}
		if err := b.recordSuperInput(event, nil, nil, false); err != nil {
			t.Fatal(err)
		}
		return event
	}
	split := admit(pilot, "Check host B; Check host C")
	for _, title := range []string{"Check host B", "Check host C"} {
		_, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: split.ID, PartKey: title, Action: "create", RoleID: original.RoleID, Title: title, Quote: title, Reason: "Independent task"})
		if err != nil {
			t.Fatal(err)
		}
	}
	followup := admit(pilot, "Use the original task and inspect yesterday only")
	if _, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: followup.ID, PartKey: "continue", Action: "followup", TaskID: original.TaskID, Quote: followup.Payload, Reason: "Original task"}); err != nil {
		t.Fatal(err)
	}
	direct := admit(ch.SessionID, "My direct specialist message")
	if _, err := b.Engine.ApplySuperDecision(t.Context(), b.superUserSource(pid, pilot), ai.SuperDecision{EventID: direct.ID, PartKey: "direct", Action: "followup", TaskID: original.TaskID, Quote: direct.Payload, Reason: "Direct user input"}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		page := b.roleChannelPage(t.Context(), ch.SessionID, "", 2)
		seen := map[string]bool{}
		instructions := map[string]bool{}
		directMessages := 0
		for {
			for _, entry := range page["entries"].([]roleChannelEntry) {
				if seen[entry.ID] {
					t.Fatal("duplicate on pagination", entry.ID)
				}
				seen[entry.ID] = true
				if d := object(entry.Message["dispatch"]); len(d) > 0 {
					instructions[stringOf(d["instruction"])] = true
				} else if entry.Message["role"] == "user" {
					if entry.Message["id"] != direct.SourceEventID || entry.Message["text"] != direct.Payload {
						t.Fatal("forwarded Pilot request remained a user bubble", entry.Message)
					}
					directMessages++
				}
			}
			cursor := stringOf(page["nextCursor"])
			if cursor == "" {
				break
			}
			page = b.roleChannelPage(t.Context(), ch.SessionID, cursor, 2)
		}
		if len(instructions) != 4 || !instructions["Check host B"] || !instructions["Check host C"] || !instructions[followup.Payload] || directMessages != 1 {
			t.Fatal(instructions, directMessages)
		}
		// A lost Web display index is rebuilt from durable routing records.
		b.Store.update(func() any {
			b.Store.exec("DELETE FROM superagentChannelTimeline WHERE channelId=? AND kind='dispatch'", ch.ID)
			return nil
		})
	}
}
