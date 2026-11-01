package ai

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func securityProviderFixture(t *testing.T) (*Engine, *adkTurnDriver, Model, *atomic.Int32, SecurityExecutionContext) {
	t.Helper()
	count := &atomic.Int32{}
	model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { count.Add(1); return response("verified provider response") })
	t.Cleanup(closeModel)
	e, c := fixedReadManagedFixture(t, Asset{ID: "resource", Kind: "local"}, security.Rule{Capability: "file.read", Effect: security.EffectAllow})
	execution, err := e.CurrentSecurityExecution(t.Context(), "case")
	if err != nil {
		t.Fatal(err)
	}
	c.Model = model
	c.securityExecution = &execution
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config = c
	root := s.state.View.RootTurnID
	s.mu.Unlock()
	d := &adkTurnDriver{engine: e, session: s, config: &c, providerSecurityRoot: root}
	return e, d, model, count, execution
}
func changeProviderAuthority(t *testing.T, e *Engine, execution SecurityExecutionContext, kind string) {
	t.Helper()
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	if kind == "new-root" {
		state, _ := e.get("case")
		state.mu.Lock()
		state.state.View.RootTurnID = "replacement-user-root"
		state.mu.Unlock()
		return
	}
	err = e.workMutation(db, func(tx *gorm.DB) error {
		switch kind {
		case "expired":
			return tx.Model(&securityTaskRow{}).Where("id = ?", execution.Task.ID).Update("expires_at", time.Now().UTC().Add(-time.Second)).Error
		case "paused":
			_, err := transitionSecurityTask(tx, execution.Task.StoreID, execution.Task.RecoveryEpoch, SecurityTaskAction{ActorID: "user", ActionID: "pause-before-provider", ProjectID: execution.ProjectID, SessionID: execution.SessionID, GoalID: execution.GoalID, TaskID: execution.Task.ID, ExpectedRevision: execution.Task.StateRevision}, security.TaskPaused, time.Now().UTC())
			return err
		case "owner-expired":
			return tx.Model(&securityTaskBinding{}).Where("id = ?", execution.Owner.BindingID).Update("lease_until", time.Now().Add(-time.Second)).Error
		case "fenced":
			return tx.Model(&securityTaskBinding{}).Where("id = ?", execution.Owner.BindingID).Updates(map[string]any{"owner_generation": gorm.Expr("owner_generation+1"), "owner_id": "replacement-host-owner", "lease_until": time.Now().Add(time.Minute)}).Error
		case "goal-revised":
			return tx.Model(&nativeWorkGoal{}).Where("id = ?", execution.GoalID).Update("goal_revision", gorm.Expr("goal_revision+1")).Error
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
func TestSecurityProviderOriginalTaskAuthorityBeforeContinuation(t *testing.T) {
	for _, kind := range []string{"expired", "paused", "fenced", "owner-expired", "new-root", "goal-revised"} {
		t.Run(kind, func(t *testing.T) {
			e, d, model, count, execution := securityProviderFixture(t)
			ctx, _, err := d.securityProviderContext(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			changeProviderAuthority(t, e, execution, kind)
			if _, err = e.stream(ctx, model, []Message{{Role: "user", Content: "continue original task"}}, nil, nil); err == nil || count.Load() != 0 {
				t.Fatal("stale continuation reached actual provider", kind, count.Load(), err)
			}
		})
	}
}
func TestSecurityProviderRechecksAuthorityAfterWaitingForModelSlot(t *testing.T) {
	for _, kind := range []string{"expired", "paused", "fenced", "owner-expired", "new-root", "goal-revised"} {
		t.Run(kind, func(t *testing.T) {
			e, d, model, count, execution := securityProviderFixture(t)
			ctx, _, err := d.securityProviderContext(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < cap(e.modelSlots); i++ {
				e.modelSlots <- struct{}{}
			}
			t.Cleanup(func() {
				for len(e.modelSlots) > 0 {
					<-e.modelSlots
				}
			})
			waiting := make(chan struct{})
			e.ModelActivity = func() func() { close(waiting); return func() {} }
			done := make(chan error, 1)
			go func() {
				_, err := e.stream(ctx, model, []Message{{Role: "user", Content: "queued original task"}}, nil, nil)
				done <- err
			}()
			select {
			case <-waiting:
			case err := <-done:
				t.Fatal("did not wait for slot", err)
			case <-time.After(3 * time.Second):
				t.Fatal("missing queue admission")
			}
			changeProviderAuthority(t, e, execution, kind)
			<-e.modelSlots
			select {
			case err := <-done:
				if err == nil || count.Load() != 0 {
					t.Fatal("slot wait adopted fresh authority", kind, count.Load(), err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("queued provider did not leave after fence")
			}
		})
	}
}
func TestSecurityProviderProposalWithoutTaskAndVerifiedFinalSummaryRemainAllowed(t *testing.T) {
	t.Run("new-real-user-proposal", func(t *testing.T) {
		var count atomic.Int32
		model, closeModel := fakeModel(t, func(_ int, _ map[string]any) any { count.Add(1); return response("requirements proposal only") })
		defer closeModel()
		e := managedEngineFixture(t, model)
		s, _ := e.get("case")
		s.mu.Lock()
		s.state.View.RootTurnID = "actual-new-user-root"
		c := s.state.Config
		s.mu.Unlock()
		d := &adkTurnDriver{engine: e, session: s, config: &c, providerSecurityRoot: "actual-new-user-root"}
		ctx, tools, err := d.securityProviderContext(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = e.stream(ctx, model, []Message{{Role: "user", Content: "explain and propose requirements"}}, tools, nil); err != nil || count.Load() != 1 {
			t.Fatal("proposal forced fake task", count.Load(), err)
		}
	})
	t.Run("verified-final-summary", func(t *testing.T) {
		e, d, model, count, execution := securityProviderFixture(t)
		if _, _, err := d.securityProviderContext(t.Context(), nil); err != nil {
			t.Fatal(err)
		}
		db, _, _, _ := e.securityTaskDB()
		if err := db.Model(&nativeWorkGoal{}).Where("id = ?", execution.GoalID).Update("status", "completed").Error; err != nil {
			t.Fatal(err)
		}
		ctx, tools, err := d.securityProviderContext(t.Context(), []Tool{{Name: "read"}})
		if err != nil || len(tools) != 0 {
			t.Fatal("completed goal advertised new actions", tools, err)
		}
		if _, err = e.stream(ctx, model, []Message{{Role: "user", Content: "report verified final results"}}, tools, nil); err != nil || count.Load() != 1 {
			t.Fatal("legitimate final summary blocked", count.Load(), err)
		}
		if err := db.Model(&securityTaskRow{}).Where("id = ?", execution.Task.ID).Update("expires_at", time.Now().Add(-time.Second)).Error; err != nil {
			t.Fatal(err)
		}
		if _, err = e.stream(ctx, model, nil, nil, nil); err == nil || count.Load() != 1 {
			t.Fatal("expired task used summary as bypass", count.Load(), err)
		}
	})
}
func TestSecurityProviderCannotAdoptReplacementOwnerOnNextRound(t *testing.T) {
	e, d, _, _, execution := securityProviderFixture(t)
	if _, _, err := d.securityProviderContext(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	changeProviderAuthority(t, e, execution, "fenced")
	// Even replacing the host's current projection cannot revive the old driver.
	current := execution
	current.Owner.Generation++
	current.Owner.OwnerID = "replacement-host-owner"
	d.session.mu.Lock()
	d.session.state.Config.securityExecution = &current
	d.session.mu.Unlock()
	d.config.securityExecution = &current
	if _, _, err := d.securityProviderContext(t.Context(), nil); err == nil {
		t.Fatal("old driver adopted replacement owner")
	}
}

func TestSecurityProviderWaitingSlotEndsAtOriginalTaskDeadlineWithoutPolling(t *testing.T) {
	e, d, model, count, execution := securityProviderFixture(t)
	db, _, _, _ := e.securityTaskDB()
	expiry := time.Now().UTC().Add(600 * time.Millisecond)
	if err := db.Model(&securityTaskRow{}).Where("id = ?", execution.Task.ID).Update("expires_at", expiry).Error; err != nil {
		t.Fatal(err)
	}
	ctx, _, err := d.securityProviderContext(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < cap(e.modelSlots); i++ {
		e.modelSlots <- struct{}{}
	}
	defer func() {
		for len(e.modelSlots) > 0 {
			<-e.modelSlots
		}
	}()
	if _, err = e.stream(ctx, model, []Message{{Role: "user", Content: "wait for actual task slot"}}, nil, nil); !errors.Is(err, context.DeadlineExceeded) || count.Load() != 0 {
		t.Fatal("original task deadline did not terminate queued provider", count.Load(), err)
	}
}
func TestSecurityProviderTaskGuardDoesNotReplaceIndependentAuxiliaryConsent(t *testing.T) {
	e, d, model, count, execution := securityProviderFixture(t)
	ctx, _, err := d.securityProviderContext(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	changeProviderAuthority(t, e, execution, "paused")
	// Memory/strategy background workers mark their own auxiliary requests and
	// retain their own consent/epoch checks; this conversation guard adds no
	// task coupling or authority to that pre-existing admission path.
	_, _, err = e.sideCompletion(ctx, model, []Message{{Role: "user", Content: "independent consent-scoped metadata request"}}, "context budget")
	if err != nil || count.Load() != 1 {
		t.Fatal("task floor overrode separate auxiliary admission", count.Load(), err)
	}
}
