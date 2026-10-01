package main

import (
	"encoding/json"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestWorkflowLibraryDesktopRequestValidation(t *testing.T) {
	a, _, _ := taskFixture(t)
	for _, payload := range []string{`{"action":"create_folder","lake":"task","name":"bad","unexpected":true}`, `{"action":"list"} {}`, `null`} {
		if _, err := a.WorkflowLibrary(payload); err == nil {
			t.Fatalf("invalid request accepted: %s", payload)
		}
	}
	raw, err := a.WorkflowLibrary(`{"action":"create_folder","lake":"task","name":"维护"}`)
	if err != nil {
		t.Fatal(err)
	}
	var result store.WorkflowLibrary
	if err := json.Unmarshal([]byte(raw), &result); err != nil || result.CreatedID == "" || len(result.Entries) != 1 {
		t.Fatalf("folder creation failed: %v", err)
	}
}
