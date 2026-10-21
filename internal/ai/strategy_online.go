package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/strategy"
	"google.golang.org/adk/v2/artifact"
	"gorm.io/gorm"
)

const onlineRevisionTool = "revise_readonly_strategy"

// This host-owned record is authoritative even when an older ADK UI projection
// is recovered. A role, plan change or process restart cannot refund counters.
type nativeCorrection struct {
	ID        string `gorm:"primaryKey"`
	SessionID string `gorm:"index"`
	Body      string
	UpdatedAt time.Time
}

func (e *Engine) refreshOnlineCards(s *session) error {
	s.mu.Lock()
	id := s.state.View.Session
	s.mu.Unlock()
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	owner := e
	if e.worker != nil {
		owner = e.worker.parent
	}
	if _, ok := owner.onlineSessions.Load(id); !ok {
		return nil
	}
	owner.correctionMu.Lock()
	defer owner.correctionMu.Unlock()
	var rows []nativeCorrection
	if err := store.DB.Where("session_id = ?", id).Order("updated_at DESC").Limit(100).Find(&rows).Error; err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range rows {
		var r strategy.OnlineReport
		if json.Unmarshal([]byte(row.Body), &r) != nil {
			return errors.New("invalid correction report")
		}
		card := Card{ID: "correction_" + row.ID, Type: "strategy_correction", Title: "只读纠错", Status: "running", At: r.StartedAt, Data: r}
		if r.StopReason != "" {
			card.Status = "completed"
		}
		found := false
		for i := range s.state.View.Cards {
			if s.state.View.Cards[i].ID == card.ID {
				s.state.View.Cards[i] = card
				found = true
				break
			}
		}
		if !found {
			s.state.View.Cards = append(s.state.View.Cards, card)
		}
	}
	return nil
}

type onlinePolicyKey struct{}
type onlinePolicyTrace struct {
	ReadOnly   bool
	TargetHash string
	Dispatched bool
}
type onlineStopped struct{ Reason strategy.StopReason }

func (e *onlineStopped) Error() string {
	return "只读纠错已停止（" + string(e.Reason) + "）；已保留观察记录，不会重放操作"
}

func onlineEnabled(c Config) bool {
	return c.StrategyCorrectEnabled && !c.workflowMode && !c.sreCoordinator
}

func onlineTool() Tool {
	props := map[string]any{}
	for _, k := range []string{"sourceId", "refutedHypothesis", "changes", "expectedInformation", "stopCondition", "tool", "arguments"} {
		props[k] = stringSchema()
	}
	schema := objectSchema(props, "sourceId", "refutedHypothesis", "changes", "expectedInformation", "stopCondition", "tool", "arguments")
	schema["additionalProperties"] = false
	return Tool{Name: onlineRevisionTool, Description: "Submit one bounded read-only correction after an actual failed tool call. sourceId must be that call ID. Describe the refuted hypothesis, concrete changes, expected information and stop condition. tool/arguments (JSON object encoded as a string) specify exactly ONE next check on the SAME authorized target. No permission bypass, writes, opaque MCP, arbitrary SQL, delegation or background calls. A proposal is not evidence or permission. The runtime alone judges progress; a final answer never proves recovery.", Parameters: schema}
}

func (e *Engine) onlineOwner(s *session, c Config) (*Engine, *session, string, string, string) {
	owner, parent := e, s
	task := ""
	if c.sre != nil {
		task = c.sre.TaskID
	}
	if e.worker != nil {
		owner, parent = e.worker.parent, e.worker.session
		if c.sre != nil {
			task = c.sre.TaskID
		}
	}
	parent.mu.Lock()
	sid, turn := parent.state.View.Session, parent.state.View.RootTurnID
	parent.mu.Unlock()
	key := turn
	if task != "" {
		key = "sre:" + task
	}
	return owner, parent, hash(sid + "\x00" + key), sid, task
}

