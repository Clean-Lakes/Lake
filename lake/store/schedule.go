package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

type Schedule struct {
	ID               string     `json:"id"`
	LakeID           string     `json:"lake_id"`
	WorkflowID       string     `json:"workflow_id"`
	WorkflowRevision int        `json:"workflow_revision"`
	Kind             string     `json:"kind"`
	Expression       string     `json:"expression"`
	Timezone         string     `json:"timezone"`
	NextAt           *time.Time `json:"next_at,omitempty"`
	Enabled          bool       `json:"enabled"`
	FailCount        int        `json:"fail_count"`
	LeaseOwner       string     `json:"lease_owner,omitempty"`
	LeaseUntil       time.Time  `json:"lease_until,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type ScheduleRun struct {
	ID            string    `json:"id"`
	ScheduleID    string    `json:"schedule_id"`
	WorkflowRunID string    `json:"workflow_run_id,omitempty"`
	DueAt         time.Time `json:"due_at"`
	Status        string    `json:"status"`
	LeaseOwner    string    `json:"lease_owner"`
	Reason        string    `json:"reason,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type ScheduleGrant struct {
	ID               string    `json:"id"`
	ScheduleID       string    `json:"schedule_id"`
	WorkflowRevision int       `json:"workflow_revision"`
	NodeID           string    `json:"node_id"`
	ResourceID       string    `json:"resource_id"`
	CommandSHA256    string    `json:"command_sha256"`
	ExpiresAt        time.Time `json:"expires_at"`
	MaxRuns          int       `json:"max_runs"`
	UsedRuns         int       `json:"used_runs"`
	CreatedAt        time.Time `json:"created_at"`
}

func scanSchedule(row scanner) (Schedule, error) {
	var item Schedule
	var next sql.NullInt64
	var enabled, created, updated, leaseUntil int64
	err := row.Scan(&item.ID, &item.LakeID, &item.WorkflowID, &item.WorkflowRevision, &item.Kind, &item.Expression, &item.Timezone, &next, &enabled, &item.FailCount, &item.LeaseOwner, &leaseUntil, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return item, ErrNotFound
	}
	if err != nil {
		return item, err
	}
	if next.Valid {
		t := fromMillis(next.Int64)
		item.NextAt = &t
	}
	item.Enabled = enabled == 1
	item.LeaseUntil = fromMillis(leaseUntil)
	item.CreatedAt = fromMillis(created)
	item.UpdatedAt = fromMillis(updated)
	return item, nil
}

const scheduleSelect = `SELECT id,lake_id,workflow_id,workflow_revision,kind,expression,timezone,next_at,enabled,fail_count,lease_owner,lease_until,created_at,updated_at FROM schedule`

