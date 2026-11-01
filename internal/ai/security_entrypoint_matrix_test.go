package ai

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityManagedInventoryNoTaskHasNoExternalDispatch(t *testing.T) {
	e := managedEngineFixture(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"})
	var callbacks atomic.Int32
	e.Bridge = func(context.Context, string, string, map[string]any, bool) (any, error) {
		callbacks.Add(1)
		return nil, nil
	}
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.SecurityManaged = true
	c := s.state.Config
	s.mu.Unlock()
	for _, name := range security.RegisteredTools() {
		arguments := `{}`
		if name == "work_begin" {
			arguments = `{"title":"Unconfirmed proposal","items":[{"title":"Must be confirmed before execution"}]}`
		}
		_, err := e.invoke(t.Context(), s, c, Call{ID: "unbound-" + name, Name: name, Arguments: arguments})
		if err == nil && name != "work_read" {
			t.Errorf("unbound runtime unexpectedly accepted %s", name)
		}
	}
	if callbacks.Load() != 0 {
		t.Fatal("unbound inventory reached an external host callback", callbacks.Load())
	}
	store, _ := e.adkStore()
	var operations, tasks, grants int64
	for model, counter := range map[any]*int64{&nativeOperation{}: &operations, &securityTaskRow{}: &tasks, &securityTaskGrantRow{}: &grants} {
		if err := store.DB.Model(model).Count(counter).Error; err != nil {
			t.Fatal(err)
		}
	}
	if operations != 0 || tasks != 0 || grants != 0 {
		t.Fatal("unconfirmed tool calls created operation authority", operations, tasks, grants)
	}
}

func TestSecurityManagedUnconfirmedGoalCannotFinish(t *testing.T) {
	e := managedEngineFixture(t, Model{Name: "fixture", URL: "http://127.0.0.1:1"})
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.SecurityManaged = true
	s.state.View.RootTurnID = "real-user-root"
	c := s.state.Config
	s.mu.Unlock()
	goal, err := e.beginWork(s, "Proposed only", []WorkItem{{Title: "Unverified result"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.invokeWorkTool(t.Context(), s, c, Call{ID: "finish-without-contract", Name: "work_finish"}, map[string]any{"summary": "model says complete"})
	if err == nil || !strings.Contains(err.Error(), "验收") {
		t.Fatal("model finished an unconfirmed managed goal", err)
	}
	_, current, err := e.workRow("case", goal.ID)
	if err != nil || workTerminal(current.Status) {
		t.Fatal("unconfirmed goal was falsely closed", current.Status, err)
	}
}
