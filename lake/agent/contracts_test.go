package agent

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestAgentEventJSONRoundTripPreservesTypedEnvelope(t *testing.T) {
	original := AgentEvent{
		Version:    1,
		SessionID:  SessionID("session-1"),
		Sequence:   7,
		Kind:       "tool_completed",
		Actor:      "specialist:code",
		ToolCallID: ToolCallID("call-2"),
		Payload:    json.RawMessage(`{"status":"ok","bytes":12}`),
	}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var decoded AgentEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, original) {
		t.Fatalf("event changed during JSON round trip: got %+v, want %+v", decoded, original)
	}
}

func TestRunScopeIntersectNarrowsResourcesToolsAndProject(t *testing.T) {
	parent := RunScope{
		LakeID:       "lake-1",
		AllResources: true,
		ToolNames:    []string{"read", "write"},
		ProjectRoot:  "/work/project",
	}
	child := RunScope{
		LakeID:      "lake-1",
		ResourceIDs: []string{"host-1"},
		ToolNames:   []string{"read", "outside"},
		ProjectRoot: "/work/project/service",
	}
	got, err := parent.Intersect(child)
	if err != nil {
		t.Fatal(err)
	}
	want := RunScope{
		LakeID:      "lake-1",
		ResourceIDs: []string{"host-1"},
		ToolNames:   []string{"read"},
		ProjectRoot: "/work/project/service",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("derived scope = %+v, want %+v", got, want)
	}
}

func TestRunScopeIntersectRejectsCrossLakeAndProjectEscape(t *testing.T) {
	parent := RunScope{LakeID: "lake-1", ProjectRoot: "/work/project"}
	for _, child := range []RunScope{
		{LakeID: "lake-2", ProjectRoot: "/work/project"},
		{LakeID: "lake-1", ProjectRoot: "/work/project-escape"},
		{LakeID: "lake-1", ProjectRoot: "/work/project/../elsewhere"},
	} {
		if _, err := parent.Intersect(child); err == nil {
			t.Errorf("scope %+v escaped parent scope", child)
		}
	}
}

func TestRunScopeIntersectNeverTreatsEmptyListAsAll(t *testing.T) {
	parent := RunScope{LakeID: "lake-1", ResourceIDs: []string{"host-1"}, ToolNames: []string{"read"}}
	child := RunScope{LakeID: "lake-1", AllResources: true, AllTools: true}
	got, err := parent.Intersect(child)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.ResourceIDs, []string{"host-1"}) || !reflect.DeepEqual(got.ToolNames, []string{"read"}) || got.AllResources || got.AllTools {
		t.Fatalf("child expanded parent scope: %+v", got)
	}
	got, err = parent.Intersect(RunScope{LakeID: "lake-1"})
	if err != nil {
		t.Fatal(err)
	}
	if got.AllResources || got.AllTools || len(got.ResourceIDs) != 0 || len(got.ToolNames) != 0 {
		t.Fatalf("empty child lists expanded parent scope: %+v", got)
	}
}
