package ai

import (
	"strings"
	"testing"
)

func TestStrategyLearningCapturesOnlyOptedInRealSignals(t *testing.T) {
	for _, mode := range []string{"correction", "failure", "ordinary", "unknown", "explicit_unknown", "not_executed", "tool_cancelled", "unpaired", "off", "worker", "workflow", "role", "sre", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			e := &Engine{}
			s := &session{state: State{View: View{Session: "session", RootTurnID: "turn", TurnStartedAt: timestamp(), TurnFinishedAt: timestamp()}, History: []Message{}, Checkpoints: []int{0}}}
			c := Config{MemoryProjectID: "project", Profile: "core", StrategyLearnEnabled: true, StrategyGlobalEpoch: 1, StrategyProjectEpoch: 2}
			input := TurnInput{StrategyMessageID: "message", UserText: "Check current status"}
			status := "completed"
			switch mode {
			case "correction":
				input.UserText = "以后请用中文回答。"
			case "off":
				c.StrategyLearnEnabled = false
				input.UserText = "以后请用中文回答。"
			case "worker":
				e.worker = &agentWorker{}
				input.UserText = "以后请用中文回答。"
			case "workflow":
				c.workflowMode = true
				input.UserText = "以后请用中文回答。"
			case "role":
				c.agentRole = "researcher"
				input.UserText = "以后请用中文回答。"
			case "sre":
				c.sreCoordinator = true
				input.UserText = "以后请用中文回答。"
			case "cancelled":
				status = "cancelled"
				input.UserText = "以后请用中文回答。"
			}
			if mode == "failure" || mode == "unknown" || mode == "explicit_unknown" || mode == "not_executed" || mode == "tool_cancelled" || mode == "unpaired" {
				result := `{"status":"failed","error":"raw-private-diagnostics"}`
				if mode == "unknown" {
					result = `{"error":"interrupted","outcome":"unknown; not replayed"}`
				}
				if mode == "explicit_unknown" {
					result = `{"status":"unknown","error":"unknown remote result"}`
				}
				if mode == "not_executed" {
					result = `{"status":"not_executed","error":"approval denied"}`
				}
				if mode == "tool_cancelled" {
					result = `{"status":"cancelled","error":"cancelled before execution"}`
				}
				if mode != "unpaired" {
					s.state.History = append(s.state.History, Message{Role: "assistant", Calls: []Call{{ID: "call", Name: "read"}}})
				}
				s.state.History = append(s.state.History, Message{Role: "tool", CallID: "call", Name: "read", Content: result})
			}
			e.collectStrategySnapshot(s, c, input, status)
			want := mode == "correction" || mode == "failure"
			if (len(s.state.StrategyOutbox) == 1) != want {
				t.Fatal("incorrect capture", mode, len(s.state.StrategyOutbox))
			}
			if want {
				snapshot := s.state.StrategyOutbox[0]
				if !ValidStrategySnapshot(snapshot) || snapshot.GlobalEpoch != 1 || snapshot.ProjectEpoch != 2 {
					t.Fatal("invalid sealed snapshot")
				}
				if strings.Contains(js(snapshot), "raw-private-diagnostics") {
					t.Fatal("raw tool output retained")
				}
				snapshot.UserText += "tamper"
				if ValidStrategySnapshot(snapshot) {
					t.Fatal("tampering undetected")
				}
			}
		})
	}
}
