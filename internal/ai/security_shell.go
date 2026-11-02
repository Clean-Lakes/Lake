package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// Managed shells are actual local owned processes. Their original permit is
// consumed once before Start; a monitor can observe/cancel this handle only.
func (e *Engine) startManagedShell(ctx context.Context, c Config, a map[string]any, command string, source ...map[string]any) (any, error) {
	if strings.TrimSpace(command) == "" || len(command) > 20000 {
		return nil, &ToolNotExecutedError{Err: errors.New("security: invalid background command")}
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return nil, &ToolNotExecutedError{Err: errors.New("security: owned background process groups unsupported on this platform")}
	}
	if err := e.requireSecurityAdapterContext(ctx, c); err != nil {
		return nil, err
	}
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.prepared == nil || p.operation.Tool != "shell" || len(p.operation.Resources) != 1 || !p.operation.Resources[0].Local || str(p.prepared.executionArgs["command"]) != command {
		return nil, &ToolNotExecutedError{Err: errors.New("security: exact approved local background command required")}
	}
	if p.operation.ChildScopeID != "" {
		return nil, &ToolNotExecutedError{Err: errors.New("security: child background continuation requires an explicit parent monitor adapter; no process started")}
	}
	target := str(a["runtime"])
	if target == "" {
		target = c.Runtime
	}
	if target != "" && target != "local" {
		return nil, &ToolNotExecutedError{Err: errors.New("security: background remote/container execution needs a frozen observer adapter")}
	}
	actual := map[string]any{}
	for key, value := range a {
		if !strings.HasPrefix(key, "__") {
			actual[key] = value
		}
	}
	if hash(js(actual)) != p.operation.ArgumentsDigest {
		return nil, &ToolNotExecutedError{Err: errors.New("security: background arguments changed")}
	}
	home, _ := os.UserHomeDir()
	return e.startOwnedManagedProcess(ctx, c, a, []string{platform.Executable("/bin/sh"), "-c", command}, platform.Environment(home), c.Workspace, true, false, false, source...)
}

// Foreground process profiles retain the compiler's exact executable, argv,
// environment and cwd. Raw local Shell requires its exact single-action permit.
func (e *Engine) runManagedProcess(ctx context.Context, c Config, a map[string]any, argv []string, input io.Reader, environment []string, directory string) (map[string]any, error) {
	if err := e.requireSecurityAdapterContext(ctx, c); err != nil {
		return nil, err
	}
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	emptyInput := input == nil
	if sized, ok := input.(interface{ Len() int }); ok && sized.Len() == 0 {
		emptyInput = true
	}
	if p == nil || p.prepared == nil || len(argv) == 0 || len(p.operation.Resources) != 1 || !p.operation.Resources[0].Local || !emptyInput {
		return nil, &ToolNotExecutedError{Err: errors.New("security: owned local process requires an exact registered profile; remote/stdin adapters remain closed")}
	}
	frozen, hasFrozen, err := checkFrozenRuntimeCommand(ctx, argv)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	readOnly := false
	if hasFrozen {
		profile := frozen.Profile()
		actual := struct {
			Executable             string
			Arguments, Environment []string
			Directory              string
		}{argv[0], argv[1:], environment, directory}
		if p.operation.Proof != security.ProofCommandProfile || p.operation.CommandProfileID != profile.ID || p.operation.CommandProfileVersion != profile.Version || p.operation.CommandArgumentsDigest != profile.ArgumentsDigest || !slices.Equal(environment, frozen.Environment()) || directory != frozen.Directory() || hash(js(actual)) != p.operation.ArgumentsDigest {
			return nil, &ToolNotExecutedError{Err: errors.New("security: frozen process argv/environment/cwd changed")}
		}
		readOnly = securityReadOnlyCapability(frozen.Capability())
	} else {
		home, _ := os.UserHomeDir()
		if p.operation.Proof != security.ProofOpaque || p.operation.Tool != "shell" || !slices.Equal(argv, []string{platform.Executable("/bin/sh"), "-c", str(p.prepared.executionArgs["command"])}) || !slices.Equal(environment, platform.Environment(home)) || directory != c.Workspace {
			return nil, &ToolNotExecutedError{Err: errors.New("security: unregistered foreground process command")}
		}
	}
	value, err := e.startOwnedManagedProcess(ctx, c, a, argv, environment, directory, false, readOnly, false)
	return obj(value), err
}

