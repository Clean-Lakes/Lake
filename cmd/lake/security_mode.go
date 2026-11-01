package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/platform"
)

// Normal mode changes use the live, authenticated host and its current catalog.
// Offline recovery remains a distinct protocol; no second Home owner is opened.
func runSecurityModeMaintenance(ctx context.Context, args []string) (bool, error) {
	flags := flag.NewFlagSet("security "+args[0], flag.ContinueOnError)
	home := flags.String("home", "", "explicit Home of a running local Lake backend")
	input := flags.String("input", "", "private activation action JSON")
	if err := flags.Parse(args[1:]); err != nil {
		return true, err
	}
	if *home == "" || flags.NArg() != 0 {
		return true, errors.New("an explicit --home is required")
	}
	control, err := ai.ReadSecurityControl(*home)
	if err != nil {
		return true, err
	}
	path := filepath.Join(filepath.Dir(control.RuntimeRoot), "runtime.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !platform.Private(path, info) || info.Size() > 16384 {
		return true, errors.New("security: a live private local runtime is required")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return true, err
	}
	var runtime struct {
		Origin, Token string
		PID           int
	}
	if json.Unmarshal(data, &runtime) != nil || runtime.Token == "" || runtime.PID < 1 {
		return true, errors.New("security: invalid private runtime")
	}
	origin, err := url.Parse(runtime.Origin)
	if err != nil || origin.Scheme != "http" || origin.User != nil || origin.Path != "" && origin.Path != "/" || origin.RawQuery != "" || origin.Fragment != "" {
		return true, errors.New("security: local loopback origin required")
	}
	host := origin.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return true, errors.New("security: local loopback origin required")
	}
	port, err := strconv.Atoi(origin.Port())
	if err != nil || port < 1 || port > 65535 {
		return true, errors.New("security: invalid loopback port")
	}
	method := http.MethodGet
	var payload []byte
	if args[0] != "mode" {
		var action ai.SecurityModeAction
		if err = readSecurityMaintenanceAction(*input, &action); err != nil {
			return true, err
		}
		want := "shadow"
		if args[0] == "enforce" {
			want = "enforced"
		}
		if action.Mode != "" && action.Mode != want {
			return true, errors.New("security: action mode differs from command")
		}
		action.Mode = want
		payload, err = json.Marshal(action)
		if err != nil {
			return true, err
		}
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, runtime.Origin+"/api/security/mode", bytes.NewReader(payload))
	if err != nil {
		return true, err
	}
	req.Header.Set("Authorization", "Bearer "+runtime.Token)
	req.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return true, errors.New("security: cannot reach the current local host")
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(result) > 65536 {
		return true, errors.New("security: invalid management response")
	}
	if response.StatusCode != 200 {
		return true, fmt.Errorf("security: local mode action refused (HTTP %d); inspect current mode readiness", response.StatusCode)
	}
	var status ai.SecurityModeStatus
	if json.Unmarshal(result, &status) != nil {
		return true, errors.New("security: invalid mode status")
	}
	return true, json.NewEncoder(os.Stdout).Encode(status)
}
