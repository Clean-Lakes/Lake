package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

const presentationFailureLimit = 2
const presentationFallbackInstruction = "本轮自定义界面已两次未通过格式校验。停止调用工具，直接根据本轮已有资料输出中文 Markdown：先说明实际结果，再用标题、清单、表格或代码块呈现已取得的数据；客户端会自动生成对应界面。未取得的数据标为待确认。已有执行结果不受影响，不重新执行工作流、SSH 或其他命令，不声称展示失败就是任务执行失败。不要输出 UI JSON、工具参数或重复的失败说明。"

type presentationBudgetKey struct{}
type presentationBudget struct {
	mu       sync.Mutex
	failures int
}

func withPresentationBudget(ctx context.Context) context.Context {
	return context.WithValue(ctx, presentationBudgetKey{}, &presentationBudget{})
}

func (b *presentationBudget) exhausted() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.failures >= presentationFailureLimit
}

// Serialize presentation attempts across parallel tool calls. A budget belongs
// to one user turn, so a subsequent question can create or update UI normally.
// Only validation feedback counts; cancellation and operational errors retain
// their original behavior.
func runPresentationAttempt(ctx context.Context, run func() (string, error)) (string, error) {
	b, _ := ctx.Value(presentationBudgetKey{}).(*presentationBudget)
	if b == nil {
		return run()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if b.failures >= presentationFailureLimit {
		body, _ := json.Marshal(map[string]any{"displayed": false, "error": "presentation_unavailable", "message": presentationFallbackInstruction})
		return string(body), nil
	}
	out, err := run()
	if err != nil {
		return out, err
	}
	var result map[string]any
	if json.Unmarshal([]byte(out), &result) == nil && (result["error"] == "invalid_ui" || result["error"] == "invalid_report") {
		b.failures++
		if b.failures >= presentationFailureLimit {
			result["message"] = presentationFallbackInstruction
			body, _ := json.Marshal(result)
			out = string(body)
		}
	}
	return out, nil
}

// The final generation retains the agent's current messages, including actual
// tool results. Remove all tools after two invalid layouts: this is an enforced
// generation boundary rather than a request for the model to stop retrying.
type presentationModel struct{ base model.BaseChatModel }

func presentationFallbackInput(ctx context.Context, input []*schema.Message, opts []model.Option) ([]*schema.Message, []model.Option, bool) {
	b, _ := ctx.Value(presentationBudgetKey{}).(*presentationBudget)
	if b == nil || !b.exhausted() {
		return input, opts, false
	}
	messages := append([]*schema.Message(nil), input...)
	if len(messages) > 0 && messages[0].Role == schema.System {
		first := *messages[0]
		first.Content += "\n\n" + presentationFallbackInstruction
		messages[0] = &first
	} else {
		messages = append([]*schema.Message{schema.SystemMessage(presentationFallbackInstruction)}, messages...)
	}
	options := append([]model.Option(nil), opts...)
	options = append(options, model.WithTools(nil))
	return messages, options, true
}

func (m *presentationModel) Generate(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	input, opts, fallback := presentationFallbackInput(ctx, input, opts)
	answer, err := m.base.Generate(ctx, input, opts...)
	if err != nil || answer == nil || !fallback {
		return answer, err
	}
	// An endpoint may still return tool calls without having been offered tools.
	// Never let those calls reach the executor after presentation was disabled.
	clean := *answer
	clean.ToolCalls = nil
	if strings.TrimSpace(clean.Content) == "" {
		clean.Content = "自定义界面格式未通过校验，已有执行记录已保留。可以重新整理已有结果，客户端会自动展示文字、表格和代码。"
	}
	return &clean, nil
}

func (m *presentationModel) Stream(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	b, _ := ctx.Value(presentationBudgetKey{}).(*presentationBudget)
	if b != nil && b.exhausted() {
		answer, err := m.Generate(ctx, input, opts...)
		if err != nil {
			return nil, err
		}
		return schema.StreamReaderFromArray([]*schema.Message{answer}), nil
	}
	return m.base.Stream(ctx, input, opts...)
}