func (e *Engine) onlineCurrent(s *session, c Config) (*strategy.OnlineReport, error) {
	if !onlineEnabled(c) {
		return nil, nil
	}
	owner, _, key, _, _ := e.onlineOwner(s, c)
	store, err := owner.adkStore()
	if err != nil {
		return nil, err
	}
	var row nativeCorrection
	err = store.DB.First(&row, "id = ?", key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r strategy.OnlineReport
	if json.Unmarshal([]byte(row.Body), &r) != nil {
		return nil, errors.New("online correction record invalid")
	}
	return &r, nil
}

func (e *Engine) onlineManifest(s *session) (*strategy.ManifestRef, []strategy.RevisionRef, error) {
	s.mu.Lock()
	runtime := s.state.Runtime
	c := s.state.Config
	if runtime == nil || runtime.PromptManifest == nil {
		s.mu.Unlock()
		return nil, []strategy.RevisionRef{}, nil
	}
	ref := *runtime.PromptManifest
	runtimeID := runtime.SessionID
	s.mu.Unlock()
	part, err := (&nativeArtifacts{engine: e, sessionID: runtimeID, config: c}).Load(context.Background(), &artifact.LoadRequest{AppName: "lake", UserID: "lake", SessionID: runtimeID, FileName: ref.FileName, Version: ref.Version})
	if err != nil {
		return nil, nil, err
	}
	var manifest strategy.PromptManifest
	if hash(part.Part.Text) != ref.ContentHash || json.Unmarshal([]byte(part.Part.Text), &manifest) != nil {
		return nil, nil, errors.New("correction source manifest invalid")
	}
	return &ref, manifest.SelectedAssets, nil
}

func (e *Engine) onlineFinish(s *session, c Config, turnErr error) error {
	_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if r.StopReason != "" {
			return nil
		}
		r.StopReason = strategy.AwaitingUser
		if turnErr == nil && r.Recovered && r.Pending == nil {
			r.StopReason = strategy.Completed
		}
		if errors.Is(turnErr, context.Canceled) {
			r.StopReason = strategy.Cancelled
		}
		if r.InFlightCall != "" || r.InFlightRequest {
			r.StopReason = strategy.AwaitingReconciliation
		}
		return nil
	})
	return err
}

func (e *Engine) onlineCheckCompletion(s *session, c Config) error {
	if c.sre != nil && c.sre.NoTools {
		return nil
	}
	_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if r.StopReason != "" {
			return &onlineStopped{r.StopReason}
		}
		if r.InFlightCall != "" || r.InFlightRequest {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		if len(r.OpenChecks) > 0 {
			return onlineStop(r, strategy.AwaitingUser)
		}
		return nil
	})
	return err
}