func (s *Store) CreateSchedule(ctx context.Context, workflowID, kind, expression, timezone string, next time.Time) (Schedule, error) {
	if kind != "once" && kind != "cron" || expression == "" || timezone == "" || next.IsZero() {
		return Schedule{}, errors.New("计划参数无效")
	}
	def, err := s.GetWorkflowV2(ctx, workflowID)
	if err != nil {
		return Schedule{}, err
	}
	if !def.Enabled {
		return Schedule{}, errors.New("工作流已停用")
	}
	id, err := newID()
	if err != nil {
		return Schedule{}, err
	}
	now := nowMillis()
	_, err = s.db.ExecContext(ctx, `INSERT INTO schedule(id,lake_id,workflow_id,workflow_revision,kind,expression,timezone,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, def.LakeID, def.ID, def.Revision, kind, expression, timezone, next.UnixMilli(), now, now)
	if err != nil {
		return Schedule{}, err
	}
	return s.GetSchedule(ctx, id)
}

func (s *Store) GetSchedule(ctx context.Context, id string) (Schedule, error) {
	return scanSchedule(s.db.QueryRowContext(ctx, scheduleSelect+` WHERE id=?`, id))
}
func (s *Store) ListSchedules(ctx context.Context, lakeID string) ([]Schedule, error) {
	query := scheduleSelect
	var args []any
	if lakeID != "" {
		query += ` WHERE lake_id=?`
		args = append(args, lakeID)
	}
	query += ` ORDER BY created_at DESC,id`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Schedule, 0)
	for rows.Next() {
		item, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) SetScheduleEnabled(ctx context.Context, id string, enabled bool) (Schedule, error) {
	value := 0
	if enabled {
		value = 1
	}
	result, err := s.db.ExecContext(ctx, `UPDATE schedule SET enabled=?,updated_at=? WHERE id=?`, value, nowMillis(), id)
	if err != nil {
		return Schedule{}, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return Schedule{}, ErrNotFound
	}
	return s.GetSchedule(ctx, id)
}

func scanScheduleRun(row scanner) (ScheduleRun, error) {
	var item ScheduleRun
	var workflowRunID sql.NullString
	var due, created, updated int64
	err := row.Scan(&item.ID, &item.ScheduleID, &workflowRunID, &due, &item.Status, &item.LeaseOwner, &item.Reason, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return item, ErrNotFound
	}
	if err != nil {
		return item, err
	}
	item.WorkflowRunID = workflowRunID.String
	item.DueAt = fromMillis(due)
	item.CreatedAt = fromMillis(created)
	item.UpdatedAt = fromMillis(updated)
	return item, nil
}

const scheduleRunSelect = `SELECT id,schedule_id,workflow_run_id,due_at,status,lease_owner,reason,created_at,updated_at FROM schedule_run`

func (s *Store) GetScheduleRun(ctx context.Context, id string) (ScheduleRun, error) {
	return scanScheduleRun(s.db.QueryRowContext(ctx, scheduleRunSelect+` WHERE id=?`, id))
}
func (s *Store) ListScheduleRuns(ctx context.Context, scheduleID string) ([]ScheduleRun, error) {
	rows, err := s.db.QueryContext(ctx, scheduleRunSelect+` WHERE schedule_id=? ORDER BY created_at DESC,id LIMIT 100`, scheduleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ScheduleRun, 0)
	for rows.Next() {
		item, err := scanScheduleRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// ClaimDueSchedule moves the due cursor and inserts a unique run under one
// SQLite write transaction. An expired process never reclaims the same due_at.
func (s *Store) ClaimDueSchedule(ctx context.Context, owner string, now time.Time, lease time.Duration, advance func(Schedule) (*time.Time, error)) (Schedule, ScheduleRun, error) {
	if owner == "" || lease <= 0 || lease > 10*time.Minute || advance == nil {
		return Schedule{}, ScheduleRun{}, errors.New("计划认领参数无效")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	defer tx.Rollback()
	item, err := scanSchedule(tx.QueryRowContext(ctx, scheduleSelect+` WHERE enabled=1 AND next_at<=? AND lease_until<=? ORDER BY next_at,id LIMIT 1`, now.UnixMilli(), now.UnixMilli()))
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	due := *item.NextAt
	next, err := advance(item)
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	if item.Kind == "cron" && (next == nil || !next.After(due)) {
		return Schedule{}, ScheduleRun{}, errors.New("下一次计划时间无效")
	}
	if item.Kind == "once" {
		next = nil
	}
	var nextValue any
	if next != nil {
		nextValue = next.UnixMilli()
	}
	nowMS := now.UnixMilli()
	result, err := tx.ExecContext(ctx, `UPDATE schedule SET next_at=?,lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND next_at=? AND lease_until<=?`, nextValue, owner, now.Add(lease).UnixMilli(), nowMS, item.ID, due.UnixMilli(), nowMS)
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return Schedule{}, ScheduleRun{}, errors.New("计划已被其他进程认领")
	}
	runID, err := newID()
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO schedule_run(id,schedule_id,due_at,status,lease_owner,created_at,updated_at) VALUES(?,?,?,'claimed',?,?,?)`, runID, item.ID, due.UnixMilli(), owner, nowMS, nowMS)
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	if err := tx.Commit(); err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	claimed, err := s.GetSchedule(ctx, item.ID)
	if err != nil {
		return Schedule{}, ScheduleRun{}, err
	}
	run, err := s.GetScheduleRun(ctx, runID)
	return claimed, run, err
}