func (e *Engine) startOwnedManagedProcess(ctx context.Context, c Config, a map[string]any, argv, environment []string, directory string, background, readOnly, remoteTransport bool, source ...map[string]any) (any, error) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		return nil, &ToolNotExecutedError{Err: errors.New("security: owned process groups unsupported on this platform")}
	}
	p, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if p == nil || p.prepared == nil {
		return nil, &ToolNotExecutedError{Err: errors.New("security: original process permit required")}
	}
	owner, err := securityRootEngine(e)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	var task securityTaskRow
	if err = db.First(&task, "id = ? AND store_id = ? AND recovery_epoch = ?", p.operation.TaskID, storeID, epoch).Error; err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	if !task.ExpiresAt.After(time.Now().UTC()) {
		return nil, &ToolNotExecutedError{Err: errors.New("security: task expired before background start")}
	}
	base := ctx
	if background && task.BackgroundPolicy == "monitored_background" {
		base = context.WithoutCancel(ctx)
	}
	deadline := time.Now().Add(duration(a))
	if task.ExpiresAt.Before(deadline) {
		deadline = task.ExpiresAt
	}
	jobContext, cancel := context.WithDeadline(base, deadline)
	id := "managed_" + uid()
	j := &shellJob{id: id, session: p.operation.SessionID, operationID: p.operation.ID, ownerID: p.operation.OwnerID, ownerGeneration: p.operation.OwnerGeneration, descriptorDigest: p.digest, taskID: p.operation.TaskID, resourceID: p.operation.Resources[0].ID, goalID: p.operation.GoalID, managed: true, remoteTransport: remoteTransport, effectsKnownOnStop: readOnly && !remoteTransport, config: c, cancel: cancel, done: make(chan struct{}), status: "running"}
	cmd := exec.CommandContext(jobContext, argv[0], argv[1:]...)
	setupProcess(cmd)
	cmd.Env = append([]string(nil), environment...)
	cmd.Dir = directory
	outputLimit := bounded(num(a["__output_limit"], 100000), 100000, 3<<20)
	output := &limitBuffer{limit: outputLimit}
	stdout := &limitBuffer{limit: outputLimit}
	stderr := &limitBuffer{limit: outputLimit}
	cmd.Stdout = io.MultiWriter(output, stdout)
	cmd.Stderr = io.MultiWriter(output, stderr)
	owner.shellMu.Lock()
	if owner.shellsClosed {
		owner.shellMu.Unlock()
		cancel()
		return nil, &ToolNotExecutedError{Err: context.Canceled}
	}
	count := 0
	owner.shells.Range(func(_, value any) bool {
		job := value.(*shellJob)
		job.mu.Lock()
		running := job.status == "running"
		job.mu.Unlock()
		if running {
			count++
		}
		return true
	})
	if count >= 16 {
		owner.shellMu.Unlock()
		cancel()
		return nil, &ToolNotExecutedError{Err: errors.New("background shell limit reached")}
	}
	err = e.validateSecurityPermitAtIO(ctx, p.operation.ProjectID, p.operation.SessionID, func(SecurityCatalogView) error {
		if err := cmd.Start(); err != nil {
			return err
		}
		owner.shells.Store(j.session+":"+id, j)
		updated := db.Model(&nativeOperation{}).Where("id = ? AND owner_id = ? AND owner_generation = ? AND status = ?", j.operationID, j.ownerID, j.ownerGeneration, "dispatched").Update("handle", id)
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return errExecutionOwner
		}
		return nil
	})
	owner.shellMu.Unlock()
	if err != nil {
		cancel()
		if cmd.Process != nil {
			_ = cmd.Wait()
			j.mu.Lock()
			j.status = "interrupted"
			j.err = errors.New("owned process started before persistence failed; effects unknown")
			j.completedAt = time.Now().UTC()
			j.mu.Unlock()
			close(j.done)
			return nil, errors.New("security: process started before background persistence failed; outcome unknown")
		}
		return nil, &ToolNotExecutedError{Err: err}
	}
	owner.ensureManagedShellCleanup()
	if background && owner.CheckSecurityRuntime() == nil {
		owner.shellCard(j.session, id, "", "background_running", true, source...)
	}
	go owner.watchManagedShellAuthority(j)
	go func() {
		waitErr := cmd.Wait()
		cause := jobContext.Err()
		cancel()
		code := 0
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		result := map[string]any{"output": redact(output.String(), c), "stdout": redact(stdout.String(), c), "stderr": redact(stderr.String(), c), "exitCode": code, "truncated": output.Len() >= output.limit}
		var outcomeErr error
		if cause != nil {
			outcomeErr = errors.New("owned process stopped; effects require verification")
		} else if waitErr != nil && code < 0 {
			outcomeErr = errors.New("owned process outcome unknown")
		}
		if remoteTransport && code == 255 {
			outcomeErr = runtimeSSHFailure(stderr.String())
		}
		j.mu.Lock()
		j.result = result
		j.err = outcomeErr
		j.completedAt = time.Now().UTC()
		j.status = "completed"
		if outcomeErr != nil {
			j.status = "interrupted"
		} else if code != 0 {
			j.status = "failed"
		}
		status := j.status
		j.mu.Unlock()
		close(j.done)
		_ = owner.completeManagedShellOperation(j.operationID)
		if background && owner.CheckSecurityRuntime() == nil {
			owner.shellCard(j.session, id, js(result), status, false)
		}
	}()
	if !background {
		<-j.done
		value, outcomeErr, _ := owner.managedShellFinalResult(j.operationID, nil)
		return value, outcomeErr
	}
	return map[string]any{"shell_id": id, "status": "running", "poll_after_ms": 1000}, nil
}

