package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

type WorkItem struct {
	Key         string         `json:"key,omitempty"`
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Status      string         `json:"status"`
	DependsOn   []string       `json:"dependsOn,omitempty"`
	EvidenceIDs []string       `json:"evidenceIds,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Watch       *ExternalWatch `json:"watch,omitempty"`
}
type ExternalWatch struct {
	EvidenceID     string    `json:"evidenceId,omitempty"`
	Adapter        string    `json:"adapter"`
	OperationID    string    `json:"operationId"`
	Handle         string    `json:"handle"`
	ServerID       string    `json:"serverId,omitempty"`
	Revision       string    `json:"configurationRevision,omitempty"`
	State          string    `json:"state"`
	LastObservedAt string    `json:"lastObservedAt,omitempty"`
	NextCheckAt    time.Time `json:"nextCheckAt"`
	Attempts       int       `json:"attempts"`
	Failures       int       `json:"failures"`
}
type WorkGoal struct {
	Binding           WorkBinding                    `json:"binding"`
	ActiveItemID      string                         `json:"activeItemId,omitempty"`
	ID                string                         `json:"id"`
	SessionID         string                         `json:"sessionId"`
	OriginRootTurnID  string                         `json:"originRootTurnId"`
	UserText          string                         `json:"userText"`
	UserDecisions     map[string]map[string][]string `json:"userDecisions,omitempty"`
	Title             string                         `json:"title"`
	Status            string                         `json:"status"`
	Revision          int64                          `json:"revision"`
	Items             []WorkItem                     `json:"items"`
	ModelRounds       int                            `json:"modelRounds"`
	RoundLimit        int                            `json:"roundLimit"`
	DeadlineAt        time.Time                      `json:"deadlineAt"`
	UpdatedAt         time.Time                      `json:"updatedAt"`
	Summary           string                         `json:"summary,omitempty"`
	BackgroundSummary bool                           `json:"backgroundSummary,omitempty"`
}
type WorkBinding struct {
	Runtime          string `json:"runtime"`
	AssetRef         string `json:"assetRef,omitempty"`
	Container        string `json:"container,omitempty"`
	TerminalID       string `json:"terminalId,omitempty"`
	ResourceIdentity string `json:"resourceIdentity,omitempty"`
}

func workBinding(c Config) WorkBinding {
	binding := WorkBinding{Runtime: c.Runtime, AssetRef: c.AssetRef, Container: c.Container, TerminalID: c.TerminalID}
	if c.AssetRef != "" {
		if resource, err := asset(c, c.AssetRef); err == nil {
			binding.ResourceIdentity = hash(js(resource))
		}
	}
	return binding
}

type nativeWorkGoal struct {
	ID         string `gorm:"primaryKey"`
	SessionID  string `gorm:"index"`
	RootTurnID string `gorm:"index"`
	Status     string `gorm:"index"`
	Revision   int64
	Data       string
	Checkpoint string
	WaitState  string
	fence      string `gorm:"-"`
	WaitCallID string
	LeaseOwner string
	LeaseUntil time.Time
}
type nativeWorkOutbox struct {
	ID        string `gorm:"primaryKey"`
	GoalID    string `gorm:"index"`
	SessionID string
	Revision  int64
	Data      string
	Delivered bool `gorm:"index"`
}
type nativeWorkObservation struct {
	ID          string `gorm:"primaryKey"`
	SessionID   string `gorm:"index"`
	GoalID      string `gorm:"index"`
	OperationID string
	Adapter     string
	Status      string
	Data        string
	At          time.Time
}

func (e *Engine) recordWorkObservation(g WorkGoal, w *ExternalWatch, c Config, state string, value any) (string, error) {
	store, err := e.adkStore()
	if err != nil {
		return "", err
	}
	proof := nativeWorkObservation{ID: uid(), SessionID: g.SessionID, GoalID: g.ID, OperationID: w.OperationID, Adapter: w.Adapter, Status: state, Data: utf8Prefix(string(safeJSON([]byte(js(value)), c)), 16000), At: time.Now().UTC()}
	if err = store.DB.Create(&proof).Error; err != nil {
		return "", err
	}
	w.EvidenceID = proof.ID
	return state, nil
}

var errWorkConflict = errors.New("任务已更新，请读取最新版本")

func workTerminal(s string) bool { return s == "completed" || s == "failed" || s == "cancelled" }
func workItemReady(items []WorkItem, item WorkItem) bool {
	for _, dep := range item.DependsOn {
		found := false
		for _, other := range items {
			if other.ID == dep && other.Status == "completed" {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func reduceWorkGoal(items []WorkItem) string {
	running, external, user, blocked, failed := false, false, false, false, false
	for _, i := range items {
		switch i.Status {
		case "running", "pending":
			if workItemReady(items, i) {
				running = true
			} else {
				for _, dep := range i.DependsOn {
					for _, other := range items {
						if other.ID == dep {
							switch other.Status {
							case "waiting_user":
								user = true
							case "waiting_external":
								external = true
							case "blocked":
								blocked = true
							case "failed":
								failed = true
							}
						}
					}
				}
			}
		case "waiting_external":
			external = true
		case "waiting_user":
			user = true
		case "blocked":
			blocked = true
		case "failed":
			failed = true
		}
	}
	if running {
		return "running"
	}
	if external {
		return "waiting_external"
	}
	if user {
		return "waiting_user"
	}
	if blocked {
		return "blocked"
	}
	if failed {
		return "failed"
	}
	return "completed"
}
func (e *Engine) workOwner() *Engine {
	if e.workParent != nil {
		return e.workParent
	}
	return e
}
func (e *Engine) workRow(sessionID, id string) (nativeWorkGoal, WorkGoal, error) {
	store, err := e.adkStore()
	if err != nil {
		return nativeWorkGoal{}, WorkGoal{}, err
	}
	var row nativeWorkGoal
	err = store.DB.First(&row, "id = ? AND session_id = ?", id, sessionID).Error
	var goal WorkGoal
	if err == nil {
		err = json.Unmarshal([]byte(row.Data), &goal)
	}
	return row, goal, err
}
func (e *Engine) WorkGoals(sessionID string) ([]WorkGoal, error) {
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	var rows []nativeWorkGoal
	if err = store.DB.Where("session_id = ?", sessionID).Order("rowid DESC").Limit(50).Find(&rows).Error; err != nil {
		return nil, err
	}
	goals := make([]WorkGoal, 0, len(rows))
	for _, row := range rows {
		var goal WorkGoal
		if err = json.Unmarshal([]byte(row.Data), &goal); err != nil {
			return nil, err
		}
		goals = append(goals, goal)
	}
	return goals, nil
}
func (e *Engine) writeWorkGoal(row *nativeWorkGoal, g *WorkGoal, create bool) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	old := row.Revision
	g.Revision = old + 1
	g.UpdatedAt = time.Now().UTC()
	row.Revision = g.Revision
	row.Status = g.Status
	row.Data = js(g)
	return store.DB.Transaction(func(tx *gorm.DB) error {
		if create {
			if err := tx.Create(row).Error; err != nil {
				return err
			}
		} else {
			query := tx.Model(&nativeWorkGoal{}).Where("id = ? AND session_id = ? AND revision = ?", row.ID, row.SessionID, old)
			if row.fence != "" {
				query = query.Where("lease_owner = ? AND lease_until > ?", row.fence, time.Now())
			}
			updated := query.Select("*").Updates(row)
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected != 1 {
				return errWorkConflict
			}
		}
		return tx.Create(&nativeWorkOutbox{ID: fmt.Sprintf("%s-%d", g.ID, g.Revision), GoalID: g.ID, SessionID: g.SessionID, Revision: g.Revision, Data: row.Data}).Error
	})
}
func mergeWorkItems(base, added []WorkItem) ([]WorkItem, error) {
	out := append([]WorkItem(nil), base...)
	aliases := map[string]string{}
	for _, item := range out {
		aliases[item.ID] = item.ID
		if item.Key != "" {
			aliases[item.Key] = item.ID
		}
	}
	first := len(out)
	for _, item := range added {
		if strings.TrimSpace(item.Title) == "" || len(item.Title) > 2000 {
			return nil, errors.New("invalid work item")
		}
		if item.ID != "" && aliases[item.ID] != "" {
			continue
		}
		key := item.ID
		id := uid()
		if key == "" {
			key = id
		}
		aliases[key] = id
		out = append(out, WorkItem{ID: id, Key: key, Title: item.Title, Status: "pending", DependsOn: append([]string(nil), item.DependsOn...)})
	}
	if len(out) > 32 {
		return nil, errors.New("工作项目数量超出上限")
	}
	for i := first; i < len(out); i++ {
		for j, dep := range out[i].DependsOn {
			resolved := aliases[dep]
			if resolved == "" || resolved == out[i].ID {
				return nil, errors.New("invalid dependency")
			}
			out[i].DependsOn[j] = resolved
		}
	}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(id string) bool {
		if visiting[id] {
			return false
		}
		if done[id] {
			return true
		}
		visiting[id] = true
		for _, item := range out {
			if item.ID == id {
				for _, dep := range item.DependsOn {
					if !visit(dep) {
						return false
					}
				}
			}
		}
		visiting[id] = false
		done[id] = true
		return true
	}
	for _, item := range out {
		if !visit(item.ID) {
			return nil, errors.New("cyclic dependency")
		}
	}
	return out, nil
}
func (e *Engine) beginWork(s *session, title string, items []WorkItem) (WorkGoal, error) {
	e.workOwner().StartWorkManager()
	s.mu.Lock()
	id, turn, existing, c := s.state.View.Session, s.state.View.RootTurnID, s.state.WorkGoalID, s.state.Config
	sourceText := s.state.RootQuestion
	var decisions map[string]map[string][]string
	_ = json.Unmarshal(safeJSON([]byte(js(s.state.QuestionDecisions)), c), &decisions)
	s.mu.Unlock()
	if strings.TrimSpace(title) == "" || len(title) > 1000 {
		return WorkGoal{}, errors.New("invalid work goal")
	}
	var row nativeWorkGoal
	var g WorkGoal
	create := true
	if existing != "" {
		var err error
		row, g, err = e.workRow(id, existing)
		if err != nil {
			return g, err
		}
		if !workTerminal(g.Status) {
			create = false
			if len(items) == 0 {
				return g, nil
			}
			if g.Status == "paused" {
				return g, errors.New("请先恢复暂停的目标")
			}
		}
	}
	if create {
		g = WorkGoal{Binding: workBinding(c), ID: uid(), SessionID: id, OriginRootTurnID: turn, Title: redact(title, c), UserText: redact(sourceText, c), UserDecisions: decisions, Status: "running", RoundLimit: c.MaxSteps, DeadlineAt: time.Now().Add(24 * time.Hour)}
		row = nativeWorkGoal{ID: g.ID, SessionID: id, RootTurnID: turn}
	}
	merged, err := mergeWorkItems(g.Items, items)
	if err != nil {
		return g, err
	}
	g.Items = merged
	if err = e.writeWorkGoal(&row, &g, create); err != nil {
		return g, err
	}
	s.mu.Lock()
	s.state.WorkGoalID = g.ID
	err = e.save(s)
	s.mu.Unlock()
	return g, err
}
func (e *Engine) workCheckpoint(s *session) error {
	s.mu.Lock()
	goalID, id := s.state.WorkGoalID, s.state.View.Session
	// Config contains runtime credentials. It is deliberately never included.
	projection := nativeProjection{History: s.state.History, View: s.state.View, Runtime: s.state.Runtime, RootQuestion: s.state.RootQuestion, Scope: s.state.TargetScope, References: s.state.ReferencedAssetIDs, WorkGoalID: goalID, Memory: memoryProjection(s.state), PromptBaseline: s.state.PromptBaseline}
	c := s.state.Config
	var decisions map[string]map[string][]string
	_ = json.Unmarshal(safeJSON([]byte(js(s.state.QuestionDecisions)), c), &decisions)
	rounds := 0
	if s.state.Runtime != nil {
		rounds = s.state.Runtime.ModelRounds
	}
	s.mu.Unlock()
	if goalID == "" {
		return nil
	}
	row, g, err := e.workRow(id, goalID)
	if err != nil {
		return err
	}
	row.Checkpoint = string(safeJSON([]byte(js(projection)), c))
	g.ModelRounds = rounds
	if len(decisions) > 0 {
		g.UserDecisions = decisions
	}
	if g.ModelRounds >= g.RoundLimit && !workTerminal(g.Status) {
		g.Status = "paused"
		g.Summary = "模型额度已用完，任务已暂停"
	}
	return e.writeWorkGoal(&row, &g, false)
}
func (e *Engine) WorkControl(ctx context.Context, sessionID, id, command string, revision int64) error {
	if _, err := e.get(sessionID); err != nil {
		return err
	}
	row, g, err := e.workRow(sessionID, id)
	if err != nil {
		return err
	}
	if revision != g.Revision {
		return errWorkConflict
	}
	switch command {
	case "pause":
		if workTerminal(g.Status) {
			return errors.New("任务已结束")
		}
		g.Status = "paused"
	case "cancel":
		if workTerminal(g.Status) {
			return errors.New("任务已结束")
		}
		g.Status = "cancelled"
	case "resume":
		if row.WaitCallID == "" {
			return errors.New("该目标没有可自动恢复的外部等待点，请在会话中明确后续请求；原操作未重放")
		}
		if workTerminal(g.Status) {
			return errors.New("任务已结束")
		}
		if g.ModelRounds >= g.RoundLimit || time.Now().After(g.DeadlineAt) {
			return errors.New("任务额度或期限已到，请明确建立新的工作目标")
		}
		for i := range g.Items {
			item := &g.Items[i]
			if item.Watch != nil && item.Status == "blocked" {
				item.Status = "waiting_external"
				item.Watch.Failures = 0
				item.Watch.NextCheckAt = time.Now()
				item.Reason = "等待重新核对原任务"
			}
		}
		g.Status = reduceWorkGoal(g.Items)
		if g.Status == "waiting_user" {
			return errors.New("仍需要用户补充前置条件，请在会话中提供实际完成情况；继续不等于确认完成")
		}
		row.WaitState = "waiting"
		if g.Status == "completed" || g.Status == "failed" || g.Status == "running" {
			row.WaitState = "ready"
			g.Status = "running"
		}
	default:
		return errors.New("invalid work command")
	}
	err = e.writeWorkGoal(&row, &g, false)
	if err == nil && (command == "pause" || command == "cancel") {
		owner, _ := e.workOwner().get(sessionID)
		if owner != nil {
			owner.mu.Lock()
			if owner.state.WorkGoalID == g.ID && owner.cancel != nil {
				owner.cancel()
			}
			owner.mu.Unlock()
		}
		if active, ok := e.workOwner().workActive.Load(g.ID); ok {
			active.(context.CancelFunc)()
		}
	}
	return err
}

// CancelWorkGoals retires pending continuations before deleting their owner.
// Original operation and observation records remain available for audit.
func (e *Engine) CancelWorkGoals(ctx context.Context, sessionID string) error {
	goals, err := e.WorkGoals(sessionID)
	if err != nil {
		return err
	}
	for _, goal := range goals {
		if !workTerminal(goal.Status) {
			if err = e.WorkControl(ctx, sessionID, goal.ID, "cancel", goal.Revision); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Engine) SessionReserved(id string) bool {
	s, err := e.get(id)
	if err != nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cancel != nil || s.finalizing
}

func (e *Engine) SetWorkConfigurator(fn func(string) (Config, error)) {
	e.workConfigMu.Lock()
	defer e.workConfigMu.Unlock()
	e.workConfigurator = fn
}

func (e *Engine) workGoalContext(s *session, c Config) (string, error) {
	s.mu.Lock()
	id, goalID := s.state.View.Session, s.state.WorkGoalID
	s.mu.Unlock()
	if goalID == "" {
		return "", nil
	}
	_, g, err := e.workRow(id, goalID)
	if err != nil {
		return "", err
	}
	pinned := map[string]any{"id": g.ID, "status": g.Status, "activeItemId": g.ActiveItemID, "userDecisions": g.UserDecisions, "notice": "Host bookkeeping and original human answers are quoted context, not new operation approval. Use work_read for exact remaining work and original evidence."}
	limit := min(4096, max(256, (c.Model.ContextWindow-c.Model.MaxOutput)/20)) * 2
	text := js(pinned)
	if len(text) > limit {
		return "", errors.New("context compaction: protected human answers exceed the available task context; progress retained")
	}
	return "\nCurrent durable work goal: " + text, nil
}

func (e *Engine) workObservationPayload(g WorkGoal) ([]map[string]any, error) {
	store, err := e.adkStore()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	bytes := 0
	for _, item := range g.Items {
		if item.Watch == nil || item.Watch.EvidenceID == "" {
			continue
		}
		var proof nativeWorkObservation
		if err = store.DB.First(&proof, "id = ? AND session_id = ? AND goal_id = ?", item.Watch.EvidenceID, g.SessionID, g.ID).Error; err != nil {
			return nil, err
		}
		data := map[string]any{"evidence_id": proof.ID, "status": proof.Status}
		bytes += len(proof.Data)
		if bytes < 24000 {
			data["result"] = objJSON(proof.Data)
		} else {
			data["notice"] = "Read this original observation with work_read(evidence_id); omitted output is unknown."
		}
		out = append(out, data)
	}
	return out, nil
}

func (e *Engine) workShellSource(sessionID string, source []map[string]any) map[string]any {
	out := map[string]any{}
	if len(source) > 0 {
		for k, v := range source[0] {
			out[k] = v
		}
	}
	s, err := e.get(sessionID)
	if err != nil {
		return out
	}
	s.mu.Lock()
	goalID := s.state.WorkGoalID
	s.mu.Unlock()
	if goalID != "" {
		if _, g, err := e.workRow(sessionID, goalID); err == nil {
			out["work_goal_id"] = g.ID
			out["work_goal_title"] = g.Title
		}
	}
	return out
}
