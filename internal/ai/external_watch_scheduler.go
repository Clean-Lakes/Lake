package ai

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

func (e *Engine) startWorkManager() {
	e.workContext, e.workCancel = context.WithCancel(context.Background())
	e.workDone = make(chan struct{})
	e.workReady = make(chan struct{})
	if e.workParent != nil {
		close(e.workDone)
		return
	}
	go func() {
		defer close(e.workDone)
		select {
		case <-e.workContext.Done():
			return
		case <-e.workReady:
		}
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-e.workContext.Done():
				return
			case <-ticker.C:
				if e.workParent != nil {
					continue
				}
				if _, err := os.Stat(filepath.Join(e.runtimeDirectory(), "sessions.sqlite")); err != nil {
					continue
				}
				_ = e.workTick(e.workContext)
			}
		}
	}()
}
func (e *Engine) workTick(ctx context.Context) error {
	store, err := e.adkStore()
	if err != nil {
		return err
	}
	var rows []nativeWorkGoal
	if err = store.DB.Where("status IN ?", []string{"waiting_external", "running"}).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if row.Checkpoint == "" || row.WaitCallID == "" {
			continue
		}
		var g WorkGoal
		if err = json.Unmarshal([]byte(row.Data), &g); err != nil {
			return err
		}
		// Do not observe or resume while the foreground owns this conversation.
		s, err := e.get(g.SessionID)
		if err != nil {
			continue
		}
		s.mu.Lock()
		busy := s.cancel != nil || s.finalizing
		c := s.state.Config
		s.mu.Unlock()
		if busy {
			continue
		}
		e.workConfigMu.Lock()
		configure := e.workConfigurator
		e.workConfigMu.Unlock()
		if configure != nil {
			fresh, configErr := configure(g.SessionID)
			if configErr != nil {
				g.Status = "blocked"
				g.Summary = "当前会话配置不可用，已保留任务进度"
				_ = e.writeWorkGoal(&row, &g, false)
				continue
			}
			c = fresh
		}

		now := time.Now()
		lease := uid()
		acquired := store.DB.Model(&nativeWorkGoal{}).Where("id = ? AND revision = ? AND lease_until < ?", row.ID, row.Revision, now).Updates(map[string]any{"lease_owner": lease, "lease_until": now.Add(45 * time.Second)})
		if acquired.Error != nil {
			return acquired.Error
		}
		if acquired.RowsAffected == 0 {
			continue
		}
		row.LeaseOwner = lease
		row.fence = lease
		row.LeaseUntil = now.Add(45 * time.Second)
		changed, ready := false, row.WaitState == "ready"
		if row.WaitState == "resuming" {
			g.Status = "blocked"
			g.Summary = "接续因服务退出中断；请核对原记录后恢复，未重放操作"
			changed = true
		}
		if now.After(g.DeadlineAt) || g.ModelRounds >= g.RoundLimit {
			g.Status = "paused"
			g.Summary = "任务期限或模型额度已到，已保留进度"
			changed = true
		} else if row.WaitState != "resuming" {
			for i := range g.Items {
				item := &g.Items[i]
				w := item.Watch
				if w == nil || item.Status != "waiting_external" || now.Before(w.NextCheckAt) {
					continue
				}
				renewed := store.DB.Model(&nativeWorkGoal{}).Where("id = ? AND lease_owner = ? AND revision = ?", row.ID, lease, row.Revision).Update("lease_until", time.Now().Add(45*time.Second))
				if renewed.Error != nil || renewed.RowsAffected != 1 {
					break
				}
				query, cancel := context.WithTimeout(ctx, 15*time.Second)
				e.workActive.Store(g.ID, cancel)
				state, readErr := e.observeWork(query, g, w, c)
				e.workActive.Delete(g.ID)
				cancel()
				if ctx.Err() != nil {
					break
				}
				changed = true
				w.Attempts++
				w.LastObservedAt = timestamp()
				w.NextCheckAt = now.Add(watchDelay(w.Attempts, item.ID))
				if readErr != nil {
					w.Failures++
					if w.Failures >= 5 || c.Permissions == nil || !c.Permissions.SilentCommands {
						item.Status = "blocked"
						item.Reason = "无法继续核对原任务；请检查连接与当前读取权限"
						ready = true
					}
					continue
				}
				w.Failures = 0
				if state != w.State {
					w.State = state
					if state != "running" {
						item.Status = state
						item.EvidenceIDs = []string{w.EvidenceID}
						ready = true
					}
				}
			}
			if ready {
				g.Status = reduceWorkGoal(g.Items)
				if g.Status == "completed" || g.Status == "failed" || g.Status == "waiting_user" {
					g.Status = "running"
				}
				row.WaitState = "ready"
			}
		}
		row.LeaseOwner = ""
		row.LeaseUntil = time.Time{}
		if changed {
			if err = e.writeWorkGoal(&row, &g, false); err != nil {
				continue
			}
		} else {
			store.DB.Model(&nativeWorkGoal{}).Where("id = ? AND lease_owner = ?", row.ID, lease).Updates(map[string]any{"lease_owner": "", "lease_until": time.Time{}})
		}
		row.fence = ""
		if ready && g.Status == "running" {
			if resumeErr := e.resumeWorkGoal(ctx, row, g, c); resumeErr != nil {
				return resumeErr
			}
		}
	}
	return e.flushWorkOutbox(ctx)
}

func (e *Engine) StartWorkManager() {
	if e.workParent == nil && e.worker == nil {
		e.workStart.Do(func() { close(e.workReady) })
	}
}
