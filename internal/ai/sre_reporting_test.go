package ai

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSRELongHandoffKeepsLaterResultsAndActualRecoveryBeforeSourceClipping(t *testing.T) {
	a := pilotRecoveryAttempt()
	a.StepID, a.Status, a.Result = "later-read", "succeeded", "真实替代文件计数完成"
	a.ReadRecoveries = []PilotReadRecovery{{FailedOperationID: "failed", ReplacementOperationIDs: []string{"replacement"}, Reason: "同目录真实替代采样"}}
	task := SRETask{Attempts: []SREStepAttempt{{ID: "large-first", StepID: "first", Result: strings.Repeat("大量原始内容", 5000)}, a}}
	text := sreHandoff(task)
	before, _, _ := strings.Cut(text, "Source detail preview")
	for _, want := range []string{"later-read", "真实替代文件计数完成", `"validReadRecoveryCount":1`, `"registeredReadRecoveryCount":1`, `"failedOperationId":"failed"`, "replacement"} {
		if !strings.Contains(before, want) {
			t.Fatalf("later recorded fact lost before detail clipping: %q", want)
		}
	}
	if len(text) > 16000 || !utf8.ValidString(text) || !strings.HasSuffix(text, "[TRUNCATED]") {
		t.Fatalf("handoff clipping broken: bytes=%d utf8=%v", len(text), utf8.ValidString(text))
	}
	// A registered but now invalid source must not be described as valid.
	task.Attempts[1].Evidence[0].SourceTruncated = true
	if overview := sreHandoffOverview(task); overview["validReadRecoveryCount"] != 0 || overview["registeredReadRecoveryCount"] != 1 {
		t.Fatalf("handoff invented a successful recovery: %v", overview)
	}
}

func TestSREHandoffBoundsOverviewWithoutLosingAggregateAudit(t *testing.T) {
	a := pilotRecoveryAttempt()
	a.StepID = strings.Repeat("大", 6000)
	a.ReadRecoveries = []PilotReadRecovery{{FailedOperationID: "failed", ReplacementOperationIDs: []string{"replacement"}, Reason: "真实替代"}}
	task := SRETask{Attempts: []SREStepAttempt{a}}
	overview := sreHandoffOverview(task)
	if len(js(overview)) > 7500 || overview["registeredReadRecoveryCount"] != 1 || overview["validReadRecoveryCount"] != 1 || len(sreHandoff(task)) > 16000 {
		t.Fatal("unbounded overview or dropped aggregate audit")
	}
}
