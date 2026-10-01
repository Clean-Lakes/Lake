package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"unicode/utf8"
)

// VisualReport is presentation data, never executable markup or a tool request.
type VisualReport struct {
	Title    string          `json:"title" jsonschema:"description=简短中文标题"`
	Summary  string          `json:"summary" jsonschema:"description=用日常语言写一句结论，不超过280字"`
	Tone     string          `json:"tone" jsonschema:"enum=good,enum=warning,enum=critical,enum=info,enum=unknown"`
	Scope    string          `json:"scope,omitempty" jsonschema:"description=实际检查范围与时间，未检查的范围不能包含在内"`
	Metrics  []ReportMetric  `json:"metrics,omitempty"`
	Charts   []ReportChart   `json:"charts,omitempty"`
	Table    *ReportTable    `json:"table,omitempty"`
	Findings []ReportFinding `json:"findings,omitempty"`
	Flow     *ReportFlow     `json:"flow,omitempty"`
	Sources  []string        `json:"sources,omitempty" jsonschema:"description=工具结果或运行记录的来源说明，不包含凭据"`
	UI       *ReportUI       `json:"ui,omitempty" jsonschema:"description=可选json-render界面布局，使用组件目录组合已有数据；省略时自动选择布局"`
}

type ReportMetric struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Hint  string `json:"hint,omitempty"`
	Tone  string `json:"tone" jsonschema:"enum=good,enum=warning,enum=critical,enum=info,enum=unknown"`
}
type ReportSegment struct {
	Label string  `json:"label"`
	Value float64 `json:"value"`
	Tone  string  `json:"tone" jsonschema:"enum=good,enum=warning,enum=critical,enum=info,enum=unknown"`
}
type ReportChart struct {
	Title    string          `json:"title"`
	Kind     string          `json:"kind" jsonschema:"enum=distribution,enum=bar,description=distribution用于互斥分类占比，bar用于独立指标比较"`
	Unit     string          `json:"unit,omitempty"`
	Segments []ReportSegment `json:"segments"`
}
type ReportTable struct {
	Title   string      `json:"title"`
	Columns []string    `json:"columns"`
	Rows    []ReportRow `json:"rows"`
}
type ReportRow struct {
	Cells []string `json:"cells"`
	Tone  string   `json:"tone" jsonschema:"enum=good,enum=warning,enum=critical,enum=info,enum=unknown"`
}
type ReportFinding struct {
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	NextStep string `json:"next_step,omitempty" jsonschema:"description=建议下一步，不表示已执行或批准"`
	Tone     string `json:"tone" jsonschema:"enum=good,enum=warning,enum=critical,enum=info,enum=unknown"`
}
type ReportFlow struct {
	Nodes []ReportNode `json:"nodes"`
	Edges []ReportEdge `json:"edges,omitempty"`
}
type ReportNode struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Status string `json:"status" jsonschema:"enum=pending,enum=running,enum=completed,enum=failed,enum=unknown,enum=skipped,enum=cancelled"`
	Detail string `json:"detail,omitempty"`
}
type ReportEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func reportText(s string, max int, required bool) bool {
	return utf8.ValidString(s) && utf8.RuneCountInString(s) <= max && !strings.ContainsRune(s, 0) && (!required || strings.TrimSpace(s) != "")
}
func reportTone(t string) bool {
	return t == "good" || t == "warning" || t == "critical" || t == "info" || t == "unknown"
}
func (r VisualReport) Validate() error {
	bad := errors.New("图形化报告字段无效或超过限制")
	if len(r.Metrics) == 0 && len(r.Charts) == 0 && len(r.Findings) == 0 && r.Table == nil && r.Flow == nil {
		return errors.New("图形化报告至少包含指标、图表、清单、提示或流程图")
	}
	if !reportText(r.Title, 80, true) || !reportText(r.Summary, 280, true) || !reportText(r.Scope, 200, false) || !reportTone(r.Tone) || len(r.Metrics) > 8 || len(r.Charts) > 3 || len(r.Findings) > 8 || len(r.Sources) > 8 {
		return bad
	}
	for _, m := range r.Metrics {
		if !reportText(m.Label, 40, true) || !reportText(m.Value, 40, true) || !reportText(m.Hint, 100, false) || !reportTone(m.Tone) {
			return bad
		}
	}
	for _, c := range r.Charts {
		if !reportText(c.Title, 80, true) || !reportText(c.Unit, 20, false) || (c.Kind != "distribution" && c.Kind != "bar") || len(c.Segments) == 0 || len(c.Segments) > 16 {
			return bad
		}
		total := 0.0
		for _, s := range c.Segments {
			if !reportText(s.Label, 60, true) || !reportTone(s.Tone) || math.IsNaN(s.Value) || math.IsInf(s.Value, 0) || s.Value < 0 || s.Value > 1e12 {
				return bad
			}
			total += s.Value
		}
		if c.Kind == "distribution" && total == 0 {
			return errors.New("占比图需要至少一个非零数值，缺失数据请使用 unknown 说明")
		}
	}
	if r.Table != nil {
		t := r.Table
		if !reportText(t.Title, 80, true) || len(t.Columns) == 0 || len(t.Columns) > 6 || len(t.Rows) > 100 {
			return bad
		}
		for _, c := range t.Columns {
			if !reportText(c, 40, true) {
				return bad
			}
		}
		for _, row := range t.Rows {
			if len(row.Cells) != len(t.Columns) || !reportTone(row.Tone) {
				return bad
			}
			for _, c := range row.Cells {
				if !reportText(c, 240, false) {
					return bad
				}
			}
		}
	}
	for _, f := range r.Findings {
		if !reportText(f.Title, 80, true) || !reportText(f.Detail, 500, true) || !reportText(f.NextStep, 200, false) || !reportTone(f.Tone) {
			return bad
		}
	}
	for _, s := range r.Sources {
		if !reportText(s, 300, true) {
			return bad
		}
	}
	if r.Flow != nil {
		if len(r.Flow.Nodes) == 0 || len(r.Flow.Nodes) > 64 || len(r.Flow.Edges) > 128 {
			return bad
		}
		ids := map[string]bool{}
		incoming := map[string]int{}
		outgoing := map[string][]string{}
		for _, n := range r.Flow.Nodes {
			if !reportText(n.ID, 128, true) || ids[n.ID] || !reportText(n.Label, 80, true) || !reportText(n.Detail, 500, false) {
				return bad
			}
			switch n.Status {
			case "pending", "running", "completed", "failed", "unknown", "skipped", "cancelled":
			default:
				return bad
			}
			ids[n.ID] = true
		}
		for _, e := range r.Flow.Edges {
			if !ids[e.From] || !ids[e.To] {
				return bad
			}
			incoming[e.To]++
			outgoing[e.From] = append(outgoing[e.From], e.To)
		}
		queue := []string{}
		for id := range ids {
			if incoming[id] == 0 {
				queue = append(queue, id)
			}
		}
		visited := 0
		for len(queue) > 0 {
			id := queue[0]
			queue = queue[1:]
			visited++
			for _, next := range outgoing[id] {
				incoming[next]--
				if incoming[next] == 0 {
					queue = append(queue, next)
				}
			}
		}
		if visited != len(ids) {
			return errors.New("流程图不能包含循环依赖")
		}
	}
	if r.UI != nil {
		if err := r.UI.Validate(r); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(r)
	if err != nil || len(encoded) > 48*1024 {
		return bad
	}
	return nil
}

func ParseVisualReport(data []byte) (VisualReport, error) {
	var r VisualReport
	if len(data) > 48*1024 {
		return r, errors.New("图形化报告过大")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return r, err
	}
	var extra any
	if !errors.Is(d.Decode(&extra), io.EOF) {
		return r, errors.New("图形化报告含额外内容")
	}
	return r, r.Validate()
}

// MapText visits every displayed text field. Identity, tone, and numeric values
// remain untouched, so redaction cannot change the meaning of a chart or graph.
func (r *VisualReport) MapText(f func(string) string) {
	r.Title = f(r.Title)
	r.Summary = f(r.Summary)
	r.Scope = f(r.Scope)
	for i := range r.Metrics {
		m := &r.Metrics[i]
		m.Label = f(m.Label)
		m.Value = f(m.Value)
		m.Hint = f(m.Hint)
	}
	for i := range r.Charts {
		c := &r.Charts[i]
		c.Title = f(c.Title)
		c.Unit = f(c.Unit)
		for j := range c.Segments {
			c.Segments[j].Label = f(c.Segments[j].Label)
		}
	}
	if r.Table != nil {
		r.Table.Title = f(r.Table.Title)
		for i := range r.Table.Columns {
			r.Table.Columns[i] = f(r.Table.Columns[i])
		}
		for i := range r.Table.Rows {
			for j := range r.Table.Rows[i].Cells {
				r.Table.Rows[i].Cells[j] = f(r.Table.Rows[i].Cells[j])
			}
		}
	}
	for i := range r.Findings {
		v := &r.Findings[i]
		v.Title = f(v.Title)
		v.Detail = f(v.Detail)
		v.NextStep = f(v.NextStep)
	}
	for i := range r.Sources {
		r.Sources[i] = f(r.Sources[i])
	}
	if r.Flow != nil {
		for i := range r.Flow.Nodes {
			r.Flow.Nodes[i].Label = f(r.Flow.Nodes[i].Label)
			r.Flow.Nodes[i].Detail = f(r.Flow.Nodes[i].Detail)
		}
	}
	if r.UI != nil {
		for id, element := range r.UI.Elements {
			element.Props.Title = f(element.Props.Title)
			for i := range element.Props.Labels {
				element.Props.Labels[i] = f(element.Props.Labels[i])
			}
			r.UI.Elements[id] = element
		}
	}
}
