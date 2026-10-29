package ai

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkCatalogStaysOutOfRolesPlansAndWorkflowSummaries(t *testing.T) {
	e := &Engine{}
	for _, tc := range []struct {
		name string
		c    Config
		want bool
	}{{"core", Config{Profile: "core"}, true}, {"plan", Config{Profile: "core", ConversationMode: ModePlan}, false}, {"workflow", Config{Profile: "core", workflowMode: true}, false}, {"terminal", Config{Profile: "terminal2"}, false}, {"pilot", Config{Profile: "core", sreCoordinator: true}, false}} {
		t.Run(tc.name, func(t *testing.T) {
			count := 0
			for _, tool := range e.sessionCatalog(context.Background(), "fixture", tc.c) {
				if workToolName(tool.Name) {
					count++
				}
			}
			if tc.want && count != 5 || !tc.want && count != 0 {
				t.Fatal("unexpected work capability scope", count)
			}
		})
	}
}

func seedObservedWork(t *testing.T, e *Engine) WorkGoal {
	t.Helper()
	s, _ := e.get("case")
	s.mu.Lock()
	p := DefaultPermissions()
	p.SilentCommands = true
	s.state.Config.Permissions = &p
	s.state.View.RootTurnID = "fixture-origin"
	s.mu.Unlock()
	g, err := e.beginWork(s, "跟进原发布句柄", nil)
	if err != nil {
		t.Fatal(err)
	}
	row, g, err := e.workRow("case", g.ID)
	if err != nil {
		t.Fatal(err)
	}
	g.Items = []WorkItem{{ID: uid(), Title: "原发布任务", Status: "waiting_external", Watch: &ExternalWatch{Adapter: "release-v1", OperationID: "original-operation", Handle: "original-order", ServerID: "fixture-release", Revision: "trusted-configuration", State: "running", NextCheckAt: time.Now().Add(-time.Second)}}}
	g.Status = "waiting_external"
	row.Checkpoint = "{}"
	row.WaitCallID = "original-wait"
	row.WaitState = "waiting"
	if err = e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	return g
}

