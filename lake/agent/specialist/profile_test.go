package specialist

import (
	"testing"

	"github.com/cloudwego/eino/lake/agent"
)

func TestPrepareIntersectsParentScopeAndToolWhitelist(t *testing.T) {
	parent := agent.RunScope{LakeID: "lake", ResourceIDs: []string{"host-1"}, ToolNames: []string{"lake_ssh", "lake_ssh_session_list"}}
	profile := Profile{Name: "lake_ssh_agent", Description: "SSH 专员", Instruction: "只查真实状态", Model: "test", MaxTurns: 8, Tools: []string{"lake_ssh", "lake_ssh_session_open"}, Scope: agent.RunScope{LakeID: "lake", ResourceIDs: []string{"host-1", "host-2"}}}
	prepared, err := Prepare(parent, profile)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Scope.ResourceIDs) != 1 || prepared.Scope.ResourceIDs[0] != "host-1" || len(prepared.Scope.ToolNames) != 1 || prepared.Scope.ToolNames[0] != "lake_ssh" {
		t.Fatalf("scope expanded parent: %+v", prepared.Scope)
	}
	if prepared.MaxTurns != 8 {
		t.Fatal("max turns lost")
	}
}

func TestPrepareRejectsInvalidProfile(t *testing.T) {
	parent := agent.RunScope{LakeID: "lake", AllTools: true, AllResources: true, ProjectRoot: "/project"}
	base := Profile{Name: "lake_code_agent", Description: "代码专员", Instruction: "只看项目", Model: "test", MaxTurns: 8, Tools: []string{"lake_code_read"}, Scope: agent.RunScope{LakeID: "lake", ProjectRoot: "/project"}}
	for _, mutate := range []func(*Profile){
		func(p *Profile) { p.MaxTurns = 33 },
		func(p *Profile) { p.Tools = nil },
		func(p *Profile) { p.Scope.ProjectRoot = "/other" },
		func(p *Profile) { p.Name = "Lake Agent" },
	} {
		profile := base
		mutate(&profile)
		if _, err := Prepare(parent, profile); err == nil {
			t.Fatalf("accepted invalid profile: %+v", profile)
		}
	}
}
