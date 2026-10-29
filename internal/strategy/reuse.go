package strategy

import "strings"

type SelectionReason struct {
	Ref    RevisionRef `json:"ref"`
	Reason string      `json:"reason"`
	Score  int         `json:"score"`
}

func ComparableContent(text string) string {
	return strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
}