func TestWorkObserverBacksOffThenBlocksWithoutModelOrWrite(t *testing.T) {
	var reads atomic.Int32
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(_ context.Context, _ string, name string, _ map[string]any, approved bool) (any, error) {
		if name != "work_release_observe" || approved {
			t.Fatal("observation became a mutating call")
		}
		reads.Add(1)
		return nil, errors.New("fixture network unavailable")
	})
	g := seedObservedWork(t, e)
	for i := 0; i < 5; i++ {
		row, current, err := e.workRow("case", g.ID)
		if err != nil {
			t.Fatal(err)
		}
		current.Items[0].Watch.NextCheckAt = time.Now().Add(-time.Second)
		if err = e.writeWorkGoal(&row, &current, false); err != nil {
			t.Fatal(err)
		}
		if err = e.workTick(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	_, current, err := e.workRow("case", g.ID)
	if err != nil || current.Status != "blocked" || reads.Load() != 5 || current.ModelRounds != 0 {
		t.Fatal("transport failures did not block observation", current.Status, reads.Load(), err)
	}
	if err = e.workTick(context.Background()); err != nil || reads.Load() != 5 {
		t.Fatal("blocked observer kept polling", err)
	}
}

func TestWorkCancelCancelsObservationAndRejectsLateResult(t *testing.T) {
	entered := make(chan struct{})
	var reads atomic.Int32
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, func(ctx context.Context, _ string, name string, _ map[string]any, _ bool) (any, error) {
		if name != "work_release_observe" {
			t.Fatal(name)
		}
		reads.Add(1)
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	g := seedObservedWork(t, e)
	done := make(chan error, 1)
	go func() { done <- e.workTick(context.Background()) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("observer did not start")
	}
	_, current, err := e.workRow("case", g.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = e.WorkControl(context.Background(), "case", g.ID, "cancel", current.Revision); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not cancel observation")
	}
	_, current, err = e.workRow("case", g.ID)
	if err != nil || current.Status != "cancelled" || current.ModelRounds != 0 {
		t.Fatal("late result revived cancelled work", current.Status, err)
	}
	if err = e.workTick(context.Background()); err != nil || reads.Load() != 1 {
		t.Fatal("cancelled work was observed again", err)
	}
}

func TestWorkDeadlineAndDependencyStateAreExplicit(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	g := seedObservedWork(t, e)
	row, g, _ := e.workRow("case", g.ID)
	g.DeadlineAt = time.Now().Add(-time.Second)
	if err := e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	if err := e.workTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, after, _ := e.workRow("case", g.ID)
	if after.Status != "paused" {
		t.Fatal("expired goal was not paused", after.Status)
	}
	if err := e.WorkControl(context.Background(), "case", g.ID, "resume", after.Revision); err == nil {
		t.Fatal("restart reset elapsed-time allowance")
	}
	items, err := mergeWorkItems(nil, []WorkItem{{ID: "db", Title: "用户处理数据库"}, {ID: "deploy", Title: "依赖部署", DependsOn: []string{"db"}}, {ID: "build", Title: "独立构建"}})
	if err != nil {
		t.Fatal(err)
	}
	if items[0].ID == "db" || items[1].DependsOn[0] != items[0].ID {
		t.Fatal("model aliases became runtime identities")
	}
	items[0].Status = "waiting_user"
	items[2].Status = "completed"
	if reduceWorkGoal(items) != "waiting_user" {
		t.Fatal("blocked child falsely appeared runnable")
	}
	items[2].Status = "waiting_external"
	if reduceWorkGoal(items) != "waiting_external" {
		t.Fatal("independent external work was blocked by database dependency")
	}
	if _, err = mergeWorkItems(nil, []WorkItem{{ID: "a", Title: "a", DependsOn: []string{"b"}}, {ID: "b", Title: "b", DependsOn: []string{"a"}}}); err == nil {
		t.Fatal("dependency cycle allowed")
	}
}

func TestWorkDeletionRetiresPendingContinuation(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	g := seedObservedWork(t, e)
	if err := e.CancelWorkGoals(context.Background(), "case"); err != nil {
		t.Fatal(err)
	}
	if err := e.workTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, after, err := e.workRow("case", g.ID)
	if err != nil || after.Status != "cancelled" || after.ModelRounds != 0 {
		t.Fatal("deleted owner continued", err, after.Status)
	}
	if err = e.WorkControl(context.Background(), "case", after.ID, "pause", after.Revision); err == nil {
		t.Fatal("late control revived terminal goal")
	}
}

func TestWorkRecoveryRefusesChangedResourceBinding(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	g := seedObservedWork(t, e)
	row, g, _ := e.workRow("case", g.ID)
	g.Binding = WorkBinding{Runtime: "ssh", AssetRef: "original", ResourceIdentity: "frozen-original-configuration"}
	if err := e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	if err := e.resumeWorkGoal(context.Background(), row, g, Config{Model: Model{URL: "http://127.0.0.1:1", Name: "fixture"}}); err != nil {
		t.Fatal(err)
	}
	_, after, err := e.workRow("case", g.ID)
	if err != nil || after.Status != "blocked" || after.ModelRounds != 0 {
		t.Fatal("old work retargeted new resource", err, after.Status)
	}
}

func TestWorkFutureObservationDoesNotReloadOrWriteSessionConfig(t *testing.T) {
	e := engineFor(t, Model{URL: "http://127.0.0.1:1", Name: "fixture"}, nil)
	g := seedObservedWork(t, e)
	row, g, _ := e.workRow("case", g.ID)
	g.Items[0].Watch.NextCheckAt = time.Now().Add(time.Hour)
	if err := e.writeWorkGoal(&row, &g, false); err != nil {
		t.Fatal(err)
	}
	var reloads atomic.Int32
	e.SetWorkConfigurator(func(string) (Config, error) {
		reloads.Add(1)
		return Config{}, errors.New("must not reload before observation due")
	})
	if err := e.workTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if reloads.Load() != 0 {
		t.Fatal("idle wait repeatedly refreshed foreground session configuration")
	}
	_, after, _ := e.workRow("case", g.ID)
	if after.Revision != g.Revision || after.Status != "waiting_external" {
		t.Fatal("idle wait rewrote goal")
	}
}
