package agent

import (
	"encoding/json"
	"testing"
)

func reportUITestFixture() VisualReport {
	index := 0
	return VisualReport{Title: "健康结果", Summary: "有一项待确认", Tone: "warning", Metrics: []ReportMetric{{Label: "待确认", Value: "8", Tone: "unknown"}}, Findings: []ReportFinding{{Title: "缺少健康检查", Detail: "需要核对可用性", Tone: "warning"}}, UI: &ReportUI{Root: "root", Elements: map[string]ReportUIElement{
		"root":   {Type: "Tabs", Props: ReportUIProps{Labels: []string{"概览", "异常"}}, Children: []string{"metric", "finding"}},
		"metric": {Type: "Metric", Props: ReportUIProps{Index: &index}}, "finding": {Type: "Finding", Props: ReportUIProps{Index: &index}},
	}}}
}

func TestReportUICatalogRejectsInvalidTreesAndHiddenFacts(t *testing.T) {
	if err := reportUITestFixture().Validate(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"unknown", "cycle", "missing", "shared", "hidden", "labels", "index", "props", "depth"} {
		t.Run(name, func(t *testing.T) {
			r := reportUITestFixture()
			root := r.UI.Elements["root"]
			switch name {
			case "unknown":
				r.UI.Elements["metric"] = ReportUIElement{Type: "Script"}
			case "cycle":
				root.Children = []string{"root", "finding"}
				r.UI.Elements["root"] = root
			case "missing":
				root.Children = []string{"missing", "finding"}
				r.UI.Elements["root"] = root
			case "shared":
				root.Children = []string{"metric", "metric"}
				r.UI.Elements["root"] = root
			case "hidden":
				delete(r.UI.Elements, "finding")
				root.Type = "Stack"
				root.Props = ReportUIProps{}
				root.Children = []string{"metric"}
				r.UI.Elements["root"] = root
			case "labels":
				root.Props.Labels = []string{"只有一页"}
				r.UI.Elements["root"] = root
			case "index":
				index := 99
				r.UI.Elements["metric"] = ReportUIElement{Type: "Metric", Props: ReportUIProps{Index: &index}}
			case "props":
				r.UI.Elements["metric"] = ReportUIElement{Type: "Table", Props: ReportUIProps{Title: "多余字段"}}
			case "depth":
				for i, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
					child := "root"
					if i > 0 {
						child = string(rune('a' + i - 1))
					}
					r.UI.Elements[id] = ReportUIElement{Type: "Stack", Children: []string{child}}
					r.UI.Root = id
				}
			}
			if r.Validate() == nil {
				t.Fatal("invalid UI accepted")
			}
		})
	}
	r := reportUITestFixture()
	encoded, _ := json.Marshal(r)
	var body map[string]any
	json.Unmarshal(encoded, &body)
	ui := body["ui"].(map[string]any)
	elements := ui["elements"].(map[string]any)
	elements["metric"].(map[string]any)["on"] = map[string]any{"press": "execute"}
	encoded, _ = json.Marshal(body)
	if _, err := ParseVisualReport(encoded); err == nil {
		t.Fatal("executable action accepted")
	}
}
