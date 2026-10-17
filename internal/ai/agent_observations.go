package ai

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"time"
)

func (e *Engine) observation(ctx context.Context, c Config, name string, a map[string]any) (any, error) {
	w := e.worker
	if w == nil {
		return nil, errors.New("观察工具仅供受控子 Agent 使用")
	}
	allowed := map[string]string{"host": "observe_host", "application": "observe_logs", "data": "observe_data", "verify": "read_evidence"}
	clusterRole := w.role == "host" || w.role == "application" || w.role == "data"
	sreRead := c.sre != nil && (c.sre.Role == SREInvestigator || c.sre.Role == SREVerifier) && sreProbeTools[name]
	if !sreRead && !(c.sre != nil && (c.sre.FullTools || c.sre.Role == SREInvestigator) && name == "read_evidence") && allowed[w.role] != name && !(clusterRole && name == "observe_cluster") && !((w.role == "application" || w.role == "data") && name == "observe_cluster_logs") && !((w.role == "host" || w.role == "application") && name == "observe_journal") {
		return nil, errors.New("此职责不能使用该观察工具")
	}
	if name == "read_evidence" {
		ownRun := []string{}
		if c.sre != nil && (c.sre.FullTools || c.sre.Role == SREInvestigator) {
			ownRun = append(ownRun, w.runID)
		}
		value, ids, err := w.parent.readAgentEvidence(w.session, a, ownRun...)
		if err != nil {
			return nil, err
		}
		if err := w.parent.updateAgent(w, func(r *AgentRun) {
			for _, id := range ids {
				found := false
				for _, known := range r.EvidenceIDs {
					found = found || known == id
				}
				if !found {
					r.EvidenceIDs = append(r.EvidenceIDs, id)
				}
			}
		}); err != nil {
			return nil, err
		}
		return value, nil
	}
	for key := range a {
		if key != "asset_ref" && key != "metric" && key != "path" && !(strings.HasPrefix(name, "observe_cluster") && (key == "context" || key == "kubeconfig" || key == "namespace" || key == "pod" || key == "container" || key == "since_minutes" || key == "previous")) && !(name == "observe_journal" && (key == "unit" || key == "since_minutes")) {
			return nil, errors.New("观察工具不接受自定义命令、SQL、运行时或身份参数")
		}
	}
	as, err := asset(c, str(a["asset_ref"]))
	if err != nil {
		return nil, err
	}
	w.mu.Lock()
	readArgs := a
	if name == "observe_host" && str(a["metric"]) != "disk_usage" {
		// path is ignored by these fixed probes; varying it is not a new sample.
		readArgs = map[string]any{"asset_ref": as.ID, "metric": a["metric"]}
	}
	readKey := as.ID + ":" + name + ":" + js(readArgs)
	cacheRead := c.sre != nil && c.sre.Role == SREInvestigator
	if cacheRead && w.sreObservations[readKey] != nil {
		cached := map[string]any{}
		for k, v := range obj(w.sreObservations[readKey]) {
			cached[k] = v
		}
		cached["reused"] = true
		w.mu.Unlock()
		return cached, nil
	}
	w.reads[readKey]++
	reads := w.reads[readKey]
	w.mu.Unlock()
	if reads > 2 {
		return nil, errors.New("同一资源相同观察的本轮次数已达到上限")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case w.parent.collectionSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-w.parent.collectionSlots }()
	slot, _ := w.parent.observationSlots.LoadOrStore(as.ID, make(chan struct{}, 2))
	slots := slot.(chan struct{})
	select {
	case slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-slots }()
	var value any
	switch name {
	case "observe_cluster":
		value, err = e.observeCluster(ctx, c, as, a)
	case "observe_cluster_logs":
		value, err = e.observeClusterLogs(ctx, c, as, a)
	case "observe_journal":
		value, err = e.observeJournal(ctx, c, as, a)
	case "observe_host":
		if as.Kind != "local" && as.Kind != "ssh" {
			return nil, errors.New("Scout 仅调查分配的本机或 SSH 主机")
		}
		command := ""
		switch str(a["metric"]) {
		case "overview", "status":
			command = "uname -a; uptime; if [ \"$(uname -s)\" = Darwin ]; then LC_ALL=C top -l 2 -n 0 -s 1 | tail -n 14; vm_stat; sysctl vm.swapusage; else LC_ALL=C vmstat 1 2; free -m; fi; df -Pk"
		case "processes":
			command = "ps -Ao pid,pcpu,pmem,comm | sort -nr -k 2 | head -n 40"
		case "disk_usage", "open_deleted":
			command, err = hostDetailCommand(str(a["metric"]), str(a["path"]))
			if err != nil {
				return nil, err
			}
		default:
			return nil, errors.New("不支持的主机指标")
		}
		if str(a["metric"]) == "status" {
			command = strings.TrimSuffix(command, "; df -Pk")
			command += "; if [ \"$(uname -s)\" = Darwin ]; then sysctl -n hw.memsize; fi; if command -v systemctl >/dev/null 2>&1; then printf '\\nKUBELET SERVICE STATUS (not Kubernetes Ready):\\n'; systemctl is-active kubelet 2>&1 || true; systemctl show kubelet --no-pager -p ActiveState -p SubState -p ExecMainStatus -p NRestarts 2>&1 || true; fi; df -Pk | head -n 25; ps -Ao pid,pcpu,pmem,comm | sort -nr -k 2 | head -n 25"
		}
		value, err = e.command(ctx, c, map[string]any{"asset_ref": as.ID, "runtime": as.Kind}, command)
		if err == nil && (str(a["metric"]) == "overview" || str(a["metric"]) == "status") {
			obj(value)["disks"] = hostSnapshotDisks(str(obj(value)["output"]))
			obj(value)["disk_note"] = "available_percent_of_total is computed from df available/total; df used% has a different denominator when blocks are reserved. This is not a measured kubelet eviction threshold or proof of DiskPressure."
		}
	case "observe_logs":
		if as.Kind != "local" && as.Kind != "ssh" {
			return nil, errors.New("Trace 仅读取分配主机的日志")
		}
		path := str(a["path"])
		if err = safeFile(path); err != nil {
			return nil, err
		}
		if !strings.HasSuffix(strings.ToLower(path), ".log") && !strings.HasPrefix(filepath.Clean(path), "/var/log/") {
			return nil, errors.New("请指定 .log 文件或 /var/log 下的日志")
		}
		if as.Kind == "local" {
			real, resolveErr := filepath.EvalSymlinks(path)
			if resolveErr != nil {
				return nil, errors.New("日志文件不可用")
			}
			if err = safeFile(real); err != nil {
				return nil, err
			}
			if c.CredentialDir != "" {
				privateRoot, _ := filepath.EvalSymlinks(c.CredentialDir)
				if privateRoot != "" && strings.HasPrefix(real, privateRoot+string(filepath.Separator)) {
					return nil, errors.New("子 Agent 不能读取凭据目录")
				}
			}
		}
		// Resolve the directory on the remote host and reject a linked file. The
		// resulting path cannot escape the credential-path exclusion via a symlink.
		command := "p=" + quote(path) + "; d=$(cd -P -- \"$(dirname -- \"$p\")\" && pwd -P) || exit 44; f=\"$d/$(basename -- \"$p\")\"; case \"$f\" in */.ssh/*|*/.lake/secrets/*|*/Keychains/*) exit 45;; esac; [ ! -L \"$f\" ] && [ -f \"$f\" ] || exit 44; tail -n 200 -- \"$f\""
		value, err = e.command(ctx, c, map[string]any{"asset_ref": as.ID, "runtime": as.Kind}, command)
	case "observe_data":
		metric := str(a["metric"])
		if metric != "health" && metric != "connections" && metric != "activity" {
			return nil, errors.New("不支持的数据指标")
		}
		if as.Kind == "redis" {
			command := map[string]string{"health": "PING", "connections": "INFO clients", "activity": "INFO stats"}[metric]
			value, err = e.redis(ctx, c, map[string]any{"asset_ref": as.ID, "command": command, "timeout_ms": 10000})
		} else if as.Kind == "database" {
			value, err = observeDatabase(ctx, c, as, metric)
		} else {
			return nil, errors.New("Deep 仅调查分配的数据库或 Redis")
		}
	}
	if strings.Contains(str(obj(value)["output"]), "\nLAKE_OBSERVATION_OUTPUT_TRUNCATED") {
		obj(value)["truncated"] = true
	}
	if err == nil && obj(value)["exitCode"] != nil && num(obj(value)["exitCode"], 0) != 0 {
		err = errors.New("观察命令未成功完成，请检查实际退出码")
		if name == "observe_logs" && num(obj(value)["exitCode"], 0) == 44 {
			err = errors.New("日志路径不存在、不是普通文件或指向符号链接；请使用实际日志路径，或改用 observe_journal / observe_cluster_logs，不要重复猜路径")
		}
	}
	result, recordErr := e.recordObservation(c, as.ID, name, value, err)
	if cacheRead && recordErr == nil {
		w.mu.Lock()
		if w.sreObservations == nil {
			w.sreObservations = map[string]any{}
		}
		w.sreObservations[readKey] = result
		w.mu.Unlock()
	}
	return result, recordErr
}

