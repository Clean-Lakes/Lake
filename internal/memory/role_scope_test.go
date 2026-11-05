package memory

import "testing"

func TestRoleScopeIdentityAndFences(t *testing.T) {
	s := RoleKnowledgeScopeV1{Version: 1, StoreID: "store", ProjectID: "project", RoleID: "role", RecoveryEpoch: "epoch", SettingsRevision: 1}
	key, err := s.Key()
	if err != nil {
		t.Fatal(err)
	}
	if p, err := s.RelativeDirectory(); err != nil || p != "projects/project/roles/role" {
		t.Fatal(p, err)
	}
	ref := KnowledgeRefV1{ScopeKey: key, EntryID: "entry", Revision: 1, ContentHash: key}
	if err := ref.Validate(s); err != nil {
		t.Fatal(err)
	}
	f := RolePublishFenceV1{Scope: s, BaseRevision: 2, WithdrawalRevision: 3, CommitID: "commit"}
	if !f.Matches(s, 2, 3) {
		t.Fatal("valid receipt rejected")
	}
	for _, field := range []string{"project", "role", "store", "epoch", "settings"} {
		other := s
		switch field {
		case "project":
			other.ProjectID = "other"
		case "role":
			other.RoleID = "other"
		case "store":
			other.StoreID = "other"
		case "epoch":
			other.RecoveryEpoch = "other"
		case "settings":
			other.SettingsRevision++
		}
		if f.Matches(other, 2, 3) {
			t.Fatal("stale/foreign publisher admitted", field)
		}
		if field == "role" || field == "project" || field == "store" {
			if ref.Validate(other) == nil {
				t.Fatal("foreign knowledge reference admitted", field)
			}
		}
	}
	if f.Matches(s, 3, 3) || f.Matches(s, 2, 4) {
		t.Fatal("late write survived publication or withdrawal")
	}
	if (RoleKnowledgeSettings{}).AccumulateEnabled || (RoleKnowledgeSettings{}).UseEnabled {
		t.Fatal("contract enabled memory")
	}
}
func TestRoleScopeRejectsPathsAndUnknownVersions(t *testing.T) {
	for _, id := range []string{"", "..", "a/b", `a\b`, "x\x00y", "/absolute", "role/name"} {
		s := RoleKnowledgeScopeV1{Version: 1, StoreID: "store", ProjectID: "project", RoleID: id, RecoveryEpoch: "epoch", SettingsRevision: 1}
		if _, err := s.RelativeDirectory(); err == nil {
			t.Fatal("unsafe directory accepted", id)
		}
	}
	s := RoleKnowledgeScopeV1{Version: 2, StoreID: "store", ProjectID: "project", RoleID: "role", RecoveryEpoch: "epoch", SettingsRevision: 1}
	if s.Validate() == nil {
		t.Fatal("future contract accepted")
	}
}
