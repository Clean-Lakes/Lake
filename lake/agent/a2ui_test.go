package agent

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func uiTestMessages(id string) []UIMessage {
	var messages []UIMessage
	_ = json.Unmarshal([]byte(`[
 {"version":"v0.9.1","createSurface":{"surfaceId":"`+id+`","catalogId":"`+UICatalogID+`"}},
 {"version":"v0.9.1","updateComponents":{"surfaceId":"`+id+`","components":[{"id":"root","component":"Column","children":["input","button","text"]},{"id":"input","component":"TextField","label":"问题","value":{"path":"/question"}},{"id":"button","component":"Button","label":"继续","action":{"event":{"name":"continue","context":{"question":{"path":"/question"}}}}},{"id":"text","component":"Text","text":{"path":"/result"}}]}},
 {"version":"v0.9.1","updateDataModel":{"surfaceId":"`+id+`","value":{"question":"","result":"待选择"}}}
 ]`), &messages)
	return messages
}
func TestUISessionIncrementalUpdatesAndActionScope(t *testing.T) {
	s := NewUISession()
	snapshots, err := s.Prepare(uiTestMessages("main"), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].Revision != 1 {
		t.Fatal(snapshots)
	}
	if _, ok := s.Get("main"); ok {
		t.Fatal("unpersisted UI committed")
	}
	if err = s.Restore(snapshots[0]); err != nil {
		t.Fatal(err)
	}
	action := UIUserAction{SurfaceID: "main", SourceComponentID: "button", Name: "continue", Revision: 1, Context: map[string]any{"question": "展示进程"}}
	if _, err = s.CheckAction(action); err != nil {
		t.Fatal(err)
	}
	action.SourceComponentID = "text"
	if _, err = s.CheckAction(action); err == nil {
		t.Fatal("undeclared action accepted")
	}
	action.SourceComponentID = "button"
	action.Context = map[string]any{"other": "malicious"}
	if _, err = s.CheckAction(action); err == nil {
		t.Fatal("wrong form fields accepted")
	}
	snapshots, err = s.Prepare([]UIMessage{{Version: UIVersion, UpdateDataModel: &UIUpdateDataModel{SurfaceID: "main", Path: "/result", Value: "已完成"}}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if snapshots[0].Data["question"] != "" || snapshots[0].Data["result"] != "已完成" {
		t.Fatal("incremental update replaced unrelated data")
	}
	_ = s.Restore(snapshots[0])
	action.Revision = 1
	if _, err = s.CheckAction(action); err == nil {
		t.Fatal("stale action accepted")
	}
}
func TestUIRejectsCyclesFunctionsAndUnknownComponentsAtomically(t *testing.T) {
	s := NewUISession()
	v, err := s.Prepare(uiTestMessages("main"), "")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Restore(v[0])
	for _, raw := range []string{
		`{"id":"root","component":"Column","children":["root"]}`,
		`{"id":"root","component":"HTML","text":"script"}`,
		`{"id":"root","component":"Text","text":{"call":"exec"}}`,
		`{"id":"root","component":"Button","label":"运行","action":{"event":{"name":"continue","context":{"cmd":{"call":"exec"}}}}}`,
		`{"id":"root","component":"Button","label":"运行","action":{"event":{"name":"inspect_ports","context":{}}}}`,
	} {
		var c map[string]any
		_ = json.Unmarshal([]byte(raw), &c)
		if _, err := s.Prepare([]UIMessage{{Version: UIVersion, UpdateComponents: &UIUpdateComponents{SurfaceID: "main", Components: []map[string]any{c}}}}, ""); err == nil {
			t.Fatalf("accepted unsafe update: %s", raw)
		}
		last, _ := s.Get("main")
		if last.Revision != 1 || last.Components[0]["component"] != "Column" {
			t.Fatal("invalid update changed saved UI")
		}
	}
	for _, path := range []string{"/constructor/value", "/a/__proto__", "relative", "/" + strings.Repeat("a/", 9) + "b"} {
		if _, err := s.Prepare([]UIMessage{{Version: UIVersion, UpdateDataModel: &UIUpdateDataModel{SurfaceID: "main", Path: path, Value: "x"}}}, ""); err == nil {
			t.Fatal("unsafe path", path)
		}
	}
}

func TestUIRejectsInvalidBoundDataAndHiddenActions(t *testing.T) {
	s := NewUISession()
	v, err := s.Prepare(uiTestMessages("main"), "")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Restore(v[0])
	for _, value := range []any{12, map[string]any{"html": "<script>"}, []any{"wrong type"}} {
		if _, err := s.Prepare([]UIMessage{{Version: UIVersion, UpdateDataModel: &UIUpdateDataModel{SurfaceID: "main", Path: "/result", Value: value}}}, ""); err == nil {
			t.Fatal("accepted a nontext value bound to Text")
		}
	}
	v, err = s.Prepare([]UIMessage{{Version: UIVersion, UpdateComponents: &UIUpdateComponents{SurfaceID: "main", Components: []map[string]any{{"id": "root", "component": "Column", "children": []any{"text"}}}}}}, "")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Restore(v[0])
	if _, err := s.CheckAction(UIUserAction{SurfaceID: "main", SourceComponentID: "button", Name: "continue", Revision: 2, Context: map[string]any{"question": "hidden"}}); err == nil {
		t.Fatal("an old disconnected button was still actionable")
	}
	// Chart data is validated before it can break the renderer.
	for _, value := range []any{[]any{map[string]any{"label": "CPU", "value": -1}}, []any{map[string]any{"label": "CPU", "value": "bad"}}, "bad"} {
		messages := []UIMessage{
			{Version: UIVersion, UpdateComponents: &UIUpdateComponents{SurfaceID: "main", Components: []map[string]any{{"id": "text", "component": "Chart", "label": "CPU", "values": map[string]any{"path": "/samples"}}}}},
			{Version: UIVersion, UpdateDataModel: &UIUpdateDataModel{SurfaceID: "main", Path: "/samples", Value: value}},
		}
		if _, err := s.Prepare(messages, ""); err == nil {
			t.Fatal("invalid chart series accepted")
		}
	}
}

func TestUIRecreatedSurfaceCannotAcceptPriorActions(t *testing.T) {
	s := NewUISession()
	first, err := s.Prepare(uiTestMessages("main"), "")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Restore(first[0])
	deleted, err := s.Prepare([]UIMessage{{Version: UIVersion, DeleteSurface: &UIDeleteSurface{SurfaceID: "main"}}}, "")
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Restore(deleted[0])
	// Reopening restores tombstones as well as live panels.
	reopened := NewUISession()
	_ = reopened.Restore(deleted[0])
	next, err := reopened.Prepare(uiTestMessages("main"), "")
	if err != nil || next[0].Revision != 3 {
		t.Fatalf("surface revision reset after deletion: %+v err=%v", next, err)
	}
	_ = reopened.Restore(next[0])
	if _, err := reopened.CheckAction(UIUserAction{SurfaceID: "main", SourceComponentID: "button", Name: "continue", Revision: 1, Context: map[string]any{"question": "old"}}); err == nil {
		t.Fatal("an action from a deleted version was accepted")
	}
}

func TestAutomaticReplyViewsMatchLakeCatalog(t *testing.T) {
	data, err := os.ReadFile("testdata/a2ui-automatic-reply.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Surfaces []UISnapshot `json:"surfaces"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Surfaces) == 0 {
		t.Fatal("empty shared catalog fixture")
	}
	for _, surface := range fixture.Surfaces {
		if err := surface.Validate(); err != nil {
			t.Fatal("client automatic reply violates the backend catalog:", err)
		}
		for _, component := range surface.Components {
			if component["action"] != nil {
				t.Fatal("automatic reply acquired an executable action")
			}
		}
	}
	for _, raw := range []string{
		`{"id":"root","component":"List","items":[{}]}`,
		`{"id":"root","component":"List","items":["一步"],"ordered":"true"}`,
		`{"id":"root","component":"Code","text":"command","execute":true}`,
		`{"id":"root","component":"Markdown","text":{"call":"exec"}}`,
		`{"id":"root","component":"Table","columns":["one"],"headers":["多","列"],"rows":[]}`,
		`{"id":"root","component":"Chart","label":"占比","max":100,"values":[{"label":"超出","value":120}]}`,
	} {
		var component map[string]any
		_ = json.Unmarshal([]byte(raw), &component)
		if err := (UISnapshot{SurfaceID: "invalid", CatalogID: UICatalogID, Components: []map[string]any{component}, Data: map[string]any{}}).Validate(); err == nil {
			t.Fatal("accepted invalid expanded catalog props:", raw)
		}
	}
}
