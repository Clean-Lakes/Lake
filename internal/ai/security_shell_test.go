//go:build darwin || linux

package ai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

func managedShellFixture(t *testing.T, monitored bool, command string, foreground ...bool) (*Engine, Config, context.Context, context.CancelFunc, *nativeOperation, SecurityExecutionContext, map[string]any) {
	t.Helper()
	e, _, in := managedWorkflowFixture(t)
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	as := Asset{ID: "resource", Kind: "local", Name: "owned test process"}
	metadata := SecurityCatalogResource{ID: as.ID, ProjectID: "project", Kind: "local", Local: true, MetadataDigest: hash("actual-owned-process-resource"), ConnectionIdentity: "local-owned-process-fixture"}
	digest, _, err := catalogConnectionDigest(metadata, map[string]security.CredentialRevision{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND resource_id = ?", "project", as.ID).Updates(map[string]any{"local": true, "kind": "local", "metadata_digest": metadata.MetadataDigest, "connection_digest": digest, "connection_identity": metadata.ConnectionIdentity, "credential_ids": "[]"}).Error; err != nil {
		t.Fatal(err)
	}
	if err = e.SetSecurityCatalogResolver(func(context.Context, SecurityCatalogQuery) (SecurityCatalogView, error) {
		return SecurityCatalogView{ExecutionAssets: []Asset{as}, Resources: []SecurityCatalogResource{metadata}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "compatible", ResourceIDs: []string{as.ID}, Rules: []security.Rule{{Capability: "terminal.execute", Effect: security.EffectAsk, Confirmation: security.ConfirmSingle}, {Capability: "local.execute", Effect: security.EffectAllow}}}
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "process-policy", ProjectID: "project", ExpectedRevision: 2}, policy); err != nil {
		t.Fatal(err)
	}
	binding, err := e.BeginSecurityWorkflowRun(t.Context(), in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.ActivateSecurityWorkflowRun(t.Context(), in.RunID); err != nil {
		t.Fatal(err)
	}
	row, goal, err := e.workRow("case", binding.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.BeginWorkAttempt("case", goal.ID, "inspect", binding.Task.ID, binding.RootTurnID, "", "actual process attempt", row.Revision); err != nil {
		t.Fatal(err)
	}
	if monitored {
		if err = db.Model(&securityTaskRow{}).Where("id = ?", binding.Task.ID).Update("background_policy", "monitored_background").Error; err != nil {
			t.Fatal(err)
		}
	}
	c := Config{Profile: "core", Runtime: "local", SecurityProjectID: "project", Assets: []Asset{as}}
	a := map[string]any{"asset_ref": assetAlias(as.ID), "command": command, "run_in_background": true, "timeout_ms": 30000}
	if len(foreground) > 0 && foreground[0] {
		a["run_in_background"] = false
	}
	call := Call{ID: "original-process", Name: "shell", Arguments: js(a)}
	prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || prepared == nil || decision.Effect != security.EffectApprovalRequired {
		t.Fatal("real opaque command must need original approval", decision, err)
	}
	op := prepared.descriptor
	if err = db.Create(&nativeApproval{ID: "actual-process-approval", SessionID: op.SessionID, RootTurnID: op.RootTurnID, ScopeID: op.ChildScopeID, CallID: op.CallID, StoreID: storeID, RecoveryEpoch: epoch, SecurityTaskID: op.TaskID, DescriptorDigest: prepared.digest, ExecutionRevision: op.ExecutionRevision, Status: "authorized", Accepted: true, CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(SecurityOperationContext(t.Context(), prepared))
	s, _ := e.get("case")
	operation, err := e.dispatchNativeOperation(ctx, s, prepared.executionConfig, call, "dangerous", "owned process", prepared.digest)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	ctx = securityPermitContext(ctx, operation.permit)
	execution, err := e.CurrentSecurityExecution(ctx, "case")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	return e, prepared.executionConfig, ctx, cancel, operation, execution, a
}

func TestSecurityManagedForegroundProcessPauseStopsActualGroupWithoutRefundClaim(t *testing.T) {
	e, c, ctx, cancel, operation, original, a := managedShellFixture(t, false, "sleep 30 & wait", true)
	defer cancel()
	home, _ := os.UserHomeDir()
	finished := make(chan error, 1)
	go func() {
		value, err := e.runManagedProcess(ctx, c, a, []string{platform.Executable("/bin/sh"), "-c", str(a["command"])}, strings.NewReader(""), platform.Environment(home), c.Workspace)
		if persistErr := e.finishNativeOperation(operation, c, value, err); err == nil {
			err = persistErr
		}
		finished <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for e.managedShellByOperation(operation.ID) == nil {
		if time.Now().After(deadline) {
			t.Fatal("foreground process was never owned before execution")
		}
		time.Sleep(5 * time.Millisecond)
	}
	store, _ := e.adkStore()
	var row securityTaskRow
	if err := store.DB.First(&row, "id = ?", original.Task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := e.TransitionSecurityTask(t.Context(), SecurityTaskAction{ActorID: "user", ActionID: "pause-running-process", ProjectID: "project", SessionID: "case", GoalID: original.GoalID, TaskID: original.Task.ID, ExpectedRevision: row.StateRevision}, security.TaskPaused); err != nil {
		t.Fatal(err)
	}
	e.securityRuntimeTick(t.Context(), time.Now().UTC())
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("paused foreground process returned success")
		}
		var notExecuted *ToolNotExecutedError
		if errors.As(err, &notExecuted) {
			t.Fatal("started process cancellation was mislabeled not executed", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pause fenced metadata but left actual foreground process running")
	}
	var op nativeOperation
	if err := store.DB.First(&op, "id = ?", operation.ID).Error; err != nil || op.Status == "not_executed" {
		t.Fatal("started foreground process was refunded/reclassified", op.Status, err)
	}
}

func TestSecurityManagedForegroundBackgroundJobActuallyStopsAndKeepsRisk(t *testing.T) {
	e, c, ctx, cancel, operation, execution, a := managedShellFixture(t, false, "sleep 30 & wait")
	defer cancel()
	value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
		t.Fatal(err)
	}
	job := e.managedShellByOperation(operation.ID)
	if job == nil {
		t.Fatal("actual process ownership not retained")
	}
	if err = e.finishSecurityTurn(execution, false); err != nil {
		t.Fatal(err)
	}
	// The reconciler must cancel the actual owned process, not just mark a row.
	e.securityRuntimeTick(t.Context(), time.Now().UTC())
	select {
	case <-job.done:
	case <-time.After(3 * time.Second):
		t.Fatal("foreground end left the actual process group running")
	}
	adapter := e.ManagedShellCleanupAdapter()
	cleanup := ExecutionCleanup{OperationID: operation.ID, Handle: str(obj(value)["shell_id"]), OwnerID: operation.OwnerID, OwnerGeneration: operation.OwnerGeneration, DescriptorDigest: operation.DescriptorDigest}
	observed, err := adapter.Observe(t.Context(), cleanup)
	if err != nil || !observed.Stopped || observed.EffectsKnown {
		t.Fatal("stop request masqueraded as verified effect closure", observed, err)
	}
	store, _ := e.adkStore()
	if err = CheckResourceWriteBlock(store.DB, "resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("process exit cleared opaque side-effect risk", err)
	}
	_, goal, err := e.workRow("case", operation.GoalID)
	if err != nil || goal.Status == "completed" {
		t.Fatal("process exit completed business goal", goal.Status, err)
	}
}

func TestSecurityManagedMonitoredJobSurvivesTurnButStopsOnRevocation(t *testing.T) {
	e, c, ctx, cancel, operation, execution, a := managedShellFixture(t, true, "sleep 30 & wait")
	defer cancel()
	value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
		t.Fatal(err)
	}
	if err = e.finishSecurityTurn(execution, false); err != nil {
		t.Fatal(err)
	}
	cancel()
	job := e.managedShellByOperation(operation.ID)
	select {
	case <-job.done:
		t.Fatal("explicit monitored job inherited foreground cancellation")
	default:
	}
	store, _ := e.adkStore()
	var row nativeOperation
	if err = store.DB.First(&row, "id = ?", operation.ID).Error; err != nil {
		t.Fatal(err)
	}
	if valid, err := operationHasValidMonitor(store.DB, row, time.Now().UTC()); err != nil || !valid {
		t.Fatal("no original-operation-only monitor", valid, err)
	}
	if err = ValidateExecutionOwner(store.DB, execution.Owner, time.Now().UTC()); err == nil {
		t.Fatal("background kept agent root dispatch authority")
	}
	if err = store.DB.Model(&securityProjectPolicyRow{}).Where("project_id = ?", "project").Update("revision", 4).Error; err != nil {
		t.Fatal(err)
	}
	e.securityRuntimeTick(t.Context(), time.Now().UTC())
	select {
	case <-job.done:
	case <-time.After(3 * time.Second):
		t.Fatal("revoked source left actual monitored process running")
	}
}

func TestSecurityManagedDetachedJobStopsWhenRecoveryGateCloses(t *testing.T) {
	e, c, ctx, cancel, operation, original, a := managedShellFixture(t, true, "sleep 30 & wait")
	defer cancel()
	value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
		t.Fatal(err)
	}
	if err = e.finishSecurityTurn(original, false); err != nil {
		t.Fatal(err)
	}
	store, err := e.adkStore()
	if err != nil {
		t.Fatal(err)
	}
	job := e.managedShellByOperation(operation.ID)
	if err = e.securityHome().RotateRecoveryEpoch(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-job.done:
	case <-time.After(ExecutionOwnerHeartbeat + 3*time.Second):
		t.Fatal("closed recovery gate left owned detached process running")
	}
	if err = CheckResourceWriteBlock(store.DB, "resource"); err != ErrUnresolvedResourceEffect {
		t.Fatal("gate closure or process stop removed unresolved effect quarantine", err)
	}
}

func TestSecurityWorkOriginalObservationClaimsNewRootOnceWithoutTaskRefresh(t *testing.T) {
	e, c, ctx, cancel, operation, original, a := managedShellFixture(t, true, "sleep 0.1; printf observed-original-result")
	defer cancel()
	value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
		t.Fatal(err)
	}
	row, goal, err := e.workRow("case", operation.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	watch := &ExternalWatch{Adapter: "shell-v1", OperationID: operation.ID, Handle: str(obj(value)["shell_id"]), State: "running", NextCheckAt: time.Now()}
	goal.Items[0].Watch = watch
	goal.Items[0].Status = "waiting_external"
	goal.ActiveItemID = ""
	goal.Status = "waiting_external"
	row.WaitCallID, row.WaitState = "original-wait", "waiting"
	row.Checkpoint = js(nativeProjection{View: View{Session: "case", RootTurnID: original.Owner.RootTurnID}, History: []Message{{Role: "user", Content: "actual original request", SourceMessageID: "actual-source-message"}}})
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	if err = e.finishSecurityTurn(original, false); err != nil {
		t.Fatal(err)
	}
	job := e.managedShellByOperation(operation.ID)
	select {
	case <-job.done:
	case <-time.After(3 * time.Second):
		t.Fatal("actual original process did not finish")
	}
	state, err := e.observeWork(t.Context(), goal, watch, c)
	if err != nil || state != "completed" || watch.EvidenceID == "" {
		t.Fatal("original cached outcome not observed", state, err)
	}
	watch.State = state
	goal.Items[0].Status = "running"
	goal.Status = "running"
	row.WaitState = "ready"
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	// A real shell exit is not the reviewed read-source business criterion.
	if _, err = e.VerifyWorkStep("case", goal.ID, goal.Items[0].ID, goal.Revision); err != nil {
		t.Fatal(err)
	}
	_, goal, err = e.workRow("case", goal.ID)
	if err != nil || goal.Items[0].Status == "completed" {
		t.Fatal("exit code completed business acceptance", goal, err)
	}
	resumed, err := e.claimSecurityWorkResume(t.Context(), goal)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Task.ID != original.Task.ID || !resumed.Task.ExpiresAt.Equal(original.Task.ExpiresAt) || resumed.Task.ExecutionRevision != original.Task.ExecutionRevision || resumed.Owner.RootTurnID == original.Owner.RootTurnID || resumed.SourceMessageID != "" {
		t.Fatal("machine event replaced task, refreshed authority or fabricated user source", resumed)
	}
	store, _ := e.adkStore()
	if err = ValidateExecutionOwner(store.DB, original.Owner, time.Now().UTC()); err == nil {
		t.Fatal("old prepared root revived")
	}
	if err = ValidateExecutionOwner(store.DB, resumed.Owner, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err = e.claimSecurityWorkResume(t.Context(), goal); err == nil {
		t.Fatal("same original machine event admitted twice")
	}
	child, err := newEngine(filepath.Join(e.Dir, "fixture-work-parent"), nil, nil, e)
	if err != nil {
		t.Fatal(err)
	}
	defer child.Shutdown()
	c.securityExecution = &resumed
	child.sessions["case"] = &session{state: State{Config: c, SecurityManaged: true, SecurityTaskID: resumed.Task.ID, WorkGoalID: goal.ID, View: View{Session: "case", RootTurnID: resumed.Owner.RootTurnID}}}
	current, err := child.CurrentSecurityExecution(t.Context(), "case")
	if err != nil || current.Task.ID != resumed.Task.ID || current.Owner.RootTurnID != resumed.Owner.RootTurnID {
		t.Fatal("official work-parent clone lost trusted event context", current, err)
	}
	var count int64
	if err = store.DB.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("continuation created a duplicate original operation", count, err)
	}
}

func TestSecurityManagedWorkWaitResumesOfficialSDKFromActualMachineEvent(t *testing.T) {
	var calls atomic.Int32
	var machineEvent atomic.Bool
	model, closeModel := fakeModel(t, func(_ int, input map[string]any) any {
		if calls.Add(1) == 1 {
			return response("", Call{ID: "actual-work-wait", Name: "work_wait", Arguments: `{}`})
		}
		if strings.Contains(js(input["messages"]), "host_external_observation") {
			machineEvent.Store(true)
		}
		return response("原进程已经结束，但业务验收条件尚未满足，保留原目标。")
	})
	defer closeModel()
	e, c, ctx, cancel, operation, original, a := managedShellFixture(t, true, "sleep 0.1; printf actual-sdk-result")
	defer cancel()
	c.Model = model
	c.MaxSteps = 12
	value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config = c
	s.state.History = []Message{{Role: "user", Content: "实际原请求：跟进原任务并验收结果", SourceMessageID: "original-human-source"}}
	s.state.RootQuestion = s.state.History[0].Content
	s.mu.Unlock()
	if err = e.registerWorkWatch(s, c, Call{ID: "original-process", Name: "shell", Arguments: js(a)}, value); err != nil {
		t.Fatal(err)
	}
	if err = e.runOfficialADK(t.Context(), s, &c, false, func() {}); err != nil {
		t.Fatal(err)
	}
	if err = e.workCheckpoint(s); err != nil {
		t.Fatal(err)
	}
	if err = e.finishSecurityTurn(original, false); err != nil {
		t.Fatal(err)
	}
	job := e.managedShellByOperation(operation.ID)
	select {
	case <-job.done:
	case <-time.After(3 * time.Second):
		t.Fatal("original process still running")
	}
	row, goal, err := e.workRow("case", operation.GoalID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Checkpoint == "" || row.WaitCallID != "actual-work-wait" || goal.Items[0].Watch == nil {
		t.Fatal("official wait source not persisted", row.WaitCallID, goal)
	}
	goal.Items[0].Watch.NextCheckAt = time.Now().Add(-time.Second)
	if err = e.writeWorkGoal(&row, &goal, false); err != nil {
		t.Fatal(err)
	}
	if err = e.workTick(t.Context()); err != nil {
		t.Fatal(err)
	}
	if !machineEvent.Load() || calls.Load() < 2 {
		t.Fatal("original wait did not resume official provider via machine input", calls.Load())
	}
	store, _ := e.adkStore()
	var admitted securityWorkResumeRow
	if err = store.DB.First(&admitted, "operation_id = ?", operation.ID).Error; err != nil || admitted.RootTurnID == original.Owner.RootTurnID {
		t.Fatal("no new root bound to actual original result", admitted, err)
	}
	row, goal, err = e.workRow("case", operation.GoalID)
	if err != nil || goal.Status == "completed" {
		t.Fatal("SDK summary bypassed required business proof", goal.Status, err)
	}
	var projection nativeProjection
	if err = json.Unmarshal([]byte(row.Checkpoint), &projection); err != nil {
		t.Fatal(err)
	}
	if projection.Runtime == nil || projection.Runtime.Identity.RootTurnID != admitted.RootTurnID {
		t.Fatal("SDK reused original root identity", projection.Runtime)
	}
	users := 0
	for _, message := range projection.History {
		if message.SourceMessageID == "original-human-source" {
			users++
		}
	}
	if users != 1 {
		t.Fatal("machine wake fabricated or duplicated real user source", users)
	}
	var task securityTaskRow
	if err = store.DB.First(&task, "id = ?", original.Task.ID).Error; err != nil || !task.ExpiresAt.Equal(original.Task.ExpiresAt) {
		t.Fatal("SDK continuation refreshed task TTL", task.ExpiresAt, err)
	}
	var count int64
	if err = store.DB.Model(&nativeOperation{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("SDK continuation replayed original command", count, err)
	}
}

func TestSecurityWorkMachineResumeRejectsExpiryRevocationAndUnregisteredObserver(t *testing.T) {
	for _, kind := range []string{"expired-task", "revoked-policy", "foreign-source", "opaque-observer"} {
		t.Run(kind, func(t *testing.T) {
			e, c, ctx, cancel, operation, original, a := managedShellFixture(t, true, "sleep 0.1; printf original-machine-source")
			defer cancel()
			value, err := e.startManagedShell(ctx, c, a, str(a["command"]))
			if err != nil {
				t.Fatal(err)
			}
			if err = e.finishNativeOperation(operation, c, value, nil); err != nil {
				t.Fatal(err)
			}
			row, goal, err := e.workRow("case", operation.GoalID)
			if err != nil {
				t.Fatal(err)
			}
			watch := &ExternalWatch{Adapter: "shell-v1", OperationID: operation.ID, Handle: str(obj(value)["shell_id"]), State: "running"}
			goal.Items[0].Watch = watch
			goal.Items[0].Status = "waiting_external"
			goal.ActiveItemID = ""
			goal.Status = "waiting_external"
			if err = e.writeWorkGoal(&row, &goal, false); err != nil {
				t.Fatal(err)
			}
			if err = e.finishSecurityTurn(original, false); err != nil {
				t.Fatal(err)
			}
			job := e.managedShellByOperation(operation.ID)
			select {
			case <-job.done:
			case <-time.After(3 * time.Second):
				t.Fatal("source process did not finish")
			}
			state, err := e.observeWork(t.Context(), goal, watch, c)
			if err != nil || state != "completed" {
				t.Fatal(state, err)
			}
			watch.State = state
			goal.Items[0].Status = "running"
			goal.Status = "running"
			if err = e.writeWorkGoal(&row, &goal, false); err != nil {
				t.Fatal(err)
			}
			store, _ := e.adkStore()
			switch kind {
			case "expired-task":
				err = store.DB.Model(&securityTaskRow{}).Where("id = ?", original.Task.ID).Update("expires_at", time.Now().Add(-time.Second)).Error
			case "revoked-policy":
				err = store.DB.Model(&securityProjectPolicyRow{}).Where("project_id = ?", "project").Update("revision", 4).Error
			case "foreign-source":
				err = store.DB.Model(&nativeWorkObservation{}).Where("id = ?", watch.EvidenceID).Update("operation_id", "other-operation").Error
			case "opaque-observer":
				var external atomic.Int32
				e.Bridge = func(context.Context, string, string, map[string]any, bool) (any, error) {
					external.Add(1)
					return nil, nil
				}
				_, observeErr := e.observeWork(t.Context(), goal, &ExternalWatch{Adapter: "release-v1", OperationID: operation.ID, Handle: "external-order", ServerID: "server"}, c)
				if observeErr == nil || external.Load() != 0 {
					t.Fatal("opaque observer called external service without its own permit", observeErr, external.Load())
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = e.claimSecurityWorkResume(t.Context(), goal); err == nil {
				t.Fatal("invalid machine source created fresh execution authority", kind)
			}
			var count int64
			if err = store.DB.Model(&securityWorkResumeRow{}).Count(&count).Error; err != nil || count != 0 {
				t.Fatal("rejected wakeup left source/owner records", count, err)
			}
		})
	}
}