// All roles serialize admission and accounting at the parent, before dispatch.
// The DB record commits first; cards are an expendable presentation cache.
func (e *Engine) onlineUpdate(s *session, c Config, create bool, fn func(*strategy.OnlineReport) error) (*strategy.OnlineReport, error) {
	if !onlineEnabled(c) {
		return nil, nil
	}
	owner, parent, key, sid, task := e.onlineOwner(s, c)
	store, err := owner.adkStore()
	if err != nil {
		return nil, err
	}
	owner.correctionMu.Lock()
	defer owner.correctionMu.Unlock()
	var row nativeCorrection
	err = store.DB.First(&row, "id = ?", key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) && !create {
		return nil, nil
	}
	var report strategy.OnlineReport
	if errors.Is(err, gorm.ErrRecordNotFound) {
		budget := c.StrategyBudget
		if err := budget.Validate(); err != nil {
			return nil, errors.New("online correction budget unavailable")
		}
		parent.mu.Lock()
		turn := parent.state.View.RootTurnID
		parent.mu.Unlock()
		manifest, selected, err := e.onlineManifest(s)
		if err != nil {
			return nil, err
		}
		report = strategy.OnlineReport{SchemaVersion: 1, ID: key, TaskID: task, TurnID: turn, Arm: strategy.CorrectionArm, ModelRef: ModelIdentity(c.Model), GlobalEpoch: c.StrategyGlobalEpoch, ProjectEpoch: c.StrategyProjectEpoch, Budget: budget, StartedAt: timestamp(), Observations: []strategy.OnlineObservation{}, Revisions: []strategy.OnlineRevision{}}
		report.ActiveAt = report.StartedAt
		report.SelectedAssets = selected
		report.Manifests = []strategy.ManifestRef{}
		if manifest != nil {
			report.Manifests = append(report.Manifests, *manifest)
		}
		report.PermissionHash = hash(js(c.Permissions))
		report.Profile = c.Profile
		row = nativeCorrection{ID: key, SessionID: sid}
	} else if err != nil {
		return nil, err
	} else if json.Unmarshal([]byte(row.Body), &report) != nil || report.ID != key {
		return nil, errors.New("online correction record invalid")
	}
	var actionErr error
	if fn != nil {
		actionErr = fn(&report)
	}
	if report.StopReason == "" {
		if owner.onlineTask == "" || owner.onlineTask == key {
			owner.onlineTask = key
		} else {
			report.StopReason = strategy.AwaitingUser
			actionErr = &onlineStopped{report.StopReason}
		}
	} else if owner.onlineTask == key {
		owner.onlineTask = ""
	}
	if report.StopReason != "" && report.ActiveAt != "" {
		if at, err := time.Parse(time.RFC3339Nano, report.ActiveAt); err == nil {
			report.ActiveMilliseconds += max(int64(0), time.Since(at).Milliseconds())
		}
		report.ActiveAt = ""
		report.WaitSince = timestamp()
	}
	row.Body = js(report)
	if err := store.DB.Save(&row).Error; err != nil {
		return nil, err
	}
	owner.onlineSessions.Store(sid, true)
	parent.mu.Lock()
	cardID := "correction_" + key
	status := "running"
	if report.StopReason != "" {
		status = "completed"
	}
	card := Card{ID: cardID, Type: "strategy_correction", Title: "只读纠错", Status: status, At: report.StartedAt, Data: report}
	found := false
	for i := range parent.state.View.Cards {
		if parent.state.View.Cards[i].ID == cardID {
			parent.state.View.Cards[i] = card
			found = true
			break
		}
	}
	if !found {
		parent.state.View.Cards = append(parent.state.View.Cards, card)
	}
	err = owner.save(parent)
	owner.notify(parent, "operation", map[string]any{"card_id": cardID})
	parent.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return &report, actionErr
}

func onlineStop(r *strategy.OnlineReport, reason strategy.StopReason) error {
	if r.StopReason == "" {
		r.StopReason = reason
	}
	return &onlineStopped{r.StopReason}
}

func onlineLimit(r *strategy.OnlineReport) error {
	if r.StopReason != "" {
		return &onlineStopped{r.StopReason}
	}
	at, err := time.Parse(time.RFC3339Nano, r.ActiveAt)
	if err != nil || r.ActiveMilliseconds+max(int64(0), time.Since(at).Milliseconds()) >= r.Budget.MaxActiveSeconds*1000 {
		return onlineStop(r, strategy.BudgetExhausted)
	}
	return nil
}

// Fresh host settings are checked on every proposal, model request and call,
// including workers which do not inject user assets into specialized prompts.
func (e *Engine) onlineGuard(ctx context.Context, s *session, c Config) error {
	if !onlineEnabled(c) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	owner, _, _, sid, _ := e.onlineOwner(s, c)
	if owner.CorrectionGuard != nil {
		return owner.CorrectionGuard(ctx, sid, c.StrategyGlobalEpoch, c.StrategyProjectEpoch)
	}
	return nil
}

