package ai

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestSREReportCorrectionKeepsLongInvestigationWithinTurnLimit(t *testing.T) {
	evidence := make([]AgentEvidence, 104)
	for i := range evidence {
		evidence[i] = AgentEvidence{
			ID:      fmt.Sprintf("ev_%032d", i),
			Excerpt: "private source text " + strings.Repeat("x", 2000),
			Success: i%2 == 0,
		}
	}
	report := SRERoleReport{Facts: []SREFact{{EvidenceIDs: []string{evidence[0].ID, evidence[2].ID}}}}
	prompt := sreReportCorrectionPrompt(report, evidence, errors.New("too many facts"))
	if len(prompt) >= len(js(evidence)) || len(prompt) > 10000 {
		t.Fatalf("correction still expands source evidence: prompt=%d full=%d", len(prompt), len(js(evidence)))
	}
	if !strings.Contains(prompt, evidence[0].ID) || !strings.Contains(prompt, evidence[2].ID) || strings.Contains(prompt, evidence[1].ID) || strings.Contains(prompt, "private source text") {
		t.Fatal("correction catalog lost owned IDs or exposed evidence excerpts")
	}
	if err := (TurnInput{UserText: prompt}).validate(); err != nil {
		t.Fatal("bounded correction rejected as invalid chat message", err)
	}
}
