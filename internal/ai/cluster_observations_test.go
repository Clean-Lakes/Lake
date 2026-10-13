package ai

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestClusterReadProjectionsAndTargetIdentity(t *testing.T) {
	for _, metric := range []string{"identity", "nodes", "pods", "events", "resources"} {
		command, err := clusterCommand(metric, "production'$(touch /tmp/escape)")
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"get secrets", "--raw", "--flatten", "kubectl exec", " delete ", " apply ", " rollout ", " describe pods", ".spec.containers"} {
			if strings.Contains(command, forbidden) {
				t.Fatal("unsafe cluster observation", metric, forbidden)
			}
		}
		if !strings.Contains(command, "--context='production'\"'\"'$(touch /tmp/escape)'") {
			t.Fatal("context escaped its literal argument")
		}
	}
	for _, metric := range []string{"delete", "secret", "pods; touch /tmp/escape"} {
		if _, err := clusterCommand(metric, ""); err == nil {
			t.Fatal("model supplied an arbitrary cluster operation")
		}
	}
	identity, err := clusterIdentity("https://cluster.example:6443\nmaster\t192.168.2.75\nworker\t192.168.2.79\n", []string{"192.168.2.75", "192.168.2.79"})
	if err != nil || identity["target_match"] != true {
		t.Fatal("selected cluster not matched", err)
	}
	identity, err = clusterIdentity("https://old.example:6443\nold-master\t172.16.31.14\n", []string{"192.168.2.75"})
	if err == nil || identity["target_match"] != false {
		t.Fatal("unrelated kubeconfig accepted")
	}
	identity, err = clusterIdentity("https://cluster.example:6443\nmaster\t192.168.2.75\n", nil)
	if err != nil || identity["target_match"] != false {
		t.Fatal("missing resource addresses reported as verified")
	}
	if _, err := clusterIdentity("error: missing kubeconfig", nil); err == nil {
		t.Fatal("failed identity converted to cluster health")
	}
}

func TestClusterIdentityProjectionUsesRealKubectlFormatter(t *testing.T) {
	kubectl, err := exec.LookPath("kubectl")
	if err != nil {
		t.Skip("kubectl not installed")
	}
	path := filepath.Join(t.TempDir(), "fixture-config")
	config := "apiVersion: v1\nkind: Config\ncurrent-context: fixture\ncontexts:\n- name: fixture\n  context:\n    cluster: fixture\nclusters:\n- name: fixture\n  cluster:\n    server: https://127.0.0.1:9\nusers: []\n"
	if err := os.WriteFile(path, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	// Config view is local formatting only; this test never connects to a cluster.
	output, err := exec.CommandContext(context.Background(), kubectl, "--kubeconfig="+path, "config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}{'\\n'}").CombinedOutput()
	if err != nil || string(output) != "https://127.0.0.1:9\n" {
		t.Fatalf("invalid identity formatter: %s %v", output, err)
	}
}

func TestClusterObservationExecutesOnlyMatchingReadOnlyQueries(t *testing.T) {
	dir := t.TempDir()
	program := "#!/bin/sh\ncase \"$*\" in\n*'config view'*) printf 'https://selected.example:6443';;\n*'get nodes --no-headers'*) printf 'master\\t192.168.2.75\\nworker\\t192.168.2.79\\n';;\n*'get pods'*) printf 'default app Running true 0 worker\\n';;\n*) echo 'unsupported fixture query' >&2; exit 7;;\nesac\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(program), 0700); err != nil {
		t.Fatal(err)
	}
	execute := func(command string) (any, error) {
		cmd := exec.Command("/bin/sh", "-c", command)
		// This fixture deliberately controls only PATH and has no credentials.
		// /usr/local/bin is prepended by production; substitute the fake trusted installation here.
		command = strings.Replace(command, "PATH=/usr/local/bin:$PATH;", "", 1)
		cmd = exec.Command("/bin/sh", "-c", command)
		cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "HOME=" + dir}
		output, err := cmd.CombinedOutput()
		code := 0
		if err != nil {
			code = 1
		}
		return map[string]any{"output": string(output), "exitCode": code}, err
	}
	value, err := readClusterSnapshot("pods", "", []string{"192.168.2.75"}, execute)
	if err != nil || !strings.Contains(str(obj(value)["output"]), "app Running true") || obj(obj(value)["identity"])["target_match"] != true {
		t.Fatal("matching cluster observation failed", value, err)
	}
	program = strings.ReplaceAll(program, "192.168.2.75", "172.16.31.14")
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(program), 0700); err != nil {
		t.Fatal(err)
	}
	value, err = readClusterSnapshot("pods", "", []string{"192.168.2.75"}, execute)
	if err == nil || strings.Contains(str(obj(value)["output"]), "app Running true") {
		t.Fatal("workload data read from a different cluster", value)
	}
}
