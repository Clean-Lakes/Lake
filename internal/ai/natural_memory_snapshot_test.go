package ai

import "testing"

func TestNaturalMemorySnapshotUsesCurrentUserAndIndependentConsent(t *testing.T) {
	text := "以后这个项目的报告固定用中文。"
	config := Config{MemoryProjectID: "project", NaturalMemory: &NaturalMemoryConsent{ProjectEnabled: true, ProjectEpoch: 1, PolicyVersion: 2}}
	input := TurnInput{UserText: text, StrategyMessageID: "real-message"}
	makeSession := func() *session {
		return &session{state: State{View: View{Session: "session", RootTurnID: "turn", TurnFinishedAt: "2026-10-28T08:00:00Z"}, History: []Message{{Role: "user", Content: text}, {Role: "assistant", Content: "已答复。"}}}}
	}
	for _, name := range []string{"normal", "ignore", "plan", "child", "ordinary", "failed-direct-save", "successful-direct-save"} {
		t.Run(name, func(t *testing.T) {
			s := makeSession()
			engine := &Engine{}
			c := config
			i := input
			want := true
			switch name {
			case "ignore":
				i.IgnoreProjectMemory = true
				want = false
			case "plan":
				c.ConversationMode = ModePlan
				want = false
			case "child":
				engine.worker = &agentWorker{}
				want = false
			case "ordinary":
				i.UserText = "请说明当前情况。"
				want = false
			case "failed-direct-save", "successful-direct-save":
				payload := `{"error":"explicit_memory_intent_required"}`
				if name == "successful-direct-save" {
					payload = `{"key":"legacy","revision":1}`
					want = false
				}
				s.state.History = []Message{{Role: "assistant", Calls: []Call{{ID: "attempt", Name: "save_project_memory"}}}, {Role: "tool", Name: "save_project_memory", CallID: "attempt", Content: payload}, {Role: "assistant", Content: "答复完成。"}}
			}
			engine.collectMemorySnapshot(s, c, i)
			if (len(s.state.MemoryOutbox) == 1) != want {
				t.Fatal("capture mismatch", name)
			}
			if want {
				snap := s.state.MemoryOutbox[0]
				if snap.SourceMessageID != "real-message" || snap.UserText != text || snap.Natural == nil || snap.LegacyExtraction || !ValidMemorySnapshot(snap) {
					t.Fatal("source or consent lost")
				}
			}
		})
	}
}
