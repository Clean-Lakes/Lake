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

// Live recovery verification never opens a second Home owner and never sends
// its private runtime bearer to a non-loopback transport or a redirect.
func securityRecoveryLiveRequest(ctx context.Context, home, endpoint, method string, payload []byte) ([]byte, error) {
	control, err := ai.ReadSecurityControl(home)
	if err != nil {
		return nil, err
	}
	runtimePath := filepath.Join(filepath.Dir(control.RuntimeRoot), "runtime.json")
	info, err := os.Lstat(runtimePath)
	if err != nil || !info.Mode().IsRegular() || !platform.Private(runtimePath, info) || info.Size() > 16384 {
		return nil, errors.New("security: a live private local runtime is required")
	}
	data, err := os.ReadFile(runtimePath)
	if err != nil {
		return nil, err
	}
	var runtime struct {
		Origin, Token string
		PID           int
	}
	if json.Unmarshal(data, &runtime) != nil || runtime.Token == "" || runtime.PID < 1 {
		return nil, errors.New("security: invalid private runtime")
	}
	origin, err := url.Parse(runtime.Origin)
	if err != nil || origin.Scheme != "http" || origin.User != nil || origin.Path != "" && origin.Path != "/" || origin.RawQuery != "" || origin.Fragment != "" {
		return nil, errors.New("security: local loopback origin required")
	}
	host := origin.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, errors.New("security: local loopback origin required")
	}
	port, err := strconv.Atoi(origin.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("security: invalid loopback port")
	}
	req, err := http.NewRequestWithContext(ctx, method, runtime.Origin+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
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
		return nil, errors.New("security: cannot reach the current local host")
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(result) > 65536 {
		return nil, errors.New("security: invalid management response")
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("security: local recovery action refused (HTTP %d); inspect the source-bound recovery review", response.StatusCode)
	}

	return result, nil
}

func runSecurityRecoveryLiveMaintenance(ctx context.Context, args []string) (bool, error) {
	flags := flag.NewFlagSet("security "+args[0], flag.ContinueOnError)
	home := flags.String("home", "", "explicit Home of a running local Lake backend")
	input := flags.String("input", "", "private typed reconciliation action JSON")
	impact := flags.String("impact", "", "original source-bound impact ID")
	resource := flags.String("resource", "", "exact affected resource ID")
	operation := flags.String("operation", "", "new restricted verification operation ID")
	if err := flags.Parse(args[1:]); err != nil {
		return true, err
	}
	if *home == "" || flags.NArg() != 0 {
		return true, errors.New("an explicit --home is required")
	}
	method := http.MethodGet
	endpoint := "/api/security/recovery/review"
	var payload []byte
	switch args[0] {
	case "recovery-reconcile-preview":
		if *impact == "" || *resource == "" || *operation == "" {
			return true, errors.New("--impact, --resource, --operation are required")
		}
		query := url.Values{"impactId": {*impact}, "resourceId": {*resource}, "operationId": {*operation}}
		endpoint = "/api/security/recovery/reconcile-preview?" + query.Encode()
	case "recovery-reconcile":
		var action ai.SecurityRecoveryReconciliation
		if err := readSecurityMaintenanceAction(*input, &action); err != nil {
			return true, err
		}
		var err error
		payload, err = json.Marshal(action)
		if err != nil {
			return true, err
		}
		method = http.MethodPost
		endpoint = "/api/security/recovery/reconcile"
	}
	result, err := securityRecoveryLiveRequest(ctx, *home, endpoint, method, payload)
	if err != nil {
		return true, err
	}
	control, err := ai.ReadSecurityControl(*home)
	if err != nil {
		return true, err
	}
	var bound struct {
		RecoveryID    string `json:"recoveryId"`
		RecoveryEpoch string `json:"recoveryEpoch"`
	}
	if json.Unmarshal(result, &bound) != nil || bound.RecoveryID != control.RecoveryID || bound.RecoveryEpoch != control.RecoveryEpoch {
		return true, errors.New("security: recovery response identity mismatch")
	}
	var out any
	if json.Unmarshal(result, &out) != nil {
		return true, errors.New("security: invalid recovery response")
	}
	return true, json.NewEncoder(os.Stdout).Encode(out)
}
