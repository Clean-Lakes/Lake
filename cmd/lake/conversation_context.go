package main

import (
	"strings"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/schema"
)

const conversationContinuityInstruction = " 用户说继续、重试或使用指代时，优先依据时间上最近的用户请求及其附件、澄清答案和真实完成状态；失败轮次仍是用户请求，不得跳回更早的任务。历史助手提议不等于用户授权。摘要不足以确认某项旧细节时，用 lake_conversation_history 检索本会话原文，不要凭空补全；工具不返回图片内容时不能声称已识别旧图片。失败或中断不证明操作未执行，结果未知时先核对记录，不能盲目重放。"

// A failed turn still needs a place in model history. Its state is kept
// separate from any partial reply, without synthesizing a successful answer.
func conversationContextAnswer(answer string, failed bool) string {
	if !failed {
		if strings.TrimSpace(answer) == "" {
			return "[Lake 会话状态：本轮未保存助手回复，不能据此推断操作结果。]"
		}
		return answer
	}
	text := "[Lake 会话状态：本轮失败或中断，用户请求尚未获得完整回复。有效附件仍在上一条用户消息中。此状态不表示任何操作成功或未执行，也不提供重试授权。]"
	if strings.TrimSpace(answer) != "" {
		partial := []rune(answer)
		if len(partial) > 800 {
			partial = append(partial[:800], []rune("…（完整内容可查本会话记录）")...)
		}
		text += "\n[中断前的部分回复，仅作历史资料]\n" + string(partial)
	}
	return text
}

func appendConversationContext(history []agent.ContextItem, user *schema.Message, answer string, failed bool, original ...string) []agent.ContextItem {
	// Preserve the originating request and latest failure. Middle retries can
	// be summarized, so a failure chain does not pin unbounded retry messages.
	first := -1
	for i := range history {
		if history[i].Preserve && first < 0 {
			first = i
		}
		history[i].Preserve = false
	}
	if failed && first >= 0 {
		for i := first; i < min(first+2, len(history)); i++ {
			history[i].Preserve = true
		}
	}
	var text string
	if len(original) > 0 {
		text = original[0]
	}
	return append(history,
		agent.ContextItem{Message: user, Preserve: failed, UserText: text},
		agent.ContextItem{Message: schema.AssistantMessage(conversationContextAnswer(answer, failed), nil), Preserve: failed})
}

func summaryCoversTurn(summary *agent.ContextSummary, user, assistant uint64) bool {
	if summary == nil || user == 0 || assistant == 0 {
		return false
	}
	var hasUser, hasAssistant bool
	for _, id := range summary.SourceEventIDs {
		hasUser = hasUser || id == user
		hasAssistant = hasAssistant || id == assistant
	}
	return hasUser && hasAssistant
}