func (e *Engine) onlineBeforeCall(ctx context.Context, s *session, c Config, call Call) error {
	if err := e.onlineGuard(ctx, s, c); err != nil {
		return err
	}
	_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if err := onlineLimit(r); err != nil {
			return err
		}
		if call.Name == onlineRevisionTool {
			return nil
		}
		if call.Name == "read_evidence" || call.Name == "read_tool_result" || call.Name == "sre_team_read" || call.Name == "sre_team_update" || call.Name == "todo_write" {
			return nil
		}
		a, err := args(call)
		if err != nil || !onlineReadOnly(call.Name, "readonly", a, e.Bridge != nil) {
			return onlineStop(r, strategy.PermissionBlocked)
		}
		if r.InFlightCall != "" {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		if r.Recovered && r.Pending == nil {
			return nil
		}
		if len(r.Revisions) == 0 || r.Revisions[len(r.Revisions)-1].CallID != "" {
			return onlineStop(r, strategy.AwaitingUser)
		}
		p := r.Revisions[len(r.Revisions)-1]
		var expected, actual map[string]any
		if json.Unmarshal([]byte(p.Arguments), &expected) != nil || json.Unmarshal([]byte(call.Arguments), &actual) != nil || p.Tool != call.Name || js(expected) != js(actual) {
			return onlineStop(r, strategy.AwaitingUser)
		}
		return nil
	})
	return err
}

func (e *Engine) onlineDeny(s *session, c Config, call Call, why error) error {
	failure := map[string]any{"error": redact(why.Error(), c), "outcome": "not_executed", "retryable": false, "code": "online_correction_stopped"}
	var stopped *onlineStopped
	if errors.As(why, &stopped) {
		failure["stopReason"] = stopped.Reason
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.History = append(s.state.History, Message{Role: "tool", CallID: call.ID, Name: call.Name, Content: js(failure)})
	if err := e.save(s); err != nil {
		return err
	}
	e.notify(s, "toolResult", map[string]any{"call_id": call.ID})
	return why
}

// Only this narrow host list plus a fresh policy can authorize correction.
// ToolRisk's default and remote MCP readOnly annotations are insufficient.
func onlineReadOnly(name, risk string, a map[string]any, bridge bool) bool {
	if risk != "readonly" || a["run_in_background"] == true {
		return false
	}
	switch name {
	case "read", "ls", "glob", "grep", "list_db_objects", "db_table_ddl", "list_docker_containers", "docker_container_logs", "observe_host", "observe_logs", "observe_journal", "observe_cluster", "observe_cluster_logs", "observe_data":
		return true
	case "shell", "terminal_execute_command":
		// A shell program can own retries internally. Do not layer correction on
		// an explicit retrying command whose actual attempt count is unavailable.
		return bridge && !strings.Contains(strings.ToLower(str(a["command"])), "retry")
	}
	return false
}

func onlineTarget(c Config, a, policy map[string]any) string {
	ref := str(policy["asset_ref"])
	if ref == "" {
		ref = str(a["asset_ref"])
	}
	if ref == "" {
		ref = c.AssetRef
	}
	if as, err := asset(c, ref); err == nil {
		ref = as.ID
	}
	runtime := str(policy["runtime"])
	if runtime == "" {
		runtime = str(hostArguments(c, a)["runtime"])
	}
	container := str(a["container_id"])
	if container == "" {
		container = c.Container
	}
	urls := onlineURLs.FindAllString(str(a["command"]), -1)
	return hash(js([]any{runtime, ref, container, str(a["context"]), str(a["kubeconfig"]), str(a["db"]), str(a["schema"]), urls}))
}

var onlineURLs = regexp.MustCompile(`https?://[^\s"'` + "`" + `]+`)

func (e *Engine) onlinePolicy(ctx context.Context, s *session, c Config, call Call, a, policy map[string]any, risk, approval string) error {
	trace, _ := ctx.Value(onlinePolicyKey{}).(*onlinePolicyTrace)
	readOnly := onlineReadOnly(call.Name, risk, a, e.Bridge != nil)
	if e.Bridge != nil && (call.Name == "shell" || call.Name == "terminal_execute_command") && policy["risk"] != "readonly" {
		readOnly = false
	}
	target := onlineTarget(c, a, policy)
	if trace != nil {
		trace.ReadOnly, trace.TargetHash = readOnly, target
	}
	if err := e.onlineGuard(ctx, s, c); err != nil {
		return err
	}
	_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if err := onlineLimit(r); err != nil {
			return err
		}
		if !readOnly {
			return onlineStop(r, strategy.PermissionBlocked)
		}
		if approval != "" {
			return onlineStop(r, strategy.AwaitingUser)
		}
		expectedTarget := ""
		if r.Pending != nil {
			expectedTarget = r.Pending.TargetHash
		} else if len(r.Observations) > 0 {
			expectedTarget = r.Observations[0].TargetHash
		}
		if target != expectedTarget {
			return onlineStop(r, strategy.TargetAmbiguous)
		}
		if r.InFlightCall != "" {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		if len(r.Observations) >= r.Budget.MaxRuns {
			return onlineStop(r, strategy.BudgetExhausted)
		}
		// Recheck the exact proposal here as well: calls can bypass invokeCalls in
		// native approval recovery, and policy may have changed since admission.
		if len(r.Revisions) == 0 && !r.Recovered {
			return onlineStop(r, strategy.AwaitingUser)
		}
		if !r.Recovered || r.Pending != nil {
			p := &r.Revisions[len(r.Revisions)-1]
			var expected map[string]any
			if json.Unmarshal([]byte(p.Arguments), &expected) != nil || p.CallID != "" || p.Tool != call.Name || js(expected) != js(a) {
				return onlineStop(r, strategy.AwaitingUser)
			}
			p.CallID = call.ID
		}
		store, err := e.adkStore()
		if err != nil {
			return err
		}
		owner, _, _, sid, _ := e.onlineOwner(s, c)
		_ = owner
		var count int64
		if err := store.DB.Model(&nativeOperation{}).Where("session_id = ? AND status = ?", sid, "dispatched").Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		r.InFlightCall = call.ID
		return nil
	})
	return err
}

