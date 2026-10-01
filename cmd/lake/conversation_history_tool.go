package main

import (
	"context"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/lake/store"
)

type conversationHistoryInput struct {
	Query  string `json:"query,omitempty" jsonschema:"description=检索本会话用户请求或助手回复中的关键词；留空读取最近历史"`
	Before int64  `json:"before,omitempty" jsonschema:"description=上一页返回的next_before游标，用于更早轮次"`
	TurnID string `json:"turn_id,omitempty" jsonschema:"description=返回的turn_id，用于读取特定轮次原文；不能与query或before同时使用"`
	Offset int    `json:"offset,omitempty" jsonschema:"description=读取特定轮次时使用其next_offset，首次为0"`
	Limit  int    `json:"limit,omitempty" jsonschema:"description=每页1到3轮，默认3"`
}

func newConversationHistoryTool(s *store.Store, conversationID string, inputTokens int) (tool.InvokableTool, error) {
	maxCharacters := min(1800, max(128, inputTokens/8))
	return utils.InferTool[conversationHistoryInput, store.ConversationHistoryPage](
		"lake_conversation_history", "只读检索当前会话已保存的历史原文，含失败请求与附件数量。摘要遗漏、用户指代旧内容或要求核对细节时使用。可按关键词检索，按游标看更早轮次，按turn_id及offset续读长原文。不能读取其他会话，不执行任务，不能从附件数量推断图片内容。",
		func(ctx context.Context, in conversationHistoryInput) (store.ConversationHistoryPage, error) {
			return s.ReadConversationHistory(ctx, conversationID, store.ConversationHistoryQuery{Query: in.Query, Before: in.Before, TurnID: in.TurnID, Offset: in.Offset, Limit: in.Limit}, maxCharacters)
		})
}
