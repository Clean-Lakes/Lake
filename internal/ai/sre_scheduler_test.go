package ai

import (
	"context"
	"errors"
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
	err := executeADKPlan(ctx, plan, map[string]bool{}, func(ctx context.Context, step SREPlanStep) error {
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
	err := executeADKPlan(ctx, plan, map[string]bool{}, func(ctx context.Context, step SREPlanStep) error {
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