func onlineCheck(call Call) string {
	a, _ := args(call)
	delete(a, "timeout_ms")
	delete(a, "timeout")
	delete(a, "run_in_background")
	return hash(call.Name + "\x00" + js(a))
}

func onlineFailure(err error, value any) string {
	if err == nil {
		v := obj(value)
		if value == nil || v["success"] == false || v["status"] == "failed" || str(v["error"]) != "" {
			return "check_failed"
		}
		if v["reused"] == true {
			return "repeated_observation"
		}
		if v["status"] == "running" || v["status"] == "unknown" || v["running"] == true {
			return "unknown"
		}
		if v["exitCode"] != nil && num(v["exitCode"], 0) != 0 {
			return "check_failed"
		}
		return "success"
	}
	var stopped *onlineStopped
	if errors.As(err, &stopped) {
		return "controller_stopped"
	}
	var blocked *nativeOperationBlockedError
	if errors.As(err, &blocked) {
		return "unknown"
	}
	text := strings.ToLower(err.Error())
	for _, word := range []string{"permission", "denied", "unauthorized", "authentication", "user rejected", "禁止", "权限", "拒绝"} {
		if strings.Contains(text, word) {
			return "permission"
		}
	}
	for _, word := range []string{"scope", "target", "ambiguous", "not available in this session", "范围", "目标"} {
		if strings.Contains(text, word) {
			return "target"
		}
	}
	for _, word := range []string{"unavailable", "unsupported", "not supported", "不可用", "仅供"} {
		if strings.Contains(text, word) {
			return "capability"
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "unknown"
	}
	for _, word := range []string{"connection reset", "connection refused", "timeout", "temporary", "eof"} {
		if strings.Contains(text, word) {
			return "transient"
		}
	}
	return "invalid_or_failed"
}

func (e *Engine) onlineObserve(s *session, c Config, call Call, trace *onlinePolicyTrace, value any, toolErr error) error {
	if !onlineEnabled(c) || call.Name == onlineRevisionTool {
		return nil
	}
	class := onlineFailure(toolErr, value)
	// curl's documented transport exit codes are structured outcomes from the
	// trusted executor. HTTP/application errors and arbitrary stderr are not
	// transient classifications. The separate policy must still prove readonly.
	if toolErr == nil && class == "check_failed" && (call.Name == "shell" || call.Name == "terminal_execute_command") {
		a, _ := args(call)
		fields := strings.Fields(str(a["command"]))
		if len(fields) > 0 && fields[0] == "curl" {
			switch num(obj(value)["exitCode"], 0) {
			case 6, 7, 28, 52, 56:
				class = "transient"
			}
		}
	}
	if class == "controller_stopped" {
		return nil
	}
	// Session bookkeeping, questions and reports do not start optimization.
	if sessionTool(call.Name) && call.Name != "call_mcp_tool" || strings.HasPrefix(call.Name, "sre_") || call.Name == "render_chart" || call.Name == "read_evidence" || call.Name == "list_assets" || call.Name == "list_resource_groups" {
		return nil
	}
	_, err := e.onlineUpdate(s, c, class != "success", func(r *strategy.OnlineReport) error {
		if r.StopReason != "" {
			return nil
		}
		if r.InFlightCall != "" && r.InFlightCall != call.ID {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		r.InFlightCall = ""
		body := js(value)
		if toolErr != nil {
			body = toolErr.Error()
		}
		ob := strategy.OnlineObservation{CallID: call.ID, Tool: call.Name, CheckHash: onlineCheck(call), EvidenceHash: hash(body), TargetHash: trace.TargetHash, Class: class, TrustedReadOnly: trace.ReadOnly, Success: class == "success", At: timestamp()}
		r.Observations = append(r.Observations, ob)
		progress := false
		remaining := []strategy.OnlineObservation{}
		for _, gap := range r.OpenChecks {
			if strategy.OnlineProgress(gap, ob) {
				progress = true
				continue
			}
			if !ob.Success && gap.CheckHash == ob.CheckHash {
				continue
			}
			remaining = append(remaining, gap)
		}
		if !ob.Success {
			remaining = append(remaining, ob)
		}
		r.OpenChecks = remaining
		r.Recovered = len(remaining) == 0
		r.Pending = nil
		if len(remaining) > 0 {
			pending := remaining[len(remaining)-1]
			r.Pending = &pending
		}
		switch class {
		case "permission":
			return onlineStop(r, strategy.PermissionBlocked)
		case "target":
			return onlineStop(r, strategy.TargetAmbiguous)
		case "capability":
			return onlineStop(r, strategy.CapabilityMissing)
		}
		if !trace.ReadOnly && !trace.Dispatched && class != "unknown" {
			return onlineStop(r, strategy.AwaitingUser)
		}
		if !trace.ReadOnly || class == "unknown" && (obj(value)["status"] == "running" || obj(value)["running"] == true || obj(value)["status"] == "dispatched") {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		if len(r.Revisions) > 0 && r.Revisions[len(r.Revisions)-1].CallID == call.ID {
			r.Revisions[len(r.Revisions)-1].Progress = progress
			if progress {
				r.NoProgress = 0
			} else {
				r.NoProgress++
			}
			if r.NoProgress >= r.Budget.MaxNoProgressRevisions {
				return onlineStop(r, strategy.NoProgress)
			}
		}
		if !r.Recovered && len(r.Revisions) >= r.Budget.MaxRevisions {
			return onlineStop(r, strategy.BudgetExhausted)
		}
		return nil
	})
	return err
}

func (e *Engine) onlinePropose(ctx context.Context, s *session, c Config, call Call) (any, error) {
	if !onlineEnabled(c) {
		return nil, errors.New("online correction disabled")
	}
	if err := e.onlineGuard(ctx, s, c); err != nil {
		return nil, err
	}
	var p strategy.OnlineRevision
	if decodeOnlineJSON(call.Arguments, &p) != nil {
		return nil, errors.New("invalid correction proposal")
	}
	// Internal outcome fields cannot be supplied by the model.
	var raw map[string]any
	if json.Unmarshal([]byte(call.Arguments), &raw) != nil || len(raw) != 7 {
		return nil, errors.New("proposal requires exactly seven input fields")
	}
	for _, v := range []string{p.SourceID, p.RefutedHypothesis, p.Changes, p.ExpectedInformation, p.StopCondition, p.Tool, p.Arguments} {
		if strings.TrimSpace(v) == "" || len(v) > 4000 || redact(v, c) != v {
			return nil, errors.New("invalid or sensitive correction proposal")
		}
	}
	var a map[string]any
	if decodeOnlineJSON(p.Arguments, &a) != nil || a == nil || p.Tool == onlineRevisionTool {
		return nil, errors.New("invalid correction call")
	}
	p.Arguments = js(a)
	r, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if err := onlineLimit(r); err != nil {
			return err
		}
		if r.Pending == nil || r.Pending.CallID != p.SourceID || !r.Pending.TrustedReadOnly {
			return onlineStop(r, strategy.AwaitingUser)
		}
		if r.InFlightCall != "" || len(r.Revisions) > 0 && r.Revisions[len(r.Revisions)-1].CallID == "" {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		if len(r.Revisions) >= r.Budget.MaxRevisions {
			return onlineStop(r, strategy.BudgetExhausted)
		}
		check := onlineCheck(Call{Name: p.Tool, Arguments: p.Arguments})
		if check == r.Pending.CheckHash {
			if r.Pending.Class != "transient" && r.Pending.Class != "unknown" {
				return onlineStop(r, strategy.NoProgress)
			}
			retries := 0
			for _, ob := range r.Observations {
				if ob.CheckHash == check {
					retries++
				}
			}
			if retries > r.Budget.ExtraReadRetries {
				return onlineStop(r, strategy.BudgetExhausted)
			}
		}
		r.Revisions = append(r.Revisions, p)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, errors.New("an actual failed check is required before correction")
	}
	return map[string]any{"status": "revision_recorded", "revision": len(r.Revisions), "notice": "Execute only the exact proposed read-only check. The host rechecks authorization, target and remaining budget. Then report actual observations and gaps; do not claim the entire task recovered."}, nil
}

func decodeOnlineJSON(text string, out any) error {
	if len(text) > 32000 {
		return errors.New("correction JSON too large")
	}
	d := json.NewDecoder(strings.NewReader(text))
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 32 {
			return errors.New("correction JSON nesting limit")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		if delim, ok := t.(json.Delim); ok {
			switch delim {
			case '{':
				seen := map[string]bool{}
				for d.More() {
					k, err := d.Token()
					if err != nil {
						return err
					}
					key, ok := k.(string)
					if !ok || seen[key] {
						return errors.New("duplicate correction JSON key")
					}
					seen[key] = true
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
			case '[':
				for d.More() {
					if err := walk(depth + 1); err != nil {
						return err
					}
				}
			default:
				return errors.New("invalid correction JSON")
			}
			_, err = d.Token()
			return err
		}
		return nil
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing correction JSON")
	}
	return decodeSREJSON(text, out)
}

func (e *Engine) onlineReserve(ctx context.Context, s *session, c Config, reserve int64) (bool, error) {
	if !onlineEnabled(c) {
		return false, nil
	}
	if err := e.onlineGuard(ctx, s, c); err != nil {
		return false, err
	}
	manifest, _, err := e.onlineManifest(s)
	if err != nil {
		return false, err
	}
	r, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if err := onlineLimit(r); err != nil {
			return err
		}
		if r.InFlightRequest || r.InFlightCall != "" {
			return onlineStop(r, strategy.AwaitingReconciliation)
		}
		if r.Requests >= r.Budget.MaxOptimizationRequests || reserve > r.Budget.MaxAdditionalTokens-r.TokensCharged {
			return onlineStop(r, strategy.BudgetExhausted)
		}
		r.Requests++
		r.TokensCharged += reserve
		r.InFlightRequest = true
		r.UsageUnknown = true
		if manifest != nil {
			r.Manifests = append(r.Manifests, *manifest)
		}
		return nil
	})
	return r != nil && err == nil, err
}

func (e *Engine) onlineSettle(s *session, c Config, reserve int64, usage Usage, requestErr error) error {
	_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if !r.InFlightRequest {
			return errors.New("online request reservation missing")
		}
		r.InFlightRequest = false
		if usage.InputKnown && usage.OutputKnown {
			r.TokensCharged += int64(usage.Input+usage.Output) - reserve
		} else {
			r.UnknownRequests++
		}
		r.UsageUnknown = r.UnknownRequests > 0
		if requestErr != nil {
			if r.StopReason == "" {
				r.StopReason = strategy.AwaitingUser
			}
			if r.UsageUnknown {
				r.StopReason = strategy.AwaitingReconciliation
			}
			if errors.Is(requestErr, context.Canceled) {
				r.StopReason = strategy.Cancelled
			}
		}
		if r.TokensCharged >= r.Budget.MaxAdditionalTokens {
			r.StopReason = strategy.BudgetExhausted
		}
		return nil
	})
	return err
}

