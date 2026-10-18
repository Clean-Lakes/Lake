package ai

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestModelSwitchCompactsCompletedTurnWithSmallHandoffAllowance(t *testing.T) {
	for _, longSummary := range []bool{false, true} {
		t.Run(map[bool]string{false: "short summary", true: "oversized summary"}[longSummary], func(t *testing.T) {
			summaries, replies := 0, 0
			model, close := fakeModel(t, func(_ int, body map[string]any) any {
				if body["model"] != "new-model" {
					t.Error("request did not use the newly selected model")
				}
				messages := arr(body["messages"])
				if strings.Contains(str(obj(messages[0])["content"]), "handoff summary") {
					summaries++
					if body["tools"] != nil || strings.Contains(js(messages), "知道了") {
						t.Error("summary exposed tools or included the current user turn")
					}
					text := "The earlier investigation is completed. Preserve its evidence; do not repeat the commands."
					if longSummary {
						text += strings.Repeat("中文引用\"\\\n", 2500)
					}
					return response(text)
				}
				replies++
				if !strings.Contains(str(obj(messages[len(messages)-1])["content"]), "[USER_MESSAGE]\n知道了") {
					t.Error("new model lost the current user message")
				}
				return response("好的，有需要随时继续。")
			})
			defer close()
			bridgeCalls := 0
			e := engineFor(t, model, func(context.Context, string, string, map[string]any, bool) (any, error) {
				bridgeCalls++
				return nil, nil
			})
			s, _ := e.get("case")
			c := s.state.Config
			c.MemoryEnabled, c.MultiAgentMode = true, "auto"
			c.Model.MaxOutput = 8192
			c.Model.Name = "new-model"
			c.Model.ContextLimit = 1000000
			if err := e.Configure("case", c); err != nil {
				t.Fatal(err)
			}
			budget := (c.Model.ContextWindow - c.Model.MaxOutput) * 2
			tools := len(js(e.sessionCatalog(context.Background(), "case", c)))
			base := []Message{{Role: "system", Content: Prompt(c) + "\n" + userLanguageReminder("知道了")}, {Role: "user", Content: "[LAKE_SESSION_CONTEXT]\n\n[USER_MESSAGE]\n知道了"}}
			contextBytes := budget - tools - historyCost(base) - 6000
			if contextBytes <= 0 {
				t.Fatal("fixture has no room for current context")
			}
			contextText := "[LAKE_SESSION_CONTEXT]\n" + strings.Repeat("x", contextBytes)
			oldHistory := []Message{
				{Role: "system", Content: "Earlier model system policy"},
				{Role: "user", Content: "Check the synthetic host; do not modify it."},
				{Role: "assistant", Calls: []Call{{ID: "completed-check", Name: "shell", Arguments: `{"command":"uptime"}`}}},
				{Role: "tool", CallID: "completed-check", Name: "shell", Content: `{"exitCode":0,"output":"synthetic recorded observation"}`},
				{Role: "assistant", Content: strings.Repeat("Completed investigation. ", 2000)},
			}
			s.state.History = oldHistory
			s.state.View.Cards = []Card{{ID: "evidence", Type: "operation", Content: oldHistory[3].Content, Status: "completed"}}
			rawCard := s.state.View.Cards[0]
			if err := e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "知道了", Context: contextText}); err != nil {
				t.Fatal("switching models blocked a short acknowledgement:", err)
			}
			h := s.state.History
			if summaries != 1 || replies != 1 || bridgeCalls != 0 || validHistory(h) != nil {
				t.Fatalf("unexpected replay or invalid handoff: summaries=%d replies=%d bridge=%d", summaries, replies, bridgeCalls)
			}
			if len(h) != 4 || !strings.Contains(h[2].Content, contextText) || !reflect.DeepEqual(s.state.View.Cards[0], rawCard) {
				t.Fatal("lost the full current turn or original operation record")
			}
			if historyCost(h[:len(h)-1])+tools > budget || !utf8.ValidString(h[1].Content) {
				t.Fatal("new model request still exceeds the budget or splits Unicode")
			}
			if longSummary && !strings.Contains(h[1].Content, "Omitted details are unknown") {
				t.Fatal("shortened handoff lacks an omission warning")
			}
		})
	}
}

func TestHandoffFitPreservesCurrentTurnAndToolPairing(t *testing.T) {
	current := longFirstTurn()[1:4]
	current[2].Content = `{"exitCode":7,"output":"Synthetic observation retained."}`
	system := Message{Role: "system", Content: "Keep permissions unchanged."}
	for _, margin := range []int{1200, 4000} {
		budget := historyCost(append([]Message{system}, current...)) + margin
		projection, summary, fits := fitHandoffContext(system, strings.Repeat("摘要\"\\\n", 4000), current, budget)
		if !fits || historyCost(projection) > budget || validHistory(projection) != nil {
			t.Fatal("bounded handoff cannot fit or invalidates tool pairing")
		}
		if !reflect.DeepEqual(projection[0], system) || !reflect.DeepEqual(projection[2:], current) || !utf8.ValidString(summary) {
			t.Fatal("handoff fitting changed retained policy, user text or tool calls")
		}
	}
	if _, _, fits := fitHandoffContext(system, "Summary", current, historyCost([]Message{system})); fits {
		t.Fatal("accepted an irreducible current turn above budget")
	}
}
