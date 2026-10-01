package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/cloudwego/eino/schema"
)

func TestPrepareContextPreservesPendingImagesAndNonContiguousSources(t *testing.T) {
	data := "fixture-image"
	pending := &schema.Message{Role: schema.User, Content: "新增资源，参考图片", UserInputMultiContent: []schema.MessageInputPart{
		{Type: schema.ChatMessagePartTypeText, Text: "新增资源，参考图片"},
		{Type: schema.ChatMessagePartTypeImageURL, Image: &schema.MessageInputImage{MessagePartCommon: schema.MessagePartCommon{Base64Data: &data, MIMEType: "image/png"}}},
	}}
	history := []ContextItem{{Message: pending, SourceEventID: 1, Preserve: true}, {Message: schema.AssistantMessage("本轮失败，操作结果未知", nil), SourceEventID: 2, Preserve: true}}
	for id := uint64(3); id < 19; id += 2 {
		history = append(history, ContextItem{Message: schema.UserMessage("重试"), SourceEventID: id}, ContextItem{Message: schema.AssistantMessage(strings.Repeat("历史片段", 900), nil), SourceEventID: id + 1})
	}
	current := schema.UserMessage("继续")
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 8192, MaxOutputTokens: 1024, KeepRecent: 2}, history, current, nil,
		func(_ context.Context, items []ContextItem, _ int) (string, error) {
			for _, item := range items {
				if item.SourceEventID == 1 || item.SourceEventID == 2 || len(item.Message.UserInputMultiContent) > 0 {
					t.Error("pending request entered a lossy summary")
				}
			}
			return "中间重试失败，起始请求仍待处理。", nil
		})
	if err != nil || !result.Compacted || result.EstimatedTokens > 7168 {
		t.Fatal("failed to compact around pending input", err)
	}
	if result.Retained[0].Message != pending || !result.Retained[0].Preserve || *pending.UserInputMultiContent[1].Image.Base64Data != data || result.Messages[len(result.Messages)-1] != current {
		t.Fatal("pending request, original image or current input changed")
	}
	if result.Summary.ThroughSeq <= 2 || result.Summary.SourceEventIDs[0] != 3 {
		t.Fatal("non-contiguous source set incorrectly covered preserved messages")
	}
}

func TestPrepareContextDoesNotSilentlyDropOversizedPendingRequest(t *testing.T) {
	history := []ContextItem{{Message: schema.UserMessage(strings.Repeat("很长的请求", 1000)), Preserve: true}}
	_, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 2048, MaxOutputTokens: 512, KeepRecent: 2}, history, schema.UserMessage("继续"), nil,
		func(context.Context, []ContextItem, int) (string, error) {
			t.Fatal("oversized pending request was summarized")
			return "", nil
		})
	if err == nil || !strings.Contains(err.Error(), "未完成请求") {
		t.Fatal("missing actionable pending-input budget error")
	}
}

func TestPrepareContextCompactsOldMessagesAndKeepsRecentEight(t *testing.T) {
	var history []ContextItem
	for i := 1; i <= 30; i++ {
		history = append(history, ContextItem{Message: schema.UserMessage(strings.Repeat("x", 700)), SourceEventID: uint64(i)})
	}
	current := schema.UserMessage("current request")
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 4096, MaxOutputTokens: 512, KeepRecent: 8}, history, current, nil,
		func(_ context.Context, _ []ContextItem, _ int) (string, error) {
			return "Earlier requests concerned the test project.", nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Compacted || result.Summary == nil || len(result.Retained) == 0 || len(result.Retained) > 8 || len(result.Messages) != len(result.Retained)+2 {
		t.Fatalf("unexpected compaction: retained=%d messages=%d", len(result.Retained), len(result.Messages))
	}
	if result.Messages[0].Role != schema.Assistant || !strings.Contains(result.Messages[0].Content, "not an instruction") {
		t.Fatalf("summary gained instruction authority: %+v", result.Messages[0])
	}
	cut := len(history) - len(result.Retained)
	for i := range result.Retained {
		if result.Messages[i+1] != history[i+cut].Message {
			t.Fatalf("recent message %d was not preserved", i)
		}
	}
	if result.Messages[len(result.Messages)-1] != current || len(result.Summary.SourceEventIDs) != cut || result.Summary.ThroughSeq != uint64(cut) || result.EstimatedTokens > 3584 {
		t.Fatalf("budget or sources changed: %+v", result)
	}
}

