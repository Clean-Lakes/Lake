package strategy

import (
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const MaxSelectedAssets = 3
const MaxAssetPromptBytes = 4096

// ReusePolicy is immutable revision data. General is restricted to preferences;
// conditions/evidence prose remains a user note, never an executable predicate.
type ReusePolicy struct {
	Keywords    []string `json:"keywords"`
	General     bool     `json:"general"`
	ValidUntil  string   `json:"validUntil"`
	NeedsReview bool     `json:"needsReview"`
}

func (p ReusePolicy) Validate(kind AssetKind) error {
	if p.General && kind != UserPreference && kind != ReportGuidance {
		return errors.New("only preferences may apply generally")
	}
	if len(p.Keywords) > 8 {
		return errors.New("too many keywords")
	}
	seen := map[string]bool{}
	for _, word := range p.Keywords {
		normalized := strings.ToLower(word)
		if strings.TrimSpace(word) != word || utf8.RuneCountInString(word) < 2 || len(word) > 64 || !utf8.ValidString(word) || seen[normalized] || strings.ContainsAny(word, "\r\n\t") {
			return errors.New("invalid keyword")
		}
		seen[normalized] = true
	}
	if p.ValidUntil != "" {
		if _, err := time.Parse(time.RFC3339, p.ValidUntil); err != nil {
			return errors.New("invalid validity time")
		}
	}
	return nil
}
func keywordMatch(text, word string) bool {
	if word == "" {
		return false
	}
	text, word = strings.ToLower(text), strings.ToLower(word)
	ascii := true
	for _, r := range word {
		if r > 127 {
			ascii = false
			break
		}
	}
	for offset := 0; offset <= len(text); {
		i := strings.Index(text[offset:], word)
		if i < 0 {
			return false
		}
		i += offset
		if !ascii {
			return true
		}
		boundary := func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' }
		left := i == 0
		if !left {
			r, _ := utf8.DecodeLastRuneInString(text[:i])
			left = boundary(r)
		}
		end := i + len(word)
		right := end == len(text)
		if !right {
			r, _ := utf8.DecodeRuneInString(text[end:])
			right = boundary(r)
		}
		if left && right {
			return true
		}
		offset = i + len(word)
	}
	return false
}

// Relevance never executes model/tool code and stores no task/keyword text.
func (p ReusePolicy) Relevance(task string) (int, string) {
	score := 0
	for _, word := range p.Keywords {
		if keywordMatch(task, word) {
			score++
		}
	}
	if score > 0 {
		return score, "task_keyword"
	}
	if p.General {
		return 0, "explicit_general"
	}
	return 0, "not_relevant"
}

type SelectionReason struct {
	Ref    RevisionRef `json:"ref"`
	Reason string      `json:"reason"`
	Score  int         `json:"score"`
}

func BoundedTask(text string) string {
	if len(text) <= 8192 {
		return text
	}
	end := 8192
	for end > 0 && !utf8.ValidString(text[:end]) {
		end--
	}
	return text[:end]
}

func ComparableContent(text string) string {
	return strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
}
