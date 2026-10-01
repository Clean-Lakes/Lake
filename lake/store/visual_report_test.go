package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
)

func TestVisualReportRedactsAllDisplayedFieldsAndSurvivesHistory(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CreateLake(ctx, "reports", "")
	if err != nil {
		t.Fatal(err)
	}
	conversation, err := s.CreateConversation(ctx, lake.Name)
	if err != nil {
		t.Fatal(err)
	}
	secret := "token=fixture-secret"
	report := agent.VisualReport{Title: secret, Summary: secret, Tone: "warning", Metrics: []agent.ReportMetric{{Label: secret, Value: secret, Tone: "unknown"}}, Charts: []agent.ReportChart{{Title: secret, Kind: "bar", Segments: []agent.ReportSegment{{Label: secret, Value: 8, Tone: "unknown"}}}}, Table: &agent.ReportTable{Title: secret, Columns: []string{secret}, Rows: []agent.ReportRow{{Cells: []string{secret}, Tone: "unknown"}}}, Findings: []agent.ReportFinding{{Title: secret, Detail: secret, NextStep: secret, Tone: "warning"}}, Sources: []string{secret}, Flow: &agent.ReportFlow{Nodes: []agent.ReportNode{{ID: secret, Label: secret, Status: "unknown", Detail: secret}}}}
	index := 0
	report.UI = &agent.ReportUI{Root: "sk-fixture-secret0123456789", Elements: map[string]agent.ReportUIElement{
		"sk-fixture-secret0123456789": {Type: "Card", Props: agent.ReportUIProps{Title: secret}, Children: []string{"metric", "chart", "finding", "table", "flow"}},
		"metric":                      {Type: "Metric", Props: agent.ReportUIProps{Index: &index}}, "chart": {Type: "Chart", Props: agent.ReportUIProps{Index: &index}}, "finding": {Type: "Finding", Props: agent.ReportUIProps{Index: &index}}, "table": {Type: "Table"}, "flow": {Type: "Flow"},
	}}
	body, _ := json.Marshal(report)
	payload, _ := json.Marshal(map[string]string{"report_id": "report-1", "report_json": string(body)})
	event, err := s.AppendAgentEvent(ctx, conversation.ID, AgentEventInput{Kind: "visual_report", Actor: "agent", Payload: payload})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(event.Payload), "fixture-secret") {
		t.Fatal("report leaked fixture secret")
	}
	if report.Table.Columns[0] != secret {
		t.Fatal("input mutated by redaction")
	}
	events, err := s.ListAgentEvents(ctx, conversation.ID, 0, 10)
	if err != nil || len(events) != 1 {
		t.Fatal("report lost from history", err)
	}
	var decoded struct {
		JSON string `json:"report_json"`
	}
	if json.Unmarshal(events[0].Payload, &decoded) != nil {
		t.Fatal("invalid persisted event")
	}
	checked, err := agent.ParseVisualReport([]byte(decoded.JSON))
	if err != nil || checked.Charts[0].Segments[0].Value != 8 || checked.Flow.Nodes[0].Status != "unknown" {
		t.Fatal("redaction changed data", err)
	}
	if checked.Flow.Nodes[0].ID != "node-1" {
		t.Fatal("untrusted graph identity retained")
	}
	if checked.UI == nil || checked.UI.Elements[checked.UI.Root].Props.Title != "[redacted]" || strings.Contains(checked.UI.Root, "fixture") {
		t.Fatal("UI labels or identities not redacted")
	}
	if _, err := checkedEventPayload("visual_report", json.RawMessage(`{"report_id":"r"}`)); err == nil {
		t.Fatal("missing report accepted")
	}
}
