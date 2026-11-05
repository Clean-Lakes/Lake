package web

import (
	"fmt"
	"testing"
)

func TestSuperReportDeliveryKeepsOnlyProseAndCanonicalTaskState(t *testing.T) {
	b, pid, pilot, worker, ch := roleWorkspaceFixture(t)
	before, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	body := "当前账号可见的发布单共有 917 单。"
	_, err = b.Engine.QueuePilotReport(t.Context(), pid, worker.SessionID, worker.TaskID, pilot, "source", "result", body, before.Revision)
	if err != nil {
		t.Fatal(err)
	}
	reports, err := b.Engine.PendingPilotReports(t.Context(), pid)
	if err != nil || len(reports) != 2 {
		t.Fatal(reports, err)
	}
	for _, report := range reports {
		pending, err := b.Engine.SuperHostReports(t.Context(), pid, report.ChannelRef, []string{report.ID})
		if err != nil || len(pending) != 0 {
			t.Fatal("undelivered report projected into history", pending, err)
		}
		for range 2 {
			if err := b.DeliverPilotReport(t.Context(), pid, pilot, report.ID); err != nil {
				t.Fatal(err)
			}
		}
		rows := objects(b.Store.Snapshot(report.ChannelRef)["messages"])
		found := 0
		for _, message := range rows {
			if message["id"] == report.ID {
				found++
				if message["text"] != body {
					t.Fatal("host appended a task receipt to prose", message["text"])
				}
			}
		}
		if found != 1 {
			t.Fatal("report lost or duplicated", report.ChannelRef, found)
		}
	}
	after, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
	if err != nil || after.State != before.State || after.AcceptanceState != before.AcceptanceState || after.Revision != before.Revision {
		t.Fatal("presentation changed canonical task state", before, after, err)
	}
	if ch.SessionID == pilot {
		t.Fatal("fixture did not exercise both channels")
	}
}

func TestSuperReportReceiptStillRejectsChangedBody(t *testing.T) {
	b, pid, pilot, worker, _ := roleWorkspaceFixture(t)
	view, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	report, err := b.Engine.QueuePilotReport(t.Context(), pid, worker.SessionID, worker.TaskID, pilot, "source", "attention", "Actual report", view.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Engine.BeginPilotHostDelivery(t.Context(), pid, report.ID); err != nil {
		t.Fatal(err)
	}
	b.Store.update(func() any {
		b.Store.exec("INSERT INTO messages(id,sessionId,role,text,createdAt) VALUES(?,?,?,?,?)", report.ID, pilot, "assistant", "Changed report\n\n任务「Check host A」· 执行中 · 验收：未验收", now())
		return nil
	})
	expectPanic(t, 409, func() { _ = b.DeliverPilotReport(t.Context(), pid, pilot, report.ID) })
}

func TestSuperReportLegacyFooterIsPresentationOnlyAndDeliveryRecovers(t *testing.T) {
	b, pid, pilot, worker, ch := roleWorkspaceFixture(t)
	view, err := b.Engine.SuperTask(worker.SessionID, worker.TaskID)
	if err != nil || view.State != "running" || view.AcceptanceState != "not_evaluated" {
		t.Fatal(view, err)
	}
	// The report's own words must survive, even if they resemble an old footer.
	body := "当前账号可见的发布单共有 917 单。\n\n任务「正文中的引用」· 已验收 · 验收：通过"
	_, err = b.Engine.QueuePilotReport(t.Context(), pid, worker.SessionID, worker.TaskID, pilot, "source", "attention", body, view.Revision)
	if err != nil {
		t.Fatal(err)
	}
	reports, err := b.Engine.PendingPilotReports(t.Context(), pid)
	if err != nil || len(reports) != 2 {
		t.Fatal(reports, err)
	}
	legacy := fmt.Sprintf("%s\n\n任务「%s」· 执行中 · 验收：未验收", body, view.Title)
	for _, report := range reports {
		// Simulate an old host committing the message, then losing its receipt.
		if _, err := b.Engine.BeginPilotHostDelivery(t.Context(), pid, report.ID); err != nil {
			t.Fatal(err)
		}
		b.Store.update(func() any {
			b.Store.exec("INSERT INTO messages(id,sessionId,role,text,createdAt) VALUES(?,?,?,?,?)", report.ID, report.ChannelRef, "assistant", legacy, now())
			return nil
		})
		if err := b.Engine.MarkPilotDeliveryUnknown(t.Context(), pid, report.ID); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if err := b.DeliverPilotReport(t.Context(), pid, pilot, report.ID); err != nil {
				t.Fatal("legacy committed delivery did not reconcile", err)
			}
		}
	}
	plain := b.Store.AddMessage(pilot, "assistant", legacy, nil)
	user := b.Store.AddMessage(ch.SessionID, "user", legacy, nil)
	for _, session := range []string{pilot, ch.SessionID} {
		for _, message := range objects(b.sessionSnapshot(session)["messages"]) {
			if message["id"] == plain["id"] || message["id"] == user["id"] {
				if message["text"] != legacy {
					t.Fatal("ordinary prose was trimmed")
				}
				continue
			}
			for _, report := range reports {
				if message["id"] == report.ID && message["text"] != body {
					t.Fatal("old host footer remained in snapshot", message["text"])
				}
			}
		}
	}
	page := b.roleChannelPage(t.Context(), ch.SessionID, "", 50)
	found := false
	for _, entry := range page["entries"].([]roleChannelEntry) {
		for _, report := range reports {
			if entry.Message != nil && entry.Message["id"] == report.ID {
				found = true
				if entry.Message["text"] != body {
					t.Fatal("old host footer remained in channel history")
				}
			}
		}
	}
	if !found {
		t.Fatal("historical channel report missing")
	}
	for _, report := range reports {
		for _, message := range objects(b.Store.Snapshot(report.ChannelRef)["messages"]) {
			if message["id"] == report.ID && message["text"] != legacy {
				t.Fatal("read projection rewrote durable source")
			}
		}
		foreign := ch.SessionID
		if report.ChannelRef == ch.SessionID {
			foreign = pilot
		}
		other, err := b.Engine.SuperHostReports(t.Context(), pid, foreign, []string{report.ID})
		if err != nil || len(other) != 0 {
			t.Fatal("report crossed its exact channel", other, err)
		}
	}
	if _, err := b.Engine.SuperHostReports(t.Context(), "foreign-project", pilot, []string{reports[0].ID}); err == nil {
		t.Fatal("foreign project accepted")
	}
	if pending, err := b.Engine.PendingPilotReports(t.Context(), pid); err != nil || len(pending) != 0 {
		t.Fatal("receipt recovery left reports pending", pending, err)
	}
}
