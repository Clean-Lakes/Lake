package ai

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func longFirstTurn() []Message {
	h := []Message{{Role: "system", Content: "Answer in the user's language."}, {Role: "user", Content: "[USER_MESSAGE]\n新k8s集群状态如何"}}
	for i, id := range []string{"first", "second", "latest"} {
		h = append(h, Message{Role: "assistant", Content: "已检查节点", Calls: []Call{{ID: id, Name: "shell", Arguments: `{"asset_ref":"node","command":"kubectl get nodes"}`}}}, Message{Role: "tool", Name: "shell", CallID: id, Content: js(map[string]any{"output": strings.Repeat("节点 Ready；只是测试数据。", []int{8000, 8000, 100}[i]), "exitCode": 0})})
	}
	return h
}

func TestFirstTurnCompactsAtCompleteBatchWithoutReplayingTools(t *testing.T) {
	summaries := 0
	model, close := fakeModel(t, func(_ int, b map[string]any) any {
		summaries++
		if b["tools"] != nil {
			t.Error("compaction can execute tools")
		}
		if len(js(b["messages"])) > (64000-1024)*2 {
			t.Error("summary request exceeds budget")
		}
		return response("前两个批次已经完成；保留节点目标，继续分析最新原始结果。不重放命令。")
	})
	defer close()
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	h := longFirstTurn()
	s.state.History = h
	s.state.Checkpoints = []int{0}
	s.state.View.Cards = []Card{{ID: "raw", Type: "operation", Content: h[3].Content, Status: "completed"}}
	raw := s.state.View.Cards[0].Content
	if err := e.compact(context.Background(), s, s.state.Config, true); err != nil {
		t.Fatal(err)
	}
	after, _ := e.History("case")
	if summaries != 1 || validHistory(after) != nil || len(after) != 5 {
		t.Fatalf("invalid retained batch: summaries=%d len=%d", summaries, len(after))
	}
	if !reflect.DeepEqual(after[2], h[1]) {
		t.Fatal("original user question lost")
	}
	if !reflect.DeepEqual(after[3:], h[6:]) {
		t.Fatal("latest batch or call identifiers changed")
	}
	if s.state.View.Cards[0].Content != raw {
		t.Fatal("raw operation record changed")
	}
	if historyCost(after)+len(js(e.sessionCatalog(context.Background(), "case", s.state.Config))) >= (model.ContextWindow-model.MaxOutput)*2 {
		t.Fatal("still above budget")
	}
	// The same user turn can grow again after a checkpoint. It must still use
	// batch boundaries instead of repeatedly summarizing only the old handoff.
	more := longFirstTurn()
	for i := 2; i < len(more); i++ {
		for j := range more[i].Calls {
			more[i].Calls[j].ID += "-continued"
		}
		if more[i].CallID != "" {
			more[i].CallID += "-continued"
		}
	}
	s.state.History = append(after, more[2:]...)
	if err := e.compact(context.Background(), s, s.state.Config, true); err != nil {
		t.Fatal(err)
	}
	if summaries != 2 || len(s.state.History) != 5 || !reflect.DeepEqual(s.state.History[2], h[1]) || validHistory(s.state.History) != nil {
		t.Fatal("same turn failed to compact again")
	}
}

func TestOversizedSingleBatchUsesMarkedPreviewPreservingExitCodeAndUnicode(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any {
		t.Error("unnecessary summary/model call")
		return response("unused")
	})
	defer close()
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	h := longFirstTurn()[:4]
	h[3].Content = js(map[string]any{"output": strings.Repeat("中文故障输出", 50000), "exitCode": 7, "asset_ref": "node"})
	s.state.History = h
	s.state.View.Cards = []Card{{ID: "raw", Type: "operation", Content: h[3].Content, Status: "completed"}}
	if err := e.compact(context.Background(), s, s.state.Config, false); err != nil {
		t.Fatal(err)
	}
	after, _ := e.History("case")
	if validHistory(after) != nil || !utf8.ValidString(after[3].Content) {
		t.Fatal("invalid projected history")
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(after[3].Content), &result); err != nil {
		t.Fatal(err)
	}
	if result["context_truncated"] != true || num(result["exitCode"], 0) != 7 || str(result["asset_ref"]) != "node" {
		t.Fatal("missing omission/source/error metadata")
	}
	if s.state.View.Cards[0].Content != h[3].Content {
		t.Fatal("full raw operation record was lost")
	}
	if after[1].Content != h[1].Content || !reflect.DeepEqual(after[2].Calls, h[2].Calls) {
		t.Fatal("question or call changed")
	}
}

