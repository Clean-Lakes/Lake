package agent

import (
	"encoding/json"
	"math"
	"testing"
)

func TestVisualReportRejectsMisleadingOrMalformedChartsAndGraphs(t *testing.T) {
	base := VisualReport{Title: "检查结果", Summary: "一项结果尚未确认", Tone: "warning"}
	for _, value := range []float64{-1, math.NaN(), math.Inf(1), 0} {
		r := base
		r.Charts = []ReportChart{{Title: "状态", Kind: "distribution", Segments: []ReportSegment{{Label: "待确认", Value: value, Tone: "unknown"}}}}
		if r.Validate() == nil {
			t.Fatal("invalid distribution accepted")
		}
	}
	r := base
	r.Table = &ReportTable{Title: "清单", Columns: []string{"名称", "状态"}, Rows: []ReportRow{{Cells: []string{"只一列"}, Tone: "info"}}}
	if r.Validate() == nil {
		t.Fatal("ragged table accepted")
	}
	r = base
	r.Flow = &ReportFlow{Nodes: []ReportNode{{ID: "a", Label: "A", Status: "unknown"}, {ID: "b", Label: "B", Status: "pending"}}, Edges: []ReportEdge{{From: "a", To: "b"}, {From: "b", To: "a"}}}
	if r.Validate() == nil {
		t.Fatal("cyclic graph accepted")
	}
	r.Flow.Edges = []ReportEdge{{From: "missing", To: "b"}}
	if r.Validate() == nil {
		t.Fatal("dangling graph accepted")
	}
	r.Flow.Edges = []ReportEdge{{From: "a", To: "b"}}
	if r.Validate() != nil {
		t.Fatal("valid unknown state rejected")
	}
	data, _ := json.Marshal(r)
	if _, err := ParseVisualReport(append(data, []byte(" true")...)); err == nil {
		t.Fatal("trailing content accepted")
	}
	if _, err := ParseVisualReport([]byte(`{"title":"test","summary":"test","tone":"info","html":"<script>"}`)); err == nil {
		t.Fatal("executable extra field accepted")
	}
}