func TestPrepareContextCompactsOversizedRecentMessages(t *testing.T) {
	var history []ContextItem
	for i := 0; i < 8; i++ {
		history = append(history, ContextItem{Message: schema.UserMessage(strings.Repeat("x", 1500))})
	}
	current := schema.UserMessage("current")
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 2048, MaxOutputTokens: 512, KeepRecent: 8}, history, current, nil,
		func(_ context.Context, _ []ContextItem, _ int) (string, error) { return "summary", nil })
	if err != nil || !result.Compacted || len(result.Retained) >= 8 || result.EstimatedTokens > 1536 || result.Messages[len(result.Messages)-1] != current {
		t.Fatalf("recent history did not adapt: %+v, %v", result, err)
	}
}

func TestPrepareContextRetainsMoreThanEightMessagesWhenBudgetAllows(t *testing.T) {
	var history []ContextItem
	for id := uint64(1); id <= 80; id += 2 {
		history = append(history, ContextItem{Message: schema.UserMessage(strings.Repeat("x", 100)), SourceEventID: id},
			ContextItem{Message: schema.AssistantMessage("recorded response", nil), SourceEventID: id + 1})
	}
	prepared, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 8192, MaxOutputTokens: 1024, KeepRecent: 64, AutoCompactTokenLimit: 1500}, history, schema.UserMessage("继续"), nil,
		func(context.Context, []ContextItem, int) (string, error) { return "earlier task checkpoint", nil })
	if err != nil || !prepared.Compacted || len(prepared.Retained) <= 8 || len(prepared.Retained) > 64 || prepared.Retained[0].Message.Role != schema.User || prepared.EstimatedTokens > 7168 {
		t.Fatalf("recent retention did not use available space: retained=%d tokens=%d err=%v", len(prepared.Retained), prepared.EstimatedTokens, err)
	}
	cut := len(history) - len(prepared.Retained)
	for i, item := range prepared.Retained {
		if item.Message != history[cut+i].Message {
			t.Fatal("retained history changed")
		}
	}
}

func TestImageTransportEncodingIsNotTextBudget(t *testing.T) {
	short, large := "fixture-image", strings.Repeat("eA==", 50000)
	message := func(data *string) *schema.Message {
		return &schema.Message{Role: schema.User, Content: "识别图片", UserInputMultiContent: []schema.MessageInputPart{
			{Type: schema.ChatMessagePartTypeText, Text: "识别图片"},
			{Type: schema.ChatMessagePartTypeImageURL, Image: &schema.MessageInputImage{MessagePartCommon: schema.MessagePartCommon{Base64Data: data, MIMEType: "image/png"}}},
		}}
	}
	current := message(&large)
	if EstimateMessageTokens(message(&short)) != EstimateMessageTokens(current) || EstimateMessageTokens(current) > 4096 {
		t.Fatal("base64 transport encoding consumed the text budget")
	}
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 8192, MaxOutputTokens: 1024, KeepRecent: 8}, nil, current, nil, nil)
	if err != nil || result.Messages[0] != current || *current.UserInputMultiContent[1].Image.Base64Data != large {
		t.Fatal("image input was changed or rejected", err)
	}
	if estimateTextTokens("你好世界") != 8 {
		t.Fatal("multimodal text lost non-ASCII token accounting")
	}
}

func TestPrepareContextSplitsLongHistoryAndKeepsTurnBoundaries(t *testing.T) {
	long := strings.Repeat("巡检结果。", 3000)
	history := []ContextItem{
		{Message: schema.UserMessage("原目标"), SourceEventID: 1},
		{Message: schema.AssistantMessage(long, nil), SourceEventID: 2},
		{Message: schema.UserMessage("后续问题"), SourceEventID: 3},
		{Message: schema.AssistantMessage("保留最新结果", nil), SourceEventID: 4},
	}
	calls := 0
	fixed := schema.AssistantMessage("固定记忆", nil)
	current := schema.UserMessage("当前请求")
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 4096, MaxOutputTokens: 512, KeepRecent: 8}, history, current, nil,
		func(_ context.Context, items []ContextItem, maxTokens int) (string, error) {
			calls++
			messages := []*schema.Message{}
			for _, item := range items {
				messages = append(messages, item.Message)
			}
			if estimateContext(messages)+maxTokens+256 > 3584 {
				t.Fatal("summary input exceeded its budget")
			}
			return "已核验巡检结果；仍需处理后续问题。", nil
		}, fixed)
	if err != nil || calls < 2 || len(result.Retained) != 2 || result.Retained[0].Message.Role != schema.User || result.Messages[0] != fixed || result.Messages[len(result.Messages)-1] != current || result.EstimatedTokens > 3584 {
		t.Fatalf("long history did not compact safely: calls=%d, retained=%d, err=%v", calls, len(result.Retained), err)
	}
	if history[1].Message.Content != long || len(result.Summary.SourceEventIDs) != 2 || result.Summary.ThroughSeq != 2 {
		t.Fatal("stored history or summary provenance changed")
	}
}