func TestFirstTurnSummaryFailureLeavesHistoryAndCheckpointsUntouched(t *testing.T) {
	model, close := fakeModel(t, func(_ int, _ map[string]any) any {
		return map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "discard"}, "finish_reason": "length"}}}
	})
	defer close()
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	h := longFirstTurn()
	s.state.History = h
	s.state.Checkpoints = []int{0}
	if err := e.compact(context.Background(), s, s.state.Config, true); !errors.Is(err, ErrModelOutputLimit) {
		t.Fatalf("expected summary failure: %v", err)
	}
	if !reflect.DeepEqual(s.state.History, h) || !reflect.DeepEqual(s.state.Checkpoints, []int{0}) {
		t.Fatal("failed compaction modified original state")
	}
}

func TestChildSummaryFitsSixteenKWindowWithLongAssignment(t *testing.T) {
	summaries := 0
	model, close := fakeModel(t, func(_ int, b map[string]any) any {
		summaries++
		if len(js(b["messages"])) > (16000-2048)*2 {
			t.Error("summary request exceeds child input allocation")
		}
		return response("保留调查目标及已采集证据，继续分析最后一批。")
	})
	defer close()
	e := engineFor(t, model, nil)
	s, _ := e.get("case")
	c := s.state.Config
	c.Model.ContextWindow = 16000
	c.Model.MaxOutput = 2048
	s.state.Config = c
	_, workers := budgetWorkers("verify")
	workers[0].parent = e
	e.worker = workers[0]
	h := longFirstTurn()
	h[1].Content += strings.Repeat("scope ", 1500)
	s.state.History = h
	if err := e.compact(context.Background(), s, c, true); err != nil {
		t.Fatal("child could not summarize after collected evidence", err)
	}
	if summaries != 1 || validHistory(s.state.History) != nil || s.state.History[2].Content != h[1].Content {
		t.Fatal("child assignment or tool pairing was lost")
	}
}

func TestLanguageReminderSurvivesEnglishToolResults(t *testing.T) {
	model, close := fakeModel(t, func(n int, b map[string]any) any {
		messages := arr(b["messages"])
		prompt := str(obj(messages[0])["content"])
		if !strings.Contains(prompt, "新k8s集群状态如何") || !strings.Contains(prompt, "进度说明") || !strings.Contains(prompt, "previous assistant replies") || !strings.Contains(prompt, "Current turn response language: Chinese") {
			t.Error("missing per-turn language guidance")
		}
		if n == 1 {
			return response("正在检查。", Call{"lookup", "list_assets", `{}`})
		}
		return response("检查已完成。")
	})
	defer close()
	e := engineFor(t, model, nil)
	if err := e.ExecuteTurn(context.Background(), "case", TurnInput{UserText: "新k8s集群状态如何", Context: "[LAKE_SESSION_CONTEXT]\nEnglish metadata is not the user question"}); err != nil {
		t.Fatal(err)
	}
	h, _ := e.History("case")
	if !strings.Contains(h[1].Content, "[USER_MESSAGE]\n新k8s集群状态如何") {
		t.Fatal("actual user text lacks a language boundary")
	}
}

func TestLanguageReminderRespectsExplicitLanguageAndOtherScripts(t *testing.T) {
	if text := userLanguageReminder("请用英文检查新k8s集群"); !strings.Contains(text, "Unless this user explicitly requests another language") || !strings.Contains(text, "请用英文") {
		t.Fatal("explicit language request was lost")
	}
	for _, question := range []string{"Check the new k8s cluster", "新しい集群の状態は？", "集群 상태를 확인해 주세요"} {
		if strings.Contains(userLanguageReminder(question), "Current turn response language: Chinese") {
			t.Fatal("unrelated user language forced to Chinese")
		}
	}
}

func TestSummaryFitsBetweenJSONCeilingAndHistoryFloor(t *testing.T) {
	history := []Message{{Role: "user", Content: strings.Repeat("explicit constraint; ", 1800)}}
	for i := 0; i < 8; i++ {
		id := string(rune('a' + i))
		history = append(history, Message{Role: "assistant", Calls: []Call{{ID: id, Name: "shell", Arguments: `{"command":"read-only observation"}`}}}, Message{Role: "tool", CallID: id, Content: js(map[string]any{"output": strings.Repeat("\\\"引用\"", 3000), "exitCode": 0})})
	}
	prompt := "Create a handoff summary. Preserve user constraints and completed observations."
	budget := 50000
	high := budget - len(prompt) - 1024
	prefix, fits := fitToolContext(summaryMessages(history), high)
	if !fits || historyCost([]Message{{Role: "system", Content: prompt}, {Role: "user", Content: js(prefix)}}) <= budget {
		t.Fatal("fixture must reproduce JSON serialization overflow")
	}
	if _, fits = fitToolContext(summaryMessages(history), high/2); fits {
		t.Fatal("fixture must reproduce the skipped intermediate fit interval")
	}
	messages, fits := fitSummaryInput(history, prompt, budget)
	if !fits || historyCost(messages) > budget {
		t.Fatal("valid summary fit was skipped")
	}
	if !strings.Contains(messages[1].Content, history[0].Content) {
		t.Fatal("user constraints changed")
	}
}
