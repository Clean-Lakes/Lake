package agent

import (
	"errors"
	"regexp"
)

// ReportUI is a bounded subset of json-render's root/elements format. Props
// refer to validated report data; executable actions and arbitrary markup are
// not part of this catalog.
type ReportUI struct {
	Root     string                     `json:"root"`
	Elements map[string]ReportUIElement `json:"elements"`
}
type ReportUIElement struct {
	Type     string        `json:"type" jsonschema:"enum=Stack,enum=Grid,enum=Card,enum=Tabs,enum=Accordion,enum=Metric,enum=Chart,enum=Finding,enum=Table,enum=Flow"`
	Props    ReportUIProps `json:"props"`
	Children []string      `json:"children,omitempty"`
}
type ReportUIProps struct {
	Title   string   `json:"title,omitempty"`
	Columns int      `json:"columns,omitempty"`
	Index   *int     `json:"index,omitempty" jsonschema:"description=Metric、Chart、Finding对应报告数组中的从0开始的序号"`
	Labels  []string `json:"labels,omitempty" jsonschema:"description=Tabs的标签名称，数量与children一致"`
}

var reportUIID = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)

func (ui ReportUI) Validate(report VisualReport) error {
	bad := errors.New("动态界面布局无效；请使用允许的组件、正确的数据索引及无循环的树")
	if !reportUIID.MatchString(ui.Root) || len(ui.Elements) == 0 || len(ui.Elements) > 64 {
		return bad
	}
	if _, ok := ui.Elements[ui.Root]; !ok {
		return bad
	}
	parents := map[string]int{}
	coveredMetrics := map[int]bool{}
	coveredCharts := map[int]bool{}
	coveredFindings := map[int]bool{}
	table, flow := false, false
	for id, e := range ui.Elements {
		if !reportUIID.MatchString(id) || len(e.Children) > 16 || !reportText(e.Props.Title, 80, false) || len(e.Props.Labels) > 6 {
			return bad
		}
		for _, label := range e.Props.Labels {
			if !reportText(label, 40, true) {
				return bad
			}
		}
		container := false
		p := e.Props
		switch e.Type {
		case "Stack":
			container = true
			if p.Title != "" || p.Columns != 0 || p.Index != nil || len(p.Labels) > 0 {
				return bad
			}
		case "Grid":
			container = true
			if p.Columns < 1 || p.Columns > 4 || p.Title != "" || p.Index != nil || len(p.Labels) > 0 {
				return bad
			}
		case "Card", "Accordion":
			container = true
			if !reportText(p.Title, 80, true) || p.Columns != 0 || p.Index != nil || len(p.Labels) > 0 {
				return bad
			}
		case "Tabs":
			container = true
			if len(p.Labels) < 2 || len(p.Labels) != len(e.Children) || p.Title != "" || p.Columns != 0 || p.Index != nil {
				return bad
			}
		case "Metric", "Chart", "Finding":
			if p.Index == nil || *p.Index < 0 || p.Title != "" || p.Columns != 0 || len(p.Labels) > 0 {
				return bad
			}
			index := *p.Index
			switch e.Type {
			case "Metric":
				if index >= len(report.Metrics) {
					return bad
				}
				coveredMetrics[index] = true
			case "Chart":
				if index >= len(report.Charts) {
					return bad
				}
				coveredCharts[index] = true
			case "Finding":
				if index >= len(report.Findings) {
					return bad
				}
				coveredFindings[index] = true
			}
		case "Table", "Flow":
			if p.Index != nil || p.Title != "" || p.Columns != 0 || len(p.Labels) > 0 {
				return bad
			}
			if e.Type == "Table" {
				if report.Table == nil {
					return bad
				}
				table = true
			} else {
				if report.Flow == nil {
					return bad
				}
				flow = true
			}
		default:
			return bad
		}
		if (container && len(e.Children) == 0) || (!container && len(e.Children) > 0) {
			return bad
		}
		for _, child := range e.Children {
			if _, ok := ui.Elements[child]; !ok {
				return bad
			}
			parents[child]++
			if parents[child] > 1 {
				return bad
			}
		}
	}
	if parents[ui.Root] != 0 {
		return bad
	}
	seen := map[string]bool{}
	var visit func(string, int) bool
	visit = func(id string, depth int) bool {
		if depth > 8 || seen[id] {
			return false
		}
		seen[id] = true
		for _, child := range ui.Elements[id].Children {
			if !visit(child, depth+1) {
				return false
			}
		}
		return true
	}
	if !visit(ui.Root, 1) || len(seen) != len(ui.Elements) {
		return bad
	}
	// Layout may move facts into tabs or accordions, but must retain all facts,
	// including warnings. The AI cannot hide findings by omitting their widgets.
	if len(coveredMetrics) != len(report.Metrics) || len(coveredCharts) != len(report.Charts) || len(coveredFindings) != len(report.Findings) || (report.Table != nil && !table) || (report.Flow != nil && !flow) {
		return errors.New("动态界面必须包含报告中的全部数据和异常提示")
	}
	return nil
}
