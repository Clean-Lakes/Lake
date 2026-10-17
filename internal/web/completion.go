package web

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type draftCompletionRequest struct{ cancel context.CancelFunc }

func (b *Server) completeDraft(w http.ResponseWriter, r *http.Request, id string) {
	b.Store.Session(id)
	data := body(w, r, 12000)
	draft, ok := data["text"].(string)
	if !ok || !utf8.ValidString(draft) || strings.ContainsRune(draft, '\x00') || utf8.RuneCountInString(draft) > 2000 {
		fail(400, "补齐文本无效或过长")
	}
	model := b.Models.Active()
	if model == nil {
		reply(w, 200, Object{"suffix": ""})
		return
	}
	identity := ai.ModelIdentity(*model)
	if expected := stringOf(data["modelId"]); expected != "" && expected != identity {
		fail(409, "当前模型已变更")
	}
	if utf8.RuneCountInString(strings.TrimSpace(draft)) < 4 {
		reply(w, 200, Object{"suffix": "", "modelId": identity})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	request := &draftCompletionRequest{cancel: cancel}
	if old, loaded := b.draftCompletions.Swap(id, request); loaded {
		old.(*draftCompletionRequest).cancel()
	}
	defer func() { cancel(); b.draftCompletions.CompareAndDelete(id, request) }()
	recent := b.Store.read(func() any {
		return b.Store.rows("SELECT text FROM messages WHERE sessionId=? AND role='user' ORDER BY createdAt DESC,rowid DESC LIMIT 3", id)
	}).([]Object)
	history := []string{}
	for i := len(recent) - 1; i >= 0; i-- {
		history = append(history, stringOf(recent[i]["text"]))
	}
	suffix, err := ai.CompleteDraft(ctx, *model, draft, history)
	current := b.Models.Active()
	if err != nil || ctx.Err() != nil || current == nil || ai.ModelIdentity(*current) != identity {
		suffix = ""
	}
	reply(w, 200, Object{"suffix": suffix, "modelId": identity})
}
