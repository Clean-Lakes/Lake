package web

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/ai"
)

func (b *Server) reasoningSettings(ctx context.Context, id string) Object {
	b.Store.Session(id)
	model := b.Models.CachedCapacity(b.Models.Active())
	if model == nil {
		return Object{"levels": []string{}, "effort": ""}
	}
	options := b.sessionOptions(id)
	effort := stringOf(options["reasoningEffort"])
	if options["reasoningModelId"] != ai.ModelIdentity(*model) || !ai.ValidReasoningEffort(*model, effort) {
		effort = ""
	}
	c := ai.ReasoningSupport(*model)
	return Object{"modelId": ai.ModelIdentity(*model), "levels": c.Levels, "default": c.Default, "source": c.Source, "effort": effort}
}

func (b *Server) setReasoning(ctx context.Context, id string, data Object) Object {
	b.Store.Session(id)
	model := b.Models.CachedCapacity(b.Models.Active())
	if model == nil {
		fail(400, "尚未配置模型")
	}
	if data["modelId"] != ai.ModelIdentity(*model) {
		fail(409, "模型已切换，请重新选择思考级别")
	}
	effort, ok := data["effort"].(string)
	if !ok || !ai.ValidReasoningEffort(*model, effort) {
		fail(400, "当前模型不支持此思考级别")
	}
	b.configure(id, Object{"reasoningEffort": effort, "reasoningModelId": ai.ModelIdentity(*model)})
	return b.reasoningSettings(ctx, id)
}