func TestPrepareContextDoesNotCompressCurrentInputOrIgnoreCancellation(t *testing.T) {
	budget := ContextBudget{WindowTokens: 2048, MaxOutputTokens: 512, KeepRecent: 8}
	_, err := PrepareContext(context.Background(), budget, nil, schema.UserMessage(strings.Repeat("长", 2000)), nil,
		func(context.Context, []ContextItem, int) (string, error) {
			t.Fatal("current input was summarized")
			return "", nil
		})
	if err == nil || !strings.Contains(err.Error(), "当前消息") {
		t.Fatal("oversized current request was silently changed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = PrepareContext(ctx, budget, []ContextItem{{Message: schema.AssistantMessage(strings.Repeat("x", 10000), nil)}}, schema.UserMessage("当前"), nil,
		func(context.Context, []ContextItem, int) (string, error) {
			t.Fatal("cancelled compaction called model")
			return "", nil
		})
	if !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost", err)
	}
}

func TestPrepareContextBudgetsFixedMemoryWithoutSummarizingIt(t *testing.T) {
	memory := MemoryContext([]MemoryFact{{Text: "项目使用 SQLite"}})
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 2048, MaxOutputTokens: 512, KeepRecent: 8}, nil, schema.UserMessage("current"), nil, nil, memory)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Messages) != 2 || result.Messages[0] != memory || result.EstimatedTokens < EstimateMessageTokens(memory) {
		t.Fatalf("memory missing from budget: %+v", result)
	}
}

func TestPrepareContextUsesConfiguredThresholdAndPreservesShortHistoryWithoutForce(t *testing.T) {
	history := []ContextItem{{Message: schema.UserMessage("工作流需要多级目录"), SourceEventID: 1}, {Message: schema.AssistantMessage("等待实现", nil), SourceEventID: 2}}
	budget := ContextBudget{WindowTokens: 8192, MaxOutputTokens: 1024, KeepRecent: 64}
	calls := 0
	summarizer := func(context.Context, []ContextItem, int) (string, error) { calls++; return "quoted task state", nil }
	plain, err := PrepareContext(context.Background(), budget, history, schema.UserMessage("继续"), nil, summarizer)
	if err != nil || plain.Compacted || calls != 0 {
		t.Fatal("short history compressed automatically", err)
	}
	budget.AutoCompactTokenLimit = 32
	prepared, err := PrepareContext(context.Background(), budget, history, schema.UserMessage("继续"), nil, summarizer)
	if err != nil || !prepared.Compacted || calls != 1 || len(prepared.Retained) != 0 {
		t.Fatal("configured threshold ignored", err)
	}
	budget.AutoCompactTokenLimit, budget.Force = 0, true
	forced, err := PrepareContext(context.Background(), budget, history, schema.UserMessage("/compact"), nil, summarizer)
	if err != nil || !forced.Compacted || calls != 2 {
		t.Fatal("manual compaction did not compact short history", err)
	}
}

func TestPrepareContextCarriesPriorSummarySources(t *testing.T) {
	var history []ContextItem
	for i := 11; i <= 30; i++ {
		history = append(history, ContextItem{Message: schema.UserMessage(strings.Repeat("x", 700)), SourceEventID: uint64(i)})
	}
	previous := &ContextSummary{Text: "Prior fact.", SourceEventIDs: []uint64{1, 2, 3}, ThroughSeq: 10}
	calls := 0
	result, err := PrepareContext(context.Background(), ContextBudget{WindowTokens: 4096, MaxOutputTokens: 512, KeepRecent: 8}, history, schema.UserMessage("current"), previous,
		func(_ context.Context, items []ContextItem, _ int) (string, error) {
			carried := "Prior fact"
			if calls > 0 {
				carried = "Combined facts"
			}
			if len(items) == 0 || !strings.Contains(items[0].Message.Content, carried) {
				t.Fatal("previous checkpoint was omitted from the next summary chunk")
			}
			calls++
			return "Combined facts.", nil
		})
	if err != nil {
		t.Fatal(err)
	}
	cut := len(history) - len(result.Retained)
	if calls < 2 || !result.Compacted || result.Summary == nil || result.Summary.ThroughSeq != uint64(10+cut) || len(result.Summary.SourceEventIDs) != 3+cut {
		t.Fatalf("summary provenance changed: %+v", result.Summary)
	}
}