// Losing the Home gate or durable authority must also stop an already-started
// owned process. This observer creates no permits, renewals, commands or grants.
func (e *Engine) watchManagedShellAuthority(job *shellJob) {
	ticker := time.NewTicker(ExecutionOwnerHeartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-job.done:
			return
		case now := <-ticker.C:
			probe, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			db, storeID, epoch, err := e.securityTaskDB()
			if err == nil {
				var op nativeOperation
				err = db.WithContext(probe).First(&op, "id = ? AND owner_id = ? AND owner_generation = ?", job.operationID, job.ownerID, job.ownerGeneration).Error
				if err == nil {
					var descriptor security.PreparedOperation
					if json.Unmarshal([]byte(op.SecurityDescriptor), &descriptor) != nil {
						err = errExecutionOwner
					} else if descriptor.LocalExecution {
						view, lookupErr := e.currentSecurityCatalog(probe, SecurityCatalogQuery{ProjectID: op.ProjectID, SessionID: op.SessionID, ResourceIDs: securityCatalogResources(descriptor.Resources)})
						if lookupErr != nil {
							err = lookupErr
						} else if view.HardLocalDeny {
							err = errors.New("security: current session forbids local execution")
						}
					}
				}
				if err == nil {
					var orphan bool
					orphan, err = orphanedExecution(db.WithContext(probe), op, storeID, epoch, now.UTC())
					if orphan {
						err = errExecutionOwner
					}
				}
			}
			cancel()
			if err != nil {
				job.mu.Lock()
				job.cancellationRequested = true
				job.mu.Unlock()
				job.cancel()
				return
			}
		}
	}
}

