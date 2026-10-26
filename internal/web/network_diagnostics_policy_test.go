package web

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNetworkToolResolutionIgnoresUserPathAndFunctions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX system tools")
	}
	key := "kernel.ostype"
	if runtime.GOOS == "darwin" {
		key = "hw.ncpu"
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "shadow-was-executed")
	if err := os.WriteFile(filepath.Join(dir, "sysctl"), []byte("#!/bin/sh\ntouch "+quote(marker)+"\nprintf SHADOW"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"sysctl -n " + key, "sysctl -n " + key + " 2>&1"} {
		p := CommandPolicy(query)
		if p.Risk != "readonly" {
			t.Fatal("query rejected", p)
		}
		cmd := exec.Command("/bin/sh", "-c", "sysctl() { printf FUNCTION_SHADOW; }; "+p.Safe)
		cmd.Env = append(os.Environ(), "PATH="+dir)
		output, err := cmd.CombinedOutput()
		if err != nil || strings.TrimSpace(string(output)) == "" || strings.Contains(string(output), "SHADOW") {
			t.Fatalf("trusted system lookup failed: %v %s", err, output)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("untrusted PATH tool executed")
	}
}

func TestPilotNetworkDiagnosticsPolicy(t *testing.T) {
	for _, command := range []string{
		`date -Is; ip -br addr; ip route; ip route show default; cat /etc/resolv.conf 2>&1; hostname`,
		`/usr/sbin/ethtool eth0`, `ethtool -S eth0`,
		`getent ahostsv4 www.baidu.com`, `getent hosts example.com`,
		`nslookup example.com`, `nslookup example.com 1.1.1.1`,
		`ping -c 5 -W 2 10.27.0.1`, `ping6 -n -c 3 ::1`,
		`curl -sS -I --max-time 10 https://www.baidu.com`,
		`curl --head --url http://192.0.2.1/`, `dmesg | tail -30`,
	} {
		p := CommandPolicy(command)
		if p.Risk != "readonly" || p.Safe == "" {
			t.Errorf("diagnostic rejected: %q (%s)", command, p.Risk)
		}
		if strings.HasPrefix(command, "curl") && !strings.Contains(p.Safe, "'-q' '--globoff' '--noproxy' '*'") {
			t.Fatal("curl configuration bypassed")
		}
	}
	for _, command := range []string{
		`date -s 20260101`, `ethtool -s eth0 speed 100`, `ethtool --reset eth0`,
		`ethtool -E eth0 value 1`, `getent -s /tmp/evil hosts example.com`,
		`nslookup -debug example.com`, `ping example.com`, `ping -f -c 5 example.com`,
		`ping -c 500000 example.com`, `ping -c 5 -i 0.001 example.com`, `ping -c 0 example.com`,
		`ping -c 5 example.com; touch /tmp/changed`, `dmesg -C`, `dmesg --clear`,
		`curl https://example.com`, `curl -I https://example.com/restart`,
		`curl -I https://example.com/?action=restart`, `curl -I -L https://example.com`,
		`curl -I -X POST https://example.com`, `curl -I -K /tmp/evil https://example.com`,
		`curl -I -o /tmp/changed https://example.com`, `curl -I -w '%output{/tmp/changed}' https://example.com`,
		`curl -I https://user:pass@example.com`, `curl -I file:///tmp/source`,
		`curl -I https://example.com https://example.org`,
	} {
		if CommandPolicy(command).Risk == "readonly" {
			t.Errorf("unsafe diagnostic accepted: %q", command)
		}
	}
}