func (s *Store) FinishScheduleRun(ctx context.Context, runID, owner, status, workflowRunID, reason string, now time.Time) error {
	switch status {
	case "running", "waiting_approval", "completed", "failed", "missed", "unknown":
	default:
		return errors.New("计划运行状态无效")
	}
	if len(reason) > 200 {
		return errors.New("计划运行原因过长")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var scheduleID, currentOwner, currentStatus string
	err = tx.QueryRowContext(ctx, `SELECT schedule_id,lease_owner,status FROM schedule_run WHERE id=?`, runID).Scan(&scheduleID, &currentOwner, &currentStatus)
	if err != nil {
		return err
	}
	if owner == "" || currentOwner != owner || currentStatus != "claimed" && currentStatus != "running" {
		return errors.New("计划认领者不匹配")
	}
	var leaseOwner string
	var leaseUntil int64
	if err := tx.QueryRowContext(ctx, `SELECT lease_owner,lease_until FROM schedule WHERE id=?`, scheduleID).Scan(&leaseOwner, &leaseUntil); err != nil {
		return err
	}
	if leaseOwner != owner || leaseUntil <= now.UnixMilli() {
		return errors.New("计划租约已失效")
	}
	var workflowValue any
	if workflowRunID != "" {
		workflowValue = workflowRunID
	}
	result, err := tx.ExecContext(ctx, `UPDATE schedule_run SET workflow_run_id=COALESCE(?,workflow_run_id),status=?,reason=?,updated_at=? WHERE id=? AND lease_owner=?`, workflowValue, status, reason, now.UnixMilli(), runID, owner)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrNotFound
	}
	if status != "running" {
		fail := 0
		if status == "failed" || status == "unknown" {
			fail = 1
		}
		var failures int
		if err := tx.QueryRowContext(ctx, `SELECT fail_count FROM schedule WHERE id=?`, scheduleID).Scan(&failures); err != nil {
			return err
		}
		backoff := time.Duration(0)
		if fail == 1 {
			if failures > 5 {
				failures = 5
			}
			backoff = time.Minute * time.Duration(1<<failures)
		}
		backoffUntil := now.Add(backoff).UnixMilli()
		_, err = tx.ExecContext(ctx, `UPDATE schedule SET lease_owner='',lease_until=0,fail_count=CASE WHEN ?=1 THEN fail_count+1 ELSE 0 END,enabled=CASE WHEN ?='unknown' THEN 0 ELSE enabled END,next_at=CASE WHEN ?=1 AND next_at IS NOT NULL AND next_at<? THEN ? ELSE next_at END,updated_at=? WHERE id=? AND lease_owner=?`, fail, status, fail, backoffUntil, backoffUntil, now.UnixMilli(), scheduleID, owner)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) RenewScheduleLease(ctx context.Context, scheduleID, owner string, now time.Time, lease time.Duration) error {
	if owner == "" || lease <= 0 || lease > 10*time.Minute {
		return errors.New("计划续租参数无效")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE schedule SET lease_until=?,updated_at=? WHERE id=? AND lease_owner=? AND lease_until>?`, now.Add(lease).UnixMilli(), now.UnixMilli(), scheduleID, owner, now.UnixMilli())
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count != 1 {
		return errors.New("计划租约已失效")
	}
	return nil
}

// Expired in-flight runs become unknown and pause their schedule. In particular,
// neither the same due time nor a later cron tick can replay a possibly executed write.
func (s *Store) MarkExpiredScheduleRuns(ctx context.Context, now time.Time) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE schedule_run SET status='unknown',reason='lease_expired',updated_at=? WHERE status IN ('claimed','running') AND schedule_id IN (SELECT id FROM schedule WHERE lease_until>0 AND lease_until<=?)`, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return 0, err
	}
	count, _ := result.RowsAffected()
	_, err = tx.ExecContext(ctx, `UPDATE schedule SET enabled=0,lease_owner='',lease_until=0,updated_at=? WHERE lease_until>0 AND lease_until<=?`, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return 0, err
	}
	return count, tx.Commit()
}

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func (s *Store) CreateScheduleGrant(ctx context.Context, scheduleID, nodeID, resourceID, commandSHA string, expiry time.Time, maxRuns int) (ScheduleGrant, error) {
	if nodeID == "" || resourceID == "" || !validDigest(commandSHA) || expiry.IsZero() || maxRuns < 1 || maxRuns > 10000 {
		return ScheduleGrant{}, errors.New("计划授权参数无效")
	}
	schedule, err := s.GetSchedule(ctx, scheduleID)
	if err != nil {
		return ScheduleGrant{}, err
	}
	if !schedule.Enabled || !expiry.After(time.Now()) {
		return ScheduleGrant{}, errors.New("计划已停止或授权已经到期")
	}
	def, err := s.GetWorkflowV2(ctx, schedule.WorkflowID)
	if err != nil {
		return ScheduleGrant{}, err
	}
	if def.Revision != schedule.WorkflowRevision {
		return ScheduleGrant{}, errors.New("计划工作流版本已变化")
	}
	resource, err := s.GetResource(ctx, resourceID)
	if err != nil {
		return ScheduleGrant{}, err
	}
	if resource.LakeID != schedule.LakeID || resource.Kind != "host" || !resource.ExecuteAuthz {
		return ScheduleGrant{}, errors.New("计划授权资源无效或未开启执行授权")
	}
	id, err := newID()
	if err != nil {
		return ScheduleGrant{}, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO schedule_grant(id,schedule_id,workflow_revision,node_id,resource_id,command_sha256,expires_at,max_runs,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, scheduleID, schedule.WorkflowRevision, nodeID, resourceID, commandSHA, expiry.UnixMilli(), maxRuns, nowMillis())
	if err != nil {
		return ScheduleGrant{}, err
	}
	return s.GetScheduleGrant(ctx, id)
}

func (s *Store) GetScheduleGrant(ctx context.Context, id string) (ScheduleGrant, error) {
	var item ScheduleGrant
	var expiry, created int64
	err := s.db.QueryRowContext(ctx, `SELECT id,schedule_id,workflow_revision,node_id,resource_id,command_sha256,expires_at,max_runs,used_runs,created_at FROM schedule_grant WHERE id=?`, id).Scan(&item.ID, &item.ScheduleID, &item.WorkflowRevision, &item.NodeID, &item.ResourceID, &item.CommandSHA256, &expiry, &item.MaxRuns, &item.UsedRuns, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return item, ErrNotFound
	}
	if err != nil {
		return item, err
	}
	item.ExpiresAt = fromMillis(expiry)
	item.CreatedAt = fromMillis(created)
	return item, nil
}

type ScheduleGrantUse struct{ NodeID, ResourceID, CommandSHA256 string }

func (s *Store) ConsumeScheduleGrants(ctx context.Context, scheduleID string, revision int, calls []ScheduleGrantUse, now time.Time) error {
	if len(calls) == 0 {
		return errors.New("计划授权调用为空")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var actualRevision, enabled, scheduleEnabled int
	if err := tx.QueryRowContext(ctx, `SELECT d.revision,d.enabled,p.enabled FROM schedule p JOIN workflow_v2_definition d ON d.id=p.workflow_id WHERE p.id=? AND p.workflow_revision=?`, scheduleID, revision).Scan(&actualRevision, &enabled, &scheduleEnabled); err != nil {
		return err
	}
	if actualRevision != revision || enabled != 1 || scheduleEnabled != 1 {
		return errors.New("计划工作流版本已变化或停用")
	}
	for _, call := range calls {
		if !validDigest(call.CommandSHA256) {
			return errors.New("计划命令哈希无效")
		}
		result, err := tx.ExecContext(ctx, `UPDATE schedule_grant SET used_runs=used_runs+1 WHERE schedule_id=? AND workflow_revision=? AND node_id=? AND resource_id=? AND command_sha256=? AND expires_at>? AND used_runs<max_runs AND EXISTS (SELECT 1 FROM resource r JOIN schedule p ON p.id=schedule_grant.schedule_id WHERE r.id=schedule_grant.resource_id AND r.lake_id=p.lake_id AND r.kind='host' AND r.execute_authz=1)`, scheduleID, revision, call.NodeID, call.ResourceID, call.CommandSHA256, now.UnixMilli())
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n != 1 {
			return fmt.Errorf("节点 %q 缺少有效计划授权", call.NodeID)
		}
	}
	return tx.Commit()
}

func CommandSHA256(command string) string {
	sum := sha256.Sum256([]byte(command))
	return hex.EncodeToString(sum[:])
}
