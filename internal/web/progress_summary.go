package web

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

type progressSummaryState struct {
	turn, key, text string
	busy, failed    bool
	attempted       time.Time
}

// Only current-turn, completed assistant milestones and operation metadata enter
// the side call. Raw tool output, arguments, thinking and previous turns do not.
func progressSummaryInput(view ai.View) string {
	if view.TurnStartedAt == "" {
		return ""
	}
	start, err := time.Parse(time.RFC3339Nano, view.TurnStartedAt)
	if err != nil {
		return ""
	}
	lines := []string{"会话状态：" + view.Status}
	for _, card := range view.Cards {
		at, err := time.Parse(time.RFC3339Nano, card.At)
		if err != nil || at.Before(start) {
			continue
		}
		var line string
		switch card.Type {
		case "message":
			if card.Status != "completed" {
				continue
			}
			line = strings.TrimSpace(card.Content)
		case "operation", "shell":
			line = card.Title + "：" + card.Status
			if data, ok := card.Data.(map[string]any); ok {
				line += " · " + stringOf(data["target"])
			}
		}
		if line == "" || sessionTitleSecrets.MatchString(line) {
			continue
		}
		chars := []rune(line)
		if len(chars) > 600 {
			line = string(chars[:600]) + "…"
		}
		lines = append(lines, line)
	}
	if len(lines) < 2 {
		return ""
	}
	// Retain recent evidence, with a fixed upper bound independent of session size.
	if len(lines) > 17 {
		lines = append(lines[:1], lines[len(lines)-16:]...)
	}
	if view.Question != nil {
		lines = append(lines, "当前等待用户回答，不能继续该步骤。")
	}
	if view.Pending != nil || len(view.PendingApprovals) > 0 {
		lines = append(lines, "当前等待用户批准，尚未执行待批操作。")
	}
	return strings.Join(lines, "\n")
}

func cleanProgressSummary(raw, input string) string {
	text := strings.Join(strings.Fields(raw), " ")
	if text == "" || len([]rune(text)) > 160 || sessionTitleSecrets.MatchString(text) {
		return ""
	}
	// Reject a copied stage even when wrapped in a label or other boilerplate.
	normalized := progressComparable(text)
	for _, line := range strings.Split(input, "\n") {
		line = progressComparable(line)
		if len([]rune(line)) >= 16 && strings.Contains(normalized, line) {
			return ""
		}
	}
	return text
}

// Ignore Markdown, punctuation and whitespace when detecting a copied paragraph.
func progressComparable(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, text)
}

func (b *Server) progressSummaryRoute(w http.ResponseWriter, r *http.Request, id string) {
	data := body(w, r, 4096)
	turn := stringOf(data["turnStartedAt"])
	reply(w, 200, b.summarizeProgress(r.Context(), id, turn, func() (ai.View, error) { return b.Engine.Snapshot(id) }))
}

func (b *Server) summarizeProgress(ctx context.Context, id, turn string, load func() (ai.View, error)) Object {
	view, err := load()
	aiFailure(err)
	if turn == "" || turn != view.TurnStartedAt || !set("running waiting_approval waiting_question")[view.Status] {
		return Object{"text": "", "pending": false}
	}
	// Online correction already owns a durable, bounded model budget. Keep the
	// ordinary resource/milestone UI, but do not start a second summary request
	// outside that budget. A historical completed report does not block a new turn.
	for _, card := range view.Cards {
		if card.Type == "strategy_correction" && (card.Status == "running" || view.RootTurnID != "" && stringOf(object(card.Data)["turnId"]) == view.RootTurnID) {
			return Object{"text": "", "pending": false, "reason": "bounded_strategy_correction"}
		}
	}
	input := progressSummaryInput(view)
	model := b.Models.Active()
	if input == "" || model == nil {
		return Object{"text": "", "pending": false}
	}
	key := fmt.Sprintf("%x", sha256.Sum256([]byte(ai.ModelIdentity(*model)+"\n"+turn+"\n"+input)))
	b.progressSummaryMu.Lock()
	if b.progressSummaries == nil {
		b.progressSummaries = make(map[string]*progressSummaryState)
	}
	state := b.progressSummaries[id]
	if state == nil || state.turn != turn {
		// Bounded, ephemeral cache. Evict only idle records; in-flight calls own theirs.
		if len(b.progressSummaries) >= 64 {
			for session, cached := range b.progressSummaries {
				if !cached.busy {
					delete(b.progressSummaries, session)
					break
				}
			}
		}
		if len(b.progressSummaries) >= 64 {
			b.progressSummaryMu.Unlock()
			return Object{"text": "", "pending": true}
		}
		state = &progressSummaryState{turn: turn}
		b.progressSummaries[id] = state
	}
	previous := state.text
	if state.key == key && (!state.failed || time.Since(state.attempted) < 30*time.Second) || state.busy || time.Since(state.attempted) < 8*time.Second || b.progressRunning >= 2 {
		pending := state.key != key || state.busy
		b.progressSummaryMu.Unlock()
		return Object{"text": previous, "pending": pending}
	}
	state.busy = true
	state.attempted = time.Now()
	b.progressRunning++
	b.progressSummaryMu.Unlock()
	defer func() {
		b.progressSummaryMu.Lock()
		state.busy = false
		b.progressRunning--
		b.progressSummaryMu.Unlock()
	}()
	modelCopy := *model
	modelCopy.MaxOutput = 1024
	// Summarisation should not inherit an expensive main-task thinking level.
	// Only choose a low effort actually advertised for this model.
	for _, effort := range []string{"none", "minimal", "low"} {
		if ai.ValidReasoningEffort(modelCopy, effort) {
			modelCopy.ReasoningEffort = effort
			break
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	output, _, err := b.Engine.GenerateProgressSummary(ctx, modelCopy, input)
	summary := ""
	if err == nil && ctx.Err() == nil {
		summary = cleanProgressSummary(output, input)
	}
	// Never publish a completion for an obsolete turn or obsolete evidence.
	latest, latestErr := load()
	active := b.Models.Active()
	current := active != nil && ai.ModelIdentity(*active) == ai.ModelIdentity(*model) && latestErr == nil && latest.TurnStartedAt == turn && progressSummaryInput(latest) == input
	b.progressSummaryMu.Lock()
	if current && b.progressSummaries[id] == state {
		state.key = key
		state.failed = summary == ""
		if summary != "" {
			state.text = summary
		}
		previous = state.text
	}
	b.progressSummaryMu.Unlock()
	if !current {
		previous = ""
	}
	return Object{"text": previous, "pending": !current}
}
