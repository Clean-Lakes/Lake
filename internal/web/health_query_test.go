package web

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const starRocksHealthQuery = `ps -eo pid,stat,etime,pcpu,rss,args --no-headers | grep -E '[s]tarrocks_(be|fe)'; systemctl is-active starrocks-be starrocks-fe; curl -s -m 5 http://127.0.0.1:8040/api/health; echo; free -m | head -2`

func TestHealthQueryPolicyIsNarrow(t *testing.T) {
	for _, command := range []string{starRocksHealthQuery, `curl -fsS http://localhost:8040/healthz`, `curl -I --url http://127.0.0.1/readyz`} {
		if p := CommandPolicy(command); p.Risk != "readonly" || !strings.Contains(p.Safe, "'-q' '--globoff' '--noproxy' '*'") {
			t.Fatalf("health query did not get safe bounded rendering: %s", command)
		}
	}
	for _, args := range []string{
		`-X POST http://127.0.0.1/api/health`, `-d data http://127.0.0.1/api/health`,
		`-T /tmp/file http://127.0.0.1/api/health`, `-o /tmp/file http://127.0.0.1/api/health`,
		`-w '%output{/tmp/file}' http://127.0.0.1/api/health`, `-K /tmp/config http://127.0.0.1/api/health`,
		`-L http://127.0.0.1/api/health`, `--proxy http://proxy http://127.0.0.1/api/health`,
		`http://example.com/api/health`, `http://127.0.0.1/restart`, `http://127.0.0.1/api/health?command=restart`,
		`http://user:pass@127.0.0.1/api/health`, `file:///etc/passwd`, `http://127.0.0.1/api/%68ealth`,
		`-m NaN http://127.0.0.1/api/health`, `-m 0 http://127.0.0.1/api/health`,
		`http://127.0.0.1/api/health http://127.0.0.1/healthz`, `--next http://127.0.0.1/api/health`,
	} {
		if CommandPolicy("curl "+args).Risk == "readonly" {
			t.Fatalf("unsafe curl became readonly: %s", args)
		}
	}
	if CommandPolicy(`curl http://127.0.0.1/health; systemctl restart app`).Risk == "readonly" {
		t.Fatal("health query allowed a following mutation")
	}
}

func TestHealthQueryExecutesWithoutCurlrcProxyOrRedirect(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("curl unavailable")
	}
	targetCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			targetCalls++
		}
		w.Header().Set("Location", "/mutate")
		w.WriteHeader(http.StatusFound)
	}))
	defer server.Close()
	dir := t.TempDir()
	marker := filepath.Join(dir, "must-not-exist")
	if err := os.WriteFile(filepath.Join(dir, ".curlrc"), []byte("output = "+marker+"\nlocation\n"), 0600); err != nil {
		t.Fatal(err)
	}
	p := CommandPolicy("curl -s " + server.URL + "/api/health")
	if p.Risk != "readonly" {
		t.Fatal("fixture query rejected")
	}
	cmd := exec.Command("/bin/sh", "-c", p.Safe)
	cmd.Env = append(os.Environ(), "CURL_HOME="+dir, "http_proxy=http://127.0.0.1:1", "ALL_PROXY=http://127.0.0.1:1", "NO_PROXY=")
	if _, err := cmd.Output(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) || targetCalls != 0 {
		t.Fatal("health query used curlrc or followed a redirect")
	}
}
