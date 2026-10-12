package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSignedReleaseWithoutNodeRuntime(t *testing.T) {
	binary := os.Getenv("LAKE_TEST_SIGNED_BINARY")
	if binary == "" {
		t.Skip("set LAKE_TEST_SIGNED_BINARY to scripts/build_lake.sh output")
	}
	binary, e := filepath.Abs(binary)
	if e != nil {
		t.Fatal(e)
	}
	home := t.TempDir()
	noExecutables := t.TempDir()
	probe, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "web", "--port", fmt.Sprint(port), "--home", home)
	cmd.Env = []string{"PATH=" + noExecutables, "HOME=" + home, "LANG=en_US.UTF-8", "LAKE_WEB_TOKEN=synthetic-release-test-token"}
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { cmd.Process.Signal(os.Interrupt); cmd.Wait() }()
	ready := make(chan bool, 1)
	go func() {
		scan := bufio.NewScanner(out)
		for scan.Scan() {
			if strings.Contains(scan.Text(), "Go backend listening") {
				ready <- true
				return
			}
		}
		ready <- false
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("Go release failed to start")
		}
	case <-ctx.Done():
		t.Fatal("Go release start timed out")
	}
	origin := fmt.Sprintf("http://localhost:%d", port)
	request := func(method, path string, data any) map[string]any {
		t.Helper()
		var body io.Reader
		if data != nil {
			b, _ := json.Marshal(data)
			body = bytes.NewReader(b)
		}
		r, _ := http.NewRequestWithContext(ctx, method, origin+path, body)
		r.Header.Set("Authorization", "Bearer synthetic-release-test-token")
		if data != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		if res.StatusCode >= 400 {
			t.Fatalf("%s %s: %d", method, path, res.StatusCode)
		}
		var v map[string]any
		json.NewDecoder(res.Body).Decode(&v)
		return v
	}
	bootstrap := request("GET", "/api/bootstrap", nil)
	if bootstrap["backendRuntime"] != "go" || bootstrap["terminalMode"] != "pty" {
		t.Fatal(bootstrap)
	}
	res, e := http.Get(origin + "/")
	if e != nil {
		t.Fatal(e)
	}
	html, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Contains(html, []byte("/assets/")) {
		t.Fatal("embedded React assets missing")
	}
	p := request("POST", "/api/projects", map[string]any{"name": "no Node"})
	s := request("POST", "/api/projects/"+p["id"].(string)+"/sessions", map[string]any{"title": "no Node PTY"})
	sid := s["id"].(string)
	ref := s["resourceIds"].([]any)[0].(string)
	term := request("POST", "/api/sessions/"+sid+"/terminals", map[string]any{"resourceId": ref})
	tid := term["id"].(string)
	request("POST", "/api/sessions/"+sid+"/terminals/"+tid+"/commands", map[string]any{"actor": "user", "command": "uname -s"})
	until := time.Now().Add(3 * time.Second)
	ok := false
	for time.Now().Before(until) {
		history := request("GET", "/api/sessions/"+sid+"/terminals/"+tid+"/history", nil)
		if strings.Contains(history["output"].(string), "Darwin") || strings.Contains(history["output"].(string), "Linux") {
			ok = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ok {
		t.Fatal("PTY failed without Node in PATH")
	}
	request("POST", "/api/sessions/"+sid+"/terminals/"+tid+"/disconnect", map[string]any{})
}
func TestSyntheticCredentialMigration(t *testing.T) {
	home := t.TempDir()
	entries := []migrationEntry{{Kind: "model", LegacyID: "fixture", NewID: "fixture"}}
	load := func(migrationEntry) ([]byte, error) { return []byte("synthetic-model-value"), nil }
	if e := migrateEntries(home, entries, load); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(home, "secrets", "models", "fixture")
	st, e := os.Stat(path)
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("nonprivate migration result", e)
	}
	if e = migrateEntries(home, entries, load); e != nil {
		t.Fatal("not idempotent", e)
	}
	if e = migrateEntries(home, entries, func(migrationEntry) ([]byte, error) { return []byte("different synthetic value"), nil }); e == nil {
		t.Fatal("overwrote different credential")
	}
}
