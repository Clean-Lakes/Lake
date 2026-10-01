package agent

import (
	"encoding/base64"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"strings"

	"github.com/cloudwego/eino/schema"
)

type ContextBudget struct {
	WindowTokens          int
	MaxOutputTokens       int
	KeepRecent            int
	AutoCompactTokenLimit int
	Force                 bool
}

type ContextItem struct {
	Message       *schema.Message
	SourceEventID uint64
	// Preserve keeps pending requests and attachments out of lossy summaries.
	Preserve bool
	// TaskState is set only by Lake for a carried checkpoint, never by quoted chat.
	TaskState *TaskState
	// Original user text excludes derived tool context and model-generated prompts.
	UserText string
}

type ContextSummary struct {
	Text           string
	SourceEventIDs []uint64
	ThroughSeq     uint64
	TokenEstimate  int
	TaskState      *TaskState
}

type PreparedContext struct {
	Messages        []*schema.Message
	Retained        []ContextItem
	Summary         *ContextSummary
	EstimatedTokens int
	Compacted       bool
}

func (b ContextBudget) inputLimit() (int, error) {
	if b.WindowTokens < 1024 || b.MaxOutputTokens < 1 || b.MaxOutputTokens >= b.WindowTokens || b.KeepRecent < 1 || b.AutoCompactTokenLimit < 0 || b.AutoCompactTokenLimit > b.WindowTokens-b.MaxOutputTokens {
		return 0, errors.New("invalid context budget")
	}
	return b.WindowTokens - b.MaxOutputTokens, nil
}

// EstimateMessageTokens estimates text and reserves visual capacity for images.
// Base64 is a transport encoding, not text consumed by the model tokenizer.
// This is a local budget estimate, not a provider-reported token count.
func EstimateMessageTokens(message *schema.Message) int {
	if message == nil {
		return 0
	}
	tokens := 16
	if len(message.UserInputMultiContent) == 0 {
		tokens += estimateTextTokens(message.Content)
	}
	for _, part := range message.UserInputMultiContent {
		tokens += estimateTextTokens(part.Text)
		if part.Image != nil {
			tokens += estimateImageTokens(part.Image)
		}
	}
	for _, call := range message.ToolCalls {
		tokens += 16 + estimateTextTokens(call.Function.Name) + estimateTextTokens(call.Function.Arguments)
	}
	return tokens
}

func estimateTextTokens(text string) int {
	ascii, nonASCII := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else {
			nonASCII++
		}
	}
	return (ascii+3)/4 + nonASCII*2
}

func estimateImageTokens(part *schema.MessageInputImage) int {
	// Bound the header read and never decode pixels or modify the attachment.
	// Formats without a supported header decoder receive the default reserve.
	if part.Base64Data == nil {
		return 2048
	}
	r := base64.NewDecoder(base64.StdEncoding, strings.NewReader(*part.Base64Data))
	config, _, err := image.DecodeConfig(io.LimitReader(r, 1024*1024))
	if err != nil || config.Width < 1 || config.Height < 1 {
		return 2048
	}
	w, h := float64(config.Width), float64(config.Height)
	if w > 2048 || h > 2048 {
		scale := 2048 / max(w, h)
		w, h = w*scale, h*scale
	}
	tiles := ((int(w) + 511) / 512) * ((int(h) + 511) / 512)
	return min(8192, 256+tiles*512)
}

func estimateContext(messages []*schema.Message) int {
	total := 0
	for _, message := range messages {
		total += EstimateMessageTokens(message)
	}
	return total
}
