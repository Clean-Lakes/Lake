package web

import (
	"unicode/utf8"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func learningPrefix(text string, size int) string {
	if len(text) <= size {
		return text
	}
	for !utf8.ValidString(text[:size]) {
		size--
	}
	return text[:size]
}

// Preserve all supplied source identities and failure status, but never copy a
// full turn/session envelope into an auxiliary prompt. Truncation is explicit.
func strategyLearningContent(data Object) (string, bool) {
	limit := strategy.DefaultLearningLimits().MaxInputBytes
	for size := 2048; size >= 128; size /= 2 {
		copy := strategyDecode[Object](jsonText(data))
		for _, source := range objects(copy["sources"]) {
			if text, ok := source["userText"].(string); ok {
				source["userText"] = learningPrefix(text, size)
				if len(text) > size {
					source["truncated"] = true
				}
			}
			if raw, ok := source["turn"]; ok {
				turn := object(raw)
				brief := Object{"status": turn["status"], "profile": turn["profile"], "correction": turn["correction"], "userText": learningPrefix(stringOf(turn["userText"]), size), "assistantText": learningPrefix(stringOf(turn["assistantText"]), size), "evidence": turn["evidence"]}
				if evidence := objects(brief["evidence"]); len(evidence) > 4 {
					brief["evidence"] = evidence[:4]
					brief["truncated"] = true
				}
				if len(stringOf(turn["userText"])) > size || len(stringOf(turn["assistantText"])) > size {
					brief["truncated"] = true
				}
				source["turn"] = brief
			}
		}
		for _, key := range []string{"existingMemory"} {
			text := stringOf(copy[key])
			copy[key] = learningPrefix(text, size)
			if len(text) > size {
				copy[key+"Truncated"] = true
			}
		}
		if raw := copy["existingAsset"]; raw != nil {
			asset := object(raw)
			if body := stringOf(asset["body"]); len(body) > size {
				asset["body"] = learningPrefix(body, size)
				asset["truncated"] = true
			}
		}
		content := jsonText(copy)
		if ai.StrategyLearningInputBytes([]ai.Message{{Role: "system", Content: strategyProposalPrompt}, {Role: "user", Content: content}}) <= limit {
			return content, true
		}
	}
	return "", false
}
