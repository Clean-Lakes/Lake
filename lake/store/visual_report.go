package store

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/cloudwego/eino/lake/agent"
)

// Clone before redacting: the model's input must never be mutated in place.
func SanitizeVisualReport(report agent.VisualReport) (agent.VisualReport, error) {
	data, err := json.Marshal(report)
	if err != nil {
		return agent.VisualReport{}, err
	}
	report, err = agent.ParseVisualReport(data)
	if err != nil {
		return agent.VisualReport{}, err
	}
	report.MapText(func(s string) string { text, _ := ExecutionPreview(s, 4096); return text })
	if report.Flow != nil {
		ids := map[string]string{}
		for i, n := range report.Flow.Nodes {
			ids[n.ID] = fmt.Sprintf("node-%d", i+1)
		}
		for i := range report.Flow.Nodes {
			report.Flow.Nodes[i].ID = ids[report.Flow.Nodes[i].ID]
		}
		for i := range report.Flow.Edges {
			e := &report.Flow.Edges[i]
			e.From = ids[e.From]
			e.To = ids[e.To]
		}
	}
	if report.UI != nil {
		keys := make([]string, 0, len(report.UI.Elements))
		for id := range report.UI.Elements {
			keys = append(keys, id)
		}
		sort.Strings(keys)
		ids := map[string]string{}
		for i, id := range keys {
			ids[id] = fmt.Sprintf("element-%d", i+1)
		}
		elements := map[string]agent.ReportUIElement{}
		for id, e := range report.UI.Elements {
			for i, child := range e.Children {
				e.Children[i] = ids[child]
			}
			elements[ids[id]] = e
		}
		report.UI.Root = ids[report.UI.Root]
		report.UI.Elements = elements
	}
	return report, report.Validate()
}
