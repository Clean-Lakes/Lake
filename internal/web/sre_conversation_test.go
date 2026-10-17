package web

import (
	"github.com/Clean-Lakes/Lake/internal/ai"
	"strings"
	"testing"
)

func TestSREShortFollowupsStayInNormalConversationWithoutAnActiveTask(t *testing.T) {
	b, h := fixture(t)
	session, resource := newSession(t, h)
	_, closeProvider := configureSREModel(t, b, h, session, resource, ai.SREPlanRevision{}, "")
	defer closeProvider()
	for _, message := range []string{"再试试", "?"} {
		apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": message}, 202)
		awaitQueueWorkers(t, b)
		tasks, err := b.Store.ListSRETasks(session, 20, "")
		if err != nil || len(tasks) != 0 {
			t.Fatal("ordinary followup started an SRE task", err)
		}
		messages := objects(b.Store.Snapshot(session)["messages"])
		last := messages[len(messages)-1]
		if last["role"] != "assistant" || stringOf(last["text"]) == "" || strings.Contains(stringOf(last["text"]), "请先用 @") {
			t.Fatal("followup did not receive a normal reply")
		}
	}
	view, err := b.Engine.Snapshot(session)
	if err != nil || view.Turns != 2 {
		t.Fatal("followups did not reach the model", err)
	}
}