func observeDatabase(ctx context.Context, c Config, as Asset, metric string) (any, error) {
	db, driver, err := databaseOpen(as, true, "", c.CredentialDir)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	query := "SELECT 1 AS healthy"
	if metric != "health" {
		switch driver {
		case "pgx":
			if metric == "connections" {
				query = "SELECT state, count(*) AS connections FROM pg_stat_activity WHERE datname=current_database() GROUP BY state"
			} else {
				query = "SELECT numbackends, xact_commit, xact_rollback, deadlocks, blks_read, blks_hit FROM pg_stat_database WHERE datname=current_database()"
			}
		case "mysql":
			query = "SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Threads_connected','Threads_running','Connections','Slow_queries','Aborted_connects','Questions')"
		case "sqlite3":
			query = "SELECT type, count(*) AS objects FROM sqlite_master GROUP BY type"
		}
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, errors.New("只读数据库连接失败")
	}
	defer tx.Rollback()
	if driver == "sqlite3" {
		if _, err = tx.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
			return nil, errors.New("无法启用 SQLite 只读模式")
		}
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, errors.New("数据指标采集失败；请核对连接与只读账号权限")
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	for rows.Next() && len(result) < 100 {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for i, key := range columns {
			v := values[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			row[key] = v
		}
		result = append(result, row)
	}
	if err = rows.Err(); err != nil {
		return nil, errors.New("数据指标结果不完整")
	}
	return map[string]any{"metric": metric, "rows": result, "exitCode": 0}, nil
}
