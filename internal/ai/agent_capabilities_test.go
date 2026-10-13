package ai

import (
	"math"
	"os/exec"
	"strings"
	"testing"
)

func TestBoundedObservationPreservesExitStatusAndMarksSourceTruncation(t *testing.T) {
	for _, row := range []struct {
		query     string
		code      int
		truncated bool
	}{{"printf 'one\\ntwo\\nthree\\n'; exit 7", 7, true}, {"printf 'one\\ntwo\\n'", 0, false}} {
		out, err := exec.Command("/bin/sh", "-c", boundedObservationCommand(row.query, 2)).CombinedOutput()
		code := 0
		if err != nil {
			if exit, ok := err.(*exec.ExitError); ok {
				code = exit.ExitCode()
			} else {
				t.Fatal(err)
			}
		}
		if code != row.code || strings.Contains(string(out), "LAKE_OBSERVATION_OUTPUT_TRUNCATED") != row.truncated || strings.Contains(string(out), "three") {
			t.Fatal("observation masked failure or clipping")
		}
	}
}

func TestReportedDiskAvailabilityUsesActualDfDenominator(t *testing.T) {
	rows := hostSnapshotDisks("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mapper/openeuler-root 71670904 57458072 10526432 85% /\n")
	if len(rows) != 1 || math.Abs(rows[0]["available_percent_of_total"].(float64)-14.68717624) > .0001 {
		t.Fatal("reported disk availability was copied from stale handoff instead of actual block counts")
	}
	if rows[0]["df_used_percent"] != "85%" {
		t.Fatal("changed original df observation")
	}
}

func TestChildToolsMatchResourcesWithoutOpeningArbitraryCommands(t *testing.T) {
	for _, role := range []string{"host", "application", "data"} {
		tools := js(childObservationTools(role, []Asset{{Kind: "ssh"}}))
		if !strings.Contains(tools, "observe_cluster") || strings.Contains(tools, `"name":"shell"`) || strings.Contains(tools, `"name":"observe_data"`) {
			t.Fatal("SSH capability mismatch", role)
		}
		if role == "data" && !strings.Contains(tools, "observe_cluster_logs") {
			t.Fatal("Deep cannot inspect Kubernetes data workloads")
		}
	}
	tools := js(childObservationTools("data", []Asset{{Kind: "redis"}}))
	if !strings.Contains(tools, "observe_data") || strings.Contains(tools, "observe_cluster") {
		t.Fatal("Redis received host tools")
	}
}
func TestBoundedJournalDiskAndClusterLogCommandsRejectInjection(t *testing.T) {
	for _, path := range []string{"/", "/root", "/var/lib/../../root", "/var/lib/.ssh/id_rsa"} {
		if _, err := hostDetailCommand("disk_usage", path); err == nil {
			t.Fatal("unsafe directory admitted", path)
		}
	}
	if _, err := journalCommand("kubelet;touch /tmp/escape", 20); err == nil {
		t.Fatal("unit injection")
	}
	if _, err := journalCommand("kubelet", 61); err == nil {
		t.Fatal("unbounded journal")
	}
	for _, a := range []map[string]any{{"namespace": "default", "pod": "redis;touch /tmp/escape"}, {"namespace": "default", "pod": "redis-0", "kubeconfig": "/root/.ssh/id_rsa"}, {"namespace": "default", "pod": "redis-0", "since_minutes": 200}} {
		if _, err := clusterLogCommand(a); err == nil {
			t.Fatal("unsafe Pod log query")
		}
	}
	command, err := clusterLogCommand(map[string]any{"namespace": "redis", "pod": "redis-2", "container": "redis", "previous": true, "kubeconfig": "/etc/kubernetes/admin.conf"})
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"logs 'redis-2'", "--tail=150", "--limit-bytes=65536", "--previous=true", "--kubeconfig='/etc/kubernetes/admin.conf'"} {
		if !strings.Contains(command, required) {
			t.Fatal("missing read bound", required)
		}
	}
	if _, err := exec.Command("/bin/sh", "-n", "-c", command).CombinedOutput(); err != nil {
		t.Fatal("invalid POSIX script")
	}
}
func TestClusterIdentityIgnoresTransportNoiseAndPreservesFailureOutput(t *testing.T) {
	input := "SSH notice\nLAKE_CLUSTER_IDENTITY_BEGIN\nwarning: API throttled\nhttps://selected.example:6443\nmaster 192.168.2.75\nLAKE_CLUSTER_IDENTITY_END\n"
	if identity, err := clusterIdentity(input, []string{"192.168.2.75"}); err != nil || identity["target_match"] != true {
		t.Fatal("noise broke valid projected identity", err)
	}
	if _, err := clusterIdentity(strings.Replace(input, "LAKE_CLUSTER_IDENTITY_END", "", 1), []string{"192.168.2.75"}); err == nil {
		t.Fatal("incomplete capture treated as success")
	}
	value, err := readClusterSnapshot("identity", "", []string{"192.168.2.75"}, func(string) (any, error) {
		return map[string]any{"output": "raw formatting/identity diagnostic", "exitCode": 0}, nil
	})
	if err == nil || str(obj(value)["output"]) != "raw formatting/identity diagnostic" {
		t.Fatal("failure lost its raw diagnostic")
	}
	// Child source errors still honor parent file-read approval and local-execution denial.
	p := DefaultPermissions()
	p.SilentReadFiles = false
	c := Config{Permissions: &p}
	for _, name := range []string{"observe_journal", "observe_cluster_logs"} {
		kind, err := approvalKind(c, name, "readonly", map[string]any{})
		if err != nil || kind != "file_read" {
			t.Fatal("new log source bypassed read approval")
		}
	}
}
