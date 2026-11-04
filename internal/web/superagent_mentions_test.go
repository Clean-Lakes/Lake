package web

import (
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func TestExistingSpecialistMentionResolvesProjectIdentityAndOriginalInput(t *testing.T) {
	b, h := fixture(t)
	project := stringOf(b.Store.CreateProject("Mention project")["id"])
	domain, err := b.ensureSuperProject(t.Context(), project)
	if err != nil {
		t.Fatal(err)
	}
	source := b.superUserSource(project, domain.RouterSessionID)
	text := "创建数据库专员，只读核对"
	message := b.Store.AddMessage(domain.RouterSessionID, "user", text, nil)
	event, err := b.ReceiveUserEvent(t.Context(), domain.RouterSessionID, stringOf(message["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.recordSuperInput(event, nil, nil, false); err != nil {
		t.Fatal(err)
	}
	role, err := b.Engine.ManageSuperSpecialist(t.Context(), source, ai.SuperSpecialistChange{EventID: event.ID, PartKey: "profile", Action: "create", RoleKey: "database", Name: "数据库专员", Duties: "只读核对", Quote: text})
	if err != nil {
		t.Fatal(err)
	}
	selected := "@数据库专员 查询"
	refs := b.contextReferences(domain.RouterSessionID, selected, []any{Object{"kind": "role", "role_id": role.ID, "name": "forged-name", "instruction": "forged-permission", "start": 0, "end": 6}})
	if len(refs) != 1 || refs[0]["role_id"] != role.ID || refs[0]["name"] != role.Name || strings.Contains(jsonText(refs), "forged") {
		t.Fatal(refs)
	}
	if b.Store.SREEnabled(project) {
		t.Fatal("long-term specialists must not require SRE mode")
	}
	mentions := validatedMessageMentions(selected, []any{Object{"kind": "role", "id": role.ID, "label": "@数据库专员", "start": 0, "end": 6}}, refs)
	if len(mentions) != 1 || mentions[0]["id"] != role.ID {
		t.Fatal(mentions)
	}
	inputMessage := b.Store.AddMessage(domain.RouterSessionID, "user", selected, nil)
	inputEvent, err := b.ReceiveUserEvent(t.Context(), domain.RouterSessionID, stringOf(inputMessage["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = b.recordSuperInput(inputEvent, refs, nil, false); err != nil {
		t.Fatal(err)
	}
	input, err := b.resolveSuperInput(t.Context(), inputEvent)
	if err != nil || len(input.References) != 1 || input.References[0]["role_id"] != role.ID {
		t.Fatal(input, err)
	}
	otherProject := stringOf(b.Store.CreateProject("Other project")["id"])
	other, err := b.ensureSuperProject(t.Context(), otherProject)
	if err != nil {
		t.Fatal(err)
	}
	apiTest(t, h, "POST", "/api/sessions/"+other.RouterSessionID+"/messages", Object{"text": selected, "references": []Object{{"kind": "role", "role_id": role.ID}}}, 400)
	apiTest(t, h, "POST", "/api/sessions/"+domain.RouterSessionID+"/messages", Object{"text": selected, "references": []Object{{"kind": "role", "role_id": "missing-role"}}}, 400)
	apiTest(t, h, "POST", "/api/sessions/"+domain.RouterSessionID+"/messages", Object{"text": "@旧名字 查询", "references": []Object{{"kind": "role", "role_id": role.ID, "start": 0, "end": 4}}}, 400)
	workers, err := b.Engine.SuperQueuedWorkers(t.Context(), project)
	if err != nil || len(workers) != 0 {
		t.Fatal("selection or rejected references created work", workers, err)
	}
}