func recoverOnlineCorrections(db *gorm.DB) error {
	var rows []nativeCorrection
	if err := db.Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		var r strategy.OnlineReport
		if json.Unmarshal([]byte(row.Body), &r) != nil {
			return fmt.Errorf("invalid durable correction %s", row.ID)
		}
		if r.StopReason != "" {
			continue
		}
		r.StopReason = strategy.AwaitingUser
		if r.InFlightRequest || r.InFlightCall != "" {
			r.StopReason = strategy.AwaitingReconciliation
		}
		if r.ActiveAt != "" {
			if at, err := time.Parse(time.RFC3339Nano, r.ActiveAt); err == nil {
				r.ActiveMilliseconds += min(max(int64(0), time.Since(at).Milliseconds()), max(int64(0), r.Budget.MaxActiveSeconds*1000-r.ActiveMilliseconds))
			}
			r.ActiveAt = ""
		}
		if r.WaitSince == "" {
			r.WaitSince = timestamp()
		}
		// Keep dispatch identities and conservative reservations. Recovery never
		// dispatches, marks an old read successful or creates an automatic resume.
		if err := db.Model(&nativeCorrection{}).Where("id = ?", row.ID).Update("body", js(r)).Error; err != nil {
			return err
		}
	}
	return nil
}

// Called only by the existing SRE start/continue path, after its task/scope
// checks. No background worker resumes a correction. Waiting consumes no active
// time and never refunds requests, tokens, revisions or the original deadline.
func (e *Engine) prepareOnlineSREContinue(ctx context.Context, s *session, c Config, task string) error {
	c.sreCoordinator = false
	c.sre = &sreRoleContext{TaskID: task}
	if err := e.onlineGuard(ctx, s, c); err != nil {
		return err
	}
	_, err := e.onlineUpdate(s, c, false, func(r *strategy.OnlineReport) error {
		if r.StopReason == "" {
			return nil
		}
		if r.StopReason != strategy.AwaitingUser || r.Pending == nil || !r.Pending.TrustedReadOnly || r.InFlightCall != "" || r.InFlightRequest {
			return &onlineStopped{r.StopReason}
		}
		wait, err := time.Parse(time.RFC3339Nano, r.WaitSince)
		if err != nil || time.Since(wait) > time.Duration(r.Budget.UserWaitTTLSeconds)*time.Second {
			return errors.New("纠错等待已过期，请保留历史并建立新任务")
		}
		if r.ModelRef != ModelIdentity(c.Model) || r.PermissionHash != hash(js(c.Permissions)) || r.GlobalEpoch != c.StrategyGlobalEpoch || r.ProjectEpoch != c.StrategyProjectEpoch {
			return errors.New("纠错配置已变化，请建立新任务；原预算和未知操作记录保留")
		}
		if len(r.Revisions) >= r.Budget.MaxRevisions || r.Requests >= r.Budget.MaxOptimizationRequests || r.TokensCharged >= r.Budget.MaxAdditionalTokens || r.ActiveMilliseconds >= r.Budget.MaxActiveSeconds*1000 {
			return &onlineStopped{strategy.BudgetExhausted}
		}
		r.StopReason = ""
		r.ActiveAt = timestamp()
		return nil
	})
	return err
}