func (e *Engine) managedShellByOperation(operationID string) *shellJob {
	owner, err := securityRootEngine(e)
	if err != nil {
		return nil
	}
	var found *shellJob
	owner.shells.Range(func(_, value any) bool {
		job := value.(*shellJob)
		if job.managed && job.operationID == operationID {
			found = job
			return false
		}
		return true
	})
	return found
}

func (e *Engine) managedShellFinalResult(operationID string, original any) (any, error, bool) {
	job := e.managedShellByOperation(operationID)
	if job == nil {
		return original, nil, false
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	if job.status == "running" {
		return original, nil, false
	}
	value := map[string]any{}
	for key, item := range obj(job.result) {
		value[key] = item
	}
	value["shell_id"] = job.id
	value["status"] = job.status
	if job.err != nil {
		value["status"] = "unknown"
	}
	return value, job.err, true
}

// Only cached actual process outcomes can finish their original operation.
// Call after the initial running result commits, and from the process waiter.
func (e *Engine) completeManagedShellOperation(operationID string) error {
	job := e.managedShellByOperation(operationID)
	if job == nil {
		return nil
	}
	value, outcomeErr, done := e.managedShellFinalResult(operationID, nil)
	if !done {
		return nil
	}
	db, _, _, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		var op nativeOperation
		if err := tx.First(&op, "id = ? AND owner_id = ? AND owner_generation = ?", operationID, job.ownerID, job.ownerGeneration).Error; err != nil {
			return err
		}
		if op.Status != "dispatched" || op.Result == "" || op.Handle != job.id {
			return nil
		}
		status := "succeeded"
		if outcomeErr != nil {
			status = "unknown"
		} else if num(obj(value)["exitCode"], -1) != 0 {
			status = "failed"
		}
		updates := map[string]any{"status": status, "result": utf8Prefix(redact(js(value), job.config), 32000), "finished_at": time.Now().UTC()}
		if (status == "unknown" || status == "failed") && op.Risk != "readonly" {
			updates["orphan_state"] = "effects_unknown"
			updates["closure_state"] = "effects_unknown"
		}
		job.mu.Lock()
		cancelRequested := job.cancellationRequested
		job.mu.Unlock()
		if cancelRequested && !job.remoteTransport {
			updates["cancellation_state"] = string(CancellationConfirmed)
		}
		changed := tx.Model(&nativeOperation{}).Where("id = ? AND status = ? AND result = ?", op.ID, "dispatched", op.Result).Updates(updates)
		if changed.Error != nil || changed.RowsAffected == 0 {
			return changed.Error
		}
		evidenceStatus := "completed"
		if status != "succeeded" {
			evidenceStatus = status
		}
		return e.appendNativeEvidence(tx, &nativeEvidence{OperationID: op.ID, SessionID: op.SessionID, CallID: op.CallID, Tool: op.Tool, Status: evidenceStatus, Data: utf8Prefix(redact(js(value), job.config), 32000), At: time.Now().UTC()})
	})
}

type managedShellCleanupAdapter struct{ engine *Engine }

func (e *Engine) ManagedShellCleanupAdapter() OrphanCleanupAdapter {
	return &managedShellCleanupAdapter{engine: e}
}

