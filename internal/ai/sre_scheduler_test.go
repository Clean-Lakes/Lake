package ai

import (
	"context"
	"errors"
	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	adksession "google.golang.org/adk/v2/session"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSRESchedulerParallelRoleLanesExclusiveActionAndDependencies(t *testing.T) {
	plan := SREPlanRevision{Steps: []SREPlanStep{{ID: "a", Role: SREInvestigator}, {ID: "b", Role: SREInvestigator}, {ID: "c", Role: SRECoordinator}, {ID: "act", Role: SREExecutor, Kind: "act", DependsOn: []string{"c"}}, {ID: "v", Role: SREVerifier, DependsOn: []string{"act"}}, {ID: "summary", Role: SRECoordinator, DependsOn: []string{"a", "b", "v"}}}}
	var mu sync.Mutex
	running := 0
	peak := 0
	roles := map[SREAgentRole]int{}
	done := map[string]bool{}
	arrivals := 0
	release := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := executeADKPlan(ctx, plan, func(ctx context.Context, step SREPlanStep) error {
		mu.Lock()
		running++
		if running > peak {
			peak = running
		}
		roles[step.Role]++
		if roles[step.Role] > 1 {
			t.Error("same role concurrently occupied two lanes")
		}
		if step.Kind == "act" && running != 1 {
			t.Error("action overlapped another specialist")
		}
		for _, dep := range step.DependsOn {
			if !done[dep] {
				t.Error("dependency not completed", step.ID, dep)
			}
		}
		if step.ID == "a" || step.ID == "c" {
			arrivals++
			if arrivals == 2 {
				close(release)
			}
		}
		mu.Unlock()
		if step.ID == "a" || step.ID == "c" {
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		mu.Lock()
		done[step.ID] = true
		running--
		roles[step.Role]--
		mu.Unlock()
		return nil
	})
	if err != nil || peak < 2 || len(done) != len(plan.Steps) {
		t.Fatal("scheduler did not complete parallel dependency graph", err, peak, done)
	}
}

func TestSRESchedulerFailureCancelsAndDrainsPeers(t *testing.T) {
	plan := SREPlanRevision{Steps: []SREPlanStep{{ID: "fail", Role: SREInvestigator}, {ID: "peer", Role: SRECoordinator}, {ID: "never", Role: SREVerifier, DependsOn: []string{"fail"}}}}
	peerStarted, peerStopped := make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := executeADKPlan(ctx, plan, func(ctx context.Context, step SREPlanStep) error {
		switch step.ID {
		case "fail":
			select {
			case <-peerStarted:
				return errors.New("original failure")
			case <-ctx.Done():
				return ctx.Err()
			}
		case "peer":
			close(peerStarted)
			<-ctx.Done()
			close(peerStopped)
			return ctx.Err()
		default:
			t.Error("dependent work started after failure")
			return nil
		}
	})
	if err == nil || !strings.Contains(err.Error(), "original failure") {
		t.Fatal("original failure lost", err)
	}
	select {
	case <-peerStopped:
	default:
		t.Fatal("parent released while a peer was still running")
	}
}

func TestSREGraphDurableOutputsSurviveRestartAndExplicitRetry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.sqlite")
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	plan := SREPlanRevision{Goal: "test", Steps: []SREPlanStep{{ID: "sample", Role: SREInvestigator}, {ID: "report", Role: SRECoordinator, DependsOn: []string{"sample"}}}}
	counts := map[string]int{}
	run := func(store *storage.Store, fail bool) error {
		return executeADKPlan(context.Background(), plan, func(_ context.Context, step SREPlanStep) error {
			counts[step.ID]++
			if step.ID == "report" && fail {
				return errors.New("report failed")
			}
			return nil
		}, adkPlanSession{service: store.Sessions, id: "durable"})
	}
	if err = run(store, true); err == nil {
		t.Fatal("expected failure")
	}
	saved, err := store.Sessions.Get(context.Background(), &adksession.GetRequest{AppName: "lake_sre", UserID: "lake", SessionID: "durable"})
	if err != nil {
		t.Fatal(err)
	}
	nativeOutput := false
	for ev := range saved.Session.Events().All() {
		if ev.Output != nil && ev.NodeInfo != nil && sreStepFromNodePath(ev.NodeInfo.Path) == "sample" {
			nativeOutput = true
		}
	}
	if !nativeOutput {
		t.Fatal("successful step has no native ADK output event")
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = run(store, false); err != nil {
		t.Fatal(err)
	}
	if counts["sample"] != 1 || counts["report"] != 2 {
		t.Fatal("successful step replayed or failed step not retried", counts)
	}
	if err = run(store, false); err != nil {
		t.Fatal(err)
	}
	if counts["sample"] != 1 || counts["report"] != 2 {
		t.Fatal("completed graph dispatched again", counts)
	}
	// A plan run is immutable; cached work cannot be applied to changed inputs.
	plan.Steps[0].Description = "changed frozen input"
	if err = run(store, false); err == nil {
		t.Fatal("changed plan silently reused a result")
	}
}

func TestSREGraphExternalCancellationDrainsAndDoesNotStartDependents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, stopped := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	plan := SREPlanRevision{Steps: []SREPlanStep{{ID: "work", Role: SREInvestigator}, {ID: "dependent", Role: SRECoordinator, DependsOn: []string{"work"}}}}
	go func() {
		done <- executeADKPlan(ctx, plan, func(ctx context.Context, step SREPlanStep) error {
			if step.ID != "work" {
				t.Error("dependent executed after cancel")
				return nil
			}
			close(started)
			<-ctx.Done()
			close(stopped)
			return ctx.Err()
		})
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("node did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("cancellation identity lost", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("graph did not drain")
	}
	select {
	case <-stopped:
	default:
		t.Fatal("returned while cancelled work remained alive")
	}
}

func TestSREGraphImportsOnlyProvenLegacyResults(t *testing.T) {
	service := adksession.InMemoryService()
	plan := SREPlanRevision{Steps: []SREPlanStep{{ID: "act", Role: SREExecutor, Kind: "act"}, {ID: "verify", Role: SREVerifier, DependsOn: []string{"act"}}}}
	calls := 0
	imports := 0
	options := adkPlanSession{service: service, id: "legacy", importResult: func(step SREPlanStep, legacy bool) bool { imports++; return legacy && step.ID == "act" }}
	if err := executeADKPlan(context.Background(), plan, func(_ context.Context, step SREPlanStep) error {
		if step.ID == "act" {
			t.Error("proven legacy action replayed")
		}
		calls++
		return nil
	}, options); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || imports != 2 {
		t.Fatal(calls, imports)
	}
	if err := executeADKPlan(context.Background(), plan, func(context.Context, SREPlanStep) error { t.Error("cached work executed"); return nil }, options); err != nil {
		t.Fatal(err)
	}
	if imports != 2 {
		t.Fatal("native run kept consulting legacy attempt state")
	}
}

func TestSREGraphRejectsInvalidDependenciesBeforeDispatch(t *testing.T) {
	for _, steps := range [][]SREPlanStep{
		{{ID: "a", DependsOn: []string{"absent"}}},
		{{ID: "a", DependsOn: []string{"b"}}, {ID: "b", DependsOn: []string{"a"}}},
		{{ID: "a"}, {ID: "a"}},
	} {
		if err := executeADKPlan(context.Background(), SREPlanRevision{Steps: steps}, func(context.Context, SREPlanStep) error { t.Error("invalid graph dispatched"); return nil }); err == nil {
			t.Fatal("invalid graph accepted")
		}
	}
}

type failingPlanSessionService struct{ adksession.Service }

func (failingPlanSessionService) Get(context.Context, *adksession.GetRequest) (*adksession.GetResponse, error) {
	return nil, errors.New("checkpoint storage unavailable")
}
func TestSREGraphStorageFailureCannotBecomeFreshDispatch(t *testing.T) {
	if err := executeADKPlan(context.Background(), SREPlanRevision{Steps: []SREPlanStep{{ID: "act", Role: SREExecutor, Kind: "act"}}}, func(context.Context, SREPlanStep) error {
		t.Error("storage failure caused a fresh dispatch")
		return nil
	}, adkPlanSession{service: failingPlanSessionService{}, id: "unavailable"}); err == nil {
		t.Fatal("storage error ignored")
	}
}
