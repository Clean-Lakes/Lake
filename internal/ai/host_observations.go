package ai

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
)

func hostSnapshotDisks(output string) []map[string]any {
	root, others := []map[string]any{}, []map[string]any{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || !strings.HasSuffix(fields[4], "%") || !strings.HasPrefix(fields[5], "/") {
			continue
		}
		total, e1 := strconv.ParseUint(fields[1], 10, 64)
		used, e2 := strconv.ParseUint(fields[2], 10, 64)
		available, e3 := strconv.ParseUint(fields[3], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil || total == 0 || available > total || used > total {
			continue
		}
		row := map[string]any{"filesystem": fields[0], "total_kib": total, "used_kib": used, "available_kib": available, "available_percent_of_total": float64(available) * 100 / float64(total), "df_used_percent": fields[4], "mount": strings.Join(fields[5:], " ")}
		if fields[5] == "/" {
			root = append(root, row)
		} else {
			others = append(others, row)
		}
	}
	rows := append(root, others...)
	return rows[:min(len(rows), 25)]
}

func boundedObservationCommand(query string, lines int) string {
	return "umask 077; lake_observation=$(mktemp) || exit 1; (" + query + ") >\"$lake_observation\" 2>&1; lake_observation_status=$?; head -n " + js(lines) + " \"$lake_observation\"; if [ \"$(wc -l < \"$lake_observation\")\" -gt " + js(lines) + " ]; then printf '\\nLAKE_OBSERVATION_OUTPUT_TRUNCATED\\n'; fi; rm -f \"$lake_observation\"; exit \"$lake_observation_status\""
}

func hostDetailCommand(metric, path string) (string, error) {
	if metric == "open_deleted" {
		return boundedObservationCommand("lsof -nP +L1", 100), nil
	}
	if metric != "disk_usage" {
		return "", errors.New("不支持的主机细节观察")
	}
	if err := safeFile(path); err != nil {
		return "", err
	}
	path = filepath.Clean(path)
	if !(strings.HasPrefix(path, "/var/lib/") || strings.HasPrefix(path, "/var/log/") || strings.HasPrefix(path, "/var/cache/")) {
		return "", errors.New("磁盘统计需指定 /var/lib、/var/log 或 /var/cache 下的具体目录；不扫描整盘或用户目录")
	}
	return boundedObservationCommand("p="+quote(path)+"; [ -d \"$p\" ] && [ ! -L \"$p\" ] || exit 44; du -x -k -d 1 -- \"$p\"", 100), nil
}

func journalObservationTool() Tool {
	return Tool{Name: "observe_journal", Description: "Read recent service journal on an assigned Linux local/SSH host. Choose a listed unit; output is bounded to 150 lines and a 1..60 minute time window. No arbitrary command or environment is accepted. Use this for kubelet GC/eviction and control-plane service evidence instead of guessing nonexistent .log files.", Parameters: map[string]any{"type": "object", "properties": map[string]any{"asset_ref": map[string]any{"type": "string"}, "unit": map[string]any{"type": "string", "enum": []string{"kubelet", "containerd", "docker", "etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler"}}, "since_minutes": map[string]any{"type": "integer", "minimum": 1, "maximum": 60}}, "required": []string{"asset_ref", "unit"}}}
}

func journalCommand(unit string, minutes int) (string, error) {
	switch unit {
	case "kubelet", "containerd", "docker", "etcd", "kube-apiserver", "kube-controller-manager", "kube-scheduler":
	default:
		return "", errors.New("不支持的服务日志")
	}
	if minutes < 1 || minutes > 60 {
		return "", errors.New("日志时间范围必须为 1–60 分钟")
	}
	return boundedObservationCommand("journalctl --no-pager -o short-iso -u "+quote(unit)+" --since "+quote(js(minutes)+" minutes ago")+" -n 150", 150), nil
}

func (e *Engine) observeJournal(ctx context.Context, c Config, as Asset, a map[string]any) (any, error) {
	if as.Kind != "local" && as.Kind != "ssh" {
		return nil, errors.New("服务日志仅支持分配的本机或 SSH 主机")
	}
	command, err := journalCommand(str(a["unit"]), num(a["since_minutes"], 20))
	if err != nil {
		return nil, err
	}
	return e.command(ctx, c, map[string]any{"asset_ref": as.ID, "runtime": as.Kind}, command)
}