func (a *managedShellCleanupAdapter) job(cleanup ExecutionCleanup) (*shellJob, error) {
	job := a.engine.managedShellByOperation(cleanup.OperationID)
	if job == nil || job.id != cleanup.Handle || job.ownerID != cleanup.OwnerID || job.ownerGeneration != cleanup.OwnerGeneration || cleanup.DescriptorDigest == "" || job.descriptorDigest != cleanup.DescriptorDigest {
		return nil, errors.New("security: original owned process unavailable; no PID guessing")
	}
	return job, nil
}
func (a *managedShellCleanupAdapter) Cancel(_ context.Context, cleanup ExecutionCleanup) (CancellationObservation, error) {
	job, err := a.job(cleanup)
	if err != nil {
		return CancellationUnsupported, err
	}
	job.mu.Lock()
	job.cancellationRequested = true
	job.mu.Unlock()
	job.cancel()
	select {
	case <-job.done:
		if job.remoteTransport {
			return CancellationRequested, nil
		}
		return CancellationConfirmed, nil
	default:
		return CancellationRequested, nil
	}
}
func (a *managedShellCleanupAdapter) Observe(_ context.Context, cleanup ExecutionCleanup) (OrphanObservation, error) {
	job, err := a.job(cleanup)
	if err != nil {
		return OrphanObservation{}, err
	}
	select {
	case <-job.done:
	default:
		return OrphanObservation{}, nil
	}
	_ = a.engine.completeManagedShellOperation(cleanup.OperationID)
	job.mu.Lock()
	defer job.mu.Unlock()
	// Stopped is observed, but arbitrary approved Shell cannot prove its own
	// effects. Keep quarantine until a trusted business/compensation verifier.
	return OrphanObservation{Stopped: !job.remoteTransport, EffectsKnown: job.effectsKnownOnStop, Status: "failed", Evidence: hash(js(job.result))}, nil
}
func (e *Engine) ensureManagedShellCleanup() {
	owner, err := securityRootEngine(e)
	if err != nil {
		return
	}
	owner.securityLifeMu.Lock()
	defer owner.securityLifeMu.Unlock()
	if owner.securityCleanupResolver == nil {
		owner.securityCleanupResolver = composeManagedShellCleanup(owner, nil)
	}
}

type managedShellCleanupRouter struct{ owned, other OrphanCleanupAdapter }

func (a *managedShellCleanupRouter) Cancel(ctx context.Context, cleanup ExecutionCleanup) (CancellationObservation, error) {
	if strings.HasPrefix(cleanup.Handle, "managed_") {
		return a.owned.Cancel(ctx, cleanup)
	}
	if a.other != nil {
		return a.other.Cancel(ctx, cleanup)
	}
	return CancellationUnsupported, errors.New("security: no registered cleanup adapter for original handle")
}
func (a *managedShellCleanupRouter) Observe(ctx context.Context, cleanup ExecutionCleanup) (OrphanObservation, error) {
	if strings.HasPrefix(cleanup.Handle, "managed_") {
		return a.owned.Observe(ctx, cleanup)
	}
	if a.other != nil {
		return a.other.Observe(ctx, cleanup)
	}
	return OrphanObservation{}, errors.New("security: original handle is not observable")
}
func composeManagedShellCleanup(owner *Engine, other OrphanAdapterResolver) OrphanAdapterResolver {
	return func(tool, resource string) OrphanCleanupAdapter {
		var fallback OrphanCleanupAdapter
		if other != nil {
			fallback = other(tool, resource)
		}
		if tool == "shell" {
			return &managedShellCleanupRouter{owned: owner.ManagedShellCleanupAdapter(), other: fallback}
		}
		return fallback
	}
}

func (e *Engine) recordedManagedShellOutput(ctx context.Context, session, requested string) (any, error) {
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if permit == nil || permit.operation.SessionID != session || requested == "" || len(requested) > 200 {
		return nil, errors.New("security: exact original cached shell record required")
	}
	if permit.operation.Tool != "shell_output" && permit.operation.Tool != "wait_shell" {
		return nil, errors.New("security: lost shell handles cannot be terminated or replayed")
	}
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	var op nativeOperation
	if err = store.DB.WithContext(ctx).First(&op, "session_id = ? AND tool = ? AND (id = ? OR handle = ?)", session, "shell", requested, requested).Error; err != nil {
		return nil, err
	}
	status := "unknown"
	switch op.Status {
	case "succeeded":
		status = "completed"
	case "failed", "not_executed":
		status = "failed"
	case "dispatched":
		status = "running"
	}
	return map[string]any{"shell_id": op.Handle, "operation_id": op.ID, "status": status, "result": objJSON(op.Result), "notice": "Original cached record only; no resource polling, execution replay or business acceptance."}, nil
}
