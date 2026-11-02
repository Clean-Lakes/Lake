package ai

import (
	"bufio"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	kube "github.com/Clean-Lakes/Lake/internal/kubernetes"
	"github.com/Clean-Lakes/Lake/internal/security"
)

const securityProbeVersion int64 = 1
const securityProbeTimeout = 5 * time.Second
const securityProbeBytes = 100000

type securityReadProbe struct {
	command                          *security.FrozenCommand
	kind, metric, query, driver, url string
	argumentsDigest                  string
	asset                            Asset
	scope                            security.OperationScope
}

func securitySQLProbe(driver, metric string) (query, schema string, err error) {
	if metric != "health" && metric != "connections" && metric != "activity" {
		return "", "", errors.New("security: unregistered database metric")
	}
	switch driver {
	case "postgres", "postgresql":
		schema = "pg_catalog"
		switch metric {
		case "health":
			query = "SELECT 1 AS healthy"
		case "connections":
			query = "SELECT state, count(*) AS connections FROM pg_catalog.pg_stat_activity WHERE datname=current_database() GROUP BY state LIMIT 64"
		case "activity":
			query = "SELECT numbackends, xact_commit, xact_rollback, deadlocks, blks_read, blks_hit FROM pg_catalog.pg_stat_database WHERE datname=current_database() LIMIT 1"
		}
	case "mysql":
		schema = "performance_schema"
		query = "SELECT 1 AS healthy"
		if metric != "health" {
			query = "SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Threads_connected','Threads_running','Connections','Slow_queries','Aborted_connects','Questions') LIMIT 64"
		}
	default:
		return "", "", errors.New("security: no registered fixed diagnostic for driver")
	}
	return query, schema, nil
}

func fixedProbeArguments(a map[string]any, allowed ...string) error {
	for key := range a {
		if !slices.Contains(allowed, key) {
			return errors.New("security: fixed probe rejects argument " + key)
		}
	}
	return nil
}

// Preparation reads public saved metadata only. DNS is resolved only after an
// exact configured project host ceiling matched; no arbitrary model host lookup.
func (e *Engine) prepareSecurityReadProbe(ctx context.Context, c Config, op *security.PreparedOperation, a map[string]any) (*securityReadProbe, error) {
	p := &securityReadProbe{}
	var as Asset
	var err error
	if len(op.Resources) == 1 {
		as, err = asset(c, op.Resources[0].ID)
		if err != nil {
			return nil, err
		}
	}
	switch op.Tool {
	case "observe_host", "inspect_host":
		if op.Tool == "observe_host" && str(a["metric"]) != "processes" {
			return nil, nil
		}
		allowed := []string{"asset_ref", "metric"}
		if op.Tool == "inspect_host" {
			allowed = []string{"asset_ref", "runtime"}
		}
		if err = fixedProbeArguments(a, allowed...); err != nil {
			return nil, err
		}
		command, err := e.compileSecurityCommandProfile(ctx, c, op, a, as, "process_snapshot")
		if err != nil {
			if op.Tool == "inspect_host" {
				return nil, fmt.Errorf("security: fixed host inspection requires a current enabled OS diagnostic target; configure or revalidate this resource's Linux/macOS command target, without clearing unresolved operations: %w", err)
			}
			return nil, err
		}
		p.kind = "command"
		p.metric = "processes"
		p.command = command
		p.scope.ProbeID = "command.process_snapshot"
		p.scope.MaxDurationMS = 5000
	case "observe_data":
		if err = fixedProbeArguments(a, "asset_ref", "metric"); err != nil {
			return nil, err
		}
		p.metric = str(a["metric"])
		if p.metric != "health" && p.metric != "connections" && p.metric != "activity" {
			return nil, errors.New("security: unregistered data diagnostic")
		}
		switch as.Kind {
		case "database":
			p.query, p.scope.Schema, err = securitySQLProbe(str(as.Settings["driver"]), p.metric)
			if err != nil {
				return nil, nil
			}
			p.kind = "sql"
			p.driver = str(as.Settings["driver"])
			p.scope.DatabaseID = str(as.Settings["database"])
			if p.scope.DatabaseID == "" {
				return nil, errors.New("security: fixed database probe needs saved database")
			}
		case "redis":
			p.kind = "redis"
			p.scope.Schema = "redis_diagnostics"
			p.scope.DatabaseID = strconv.Itoa(num(as.Settings["db"], 0))
			if num(as.Settings["db"], 0) < 0 || num(as.Settings["db"], 0) > 65535 {
				return nil, errors.New("security: invalid saved Redis database")
			}
		default:
			return nil, nil
		}
		p.scope.MaxRows = 64
		p.scope.MaxDurationMS = 5000
		p.scope.ProbeID = p.kind + "." + p.metric
	case "query_kubernetes", "observe_cluster", "observe_cluster_logs":
		if as.Kind != "kubernetes" {
			return nil, nil
		}
		if err = fixedProbeArguments(a, "asset_ref", "metric", "namespace", "continue_token", "pod", "container", "since_minutes", "previous", "context", "kubeconfig"); err != nil {
			return nil, err
		}
		if context := str(a["context"]); context != "" && context != str(as.Settings["context"]) {
			return nil, errors.New("security: saved Kubernetes context required")
		}
		if config := str(a["kubeconfig"]); config != "" && config != "default" {
			return nil, errors.New("security: kubeconfig path override forbidden")
		}
		p.kind = "kubernetes"
		p.metric = str(a["metric"])
		if op.Tool == "observe_cluster_logs" {
			p.metric = "logs"
		}
		if !slices.Contains([]string{"identity", "nodes", "resources", "pods", "events", "namespaces", "deployments", "replicasets", "statefulsets", "daemonsets", "logs"}, p.metric) {
			return nil, errors.New("security: unregistered Kubernetes metric")
		}
		namespace := str(a["namespace"])
		if namespace == "" {
			namespace = str(as.Settings["namespace"])
		}
		if namespace == "" {
			if str(as.Settings["authMethod"]) == "kubeconfig" {
				return nil, nil
			}
			namespace = "default"
		}
		if err = kube.ValidateNamespace(namespace); err != nil {
			return nil, err
		}
		kind := p.metric
		verb := "list"
		if kind == "identity" {
			kind = "version"
			verb = "get"
		}
		if kind == "resources" {
			kind = "nodes"
		}
		if slices.Contains([]string{"identity", "nodes", "resources", "namespaces"}, p.metric) {
			namespace = "*"
		}
		p.scope.ClusterID = as.ID
		p.scope.Namespace = namespace
		p.scope.ResourceKind = kind
		p.scope.Verb = verb
		p.scope.MaxRows = 100
		p.scope.MaxDurationMS = 5000
		if p.metric == "logs" {
			if str(a["pod"]) == "" {
				return nil, errors.New("security: exact Pod required")
			}
			minutes := num(a["since_minutes"], 20)
			if minutes < 1 || minutes > 60 {
				return nil, errors.New("security: invalid log window")
			}
			p.scope.LogLines = 150
			p.scope.LogSeconds = int64(minutes * 60)
			p.scope.ResourceKind = "pods/log"
			p.scope.Verb = "get"
			if !slices.Contains(op.Capabilities, "cluster.logs") {
				op.Capabilities = append(op.Capabilities, "cluster.logs")
			}
		}
		if len(str(a["continue_token"])) > 8192 || strings.ContainsAny(str(a["continue_token"]), "\r\n\x00") {
			return nil, errors.New("security: continuation exceeds limit")
		}
		p.scope.ProbeID = "kubernetes." + p.metric
	case "web_fetch":
		if err = fixedProbeArguments(a, "url"); err != nil {
			return nil, err
		}
		u, err := securityFetchURL(str(a["url"]))
		if err != nil {
			return nil, err
		}
		port := securityURLPort(u)
		db, storeID, epoch, err := e.securityTaskDB()
		if err != nil {
			return nil, err
		}
		policy, err := loadSecurityPolicy(db, op.ProjectID, storeID, epoch)
		if err != nil {
			return nil, err
		}
		rule, ok := security.ResolveCapabilityRule(policy.Rules, "network.fetch", "")
		if !ok || rule.Effect == security.EffectDeny {
			return nil, errors.New("security: URL outside network ceiling")
		}
		allowed := false
		for _, target := range rule.Limits.NetworkTargets {
			if target.Scheme == u.Scheme && target.Host == u.Hostname() && target.Port == port {
				allowed = true
			}
		}
		if !allowed {
			return nil, errors.New("security: URL host not configured; no DNS lookup performed")
		}
		ips, err := securityResolveIPs(ctx, u.Hostname())
		if err != nil {
			return nil, err
		}
		p.kind = "network"
		p.url = u.String()
		p.scope.NetworkScheme = u.Scheme
		p.scope.NetworkHost = u.Hostname()
		p.scope.NetworkPort = port
		p.scope.ResolvedAddresses = ips
		p.scope.MaxDurationMS = 5000
		p.scope.ProbeID = "network.fetch"
	default:
		return nil, nil
	}
	p.asset = as
	p.scope.ProbeVersion = securityProbeVersion
	op.Scope = p.scope
	if p.kind != "command" {
		op.Proof = security.ProofStructured
	}
	return p, nil
}

func securityFetchURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.Scheme != "http" && u.Scheme != "https" || u.User != nil || u.Opaque != "" || len(raw) > 8192 || strings.ContainsAny(raw, "\\\x00\r\n") {
		return nil, errors.New("security: invalid exact fetch URL")
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return nil, errors.New("security: invalid port")
		}
	}
	u.Fragment = ""
	return u, nil
}
func securityURLPort(u *url.URL) int {
	if u.Port() != "" {
		p, _ := strconv.Atoi(u.Port())
		return p
	}
	if u.Scheme == "https" {
		return 443
	}
	return 80
}
func securityResolveIPs(ctx context.Context, host string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, securityProbeTimeout)
	defer cancel()
	if ip, err := netip.ParseAddr(host); err == nil {
		return []string{ip.Unmap().String()}, nil
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, errors.New("security: URL DNS lookup failed")
	}
	result := []string{}
	for _, ip := range ips {
		if ip.IsValid() {
			result = append(result, ip.Unmap().String())
		}
	}
	slices.Sort(result)
	result = slices.Compact(result)
	if len(result) == 0 || len(result) > 16 {
		return nil, errors.New("security: DNS address count outside bound")
	}
	return result, nil
}

func (e *Engine) executeSecurityReadProbe(ctx context.Context, c Config, name string, a map[string]any) (any, error) {
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if permit == nil || permit.prepared == nil || permit.prepared.read == nil || permit.operation.Tool != name {
		return nil, &ToolNotExecutedError{Err: errors.New("security: exact diagnostic permit required")}
	}
	p := permit.prepared.read
	expectedArguments := permit.operation.ArgumentsDigest
	if p.kind == "command" {
		expectedArguments = p.argumentsDigest
	}
	if hash(js(a)) != expectedArguments {
		return nil, &ToolNotExecutedError{Err: errors.New("security: frozen probe arguments changed")}
	}
	secrets := map[string]string{}
	if err := e.validateSecurityPermitAtIO(ctx, permit.operation.ProjectID, permit.operation.SessionID, func(view SecurityCatalogView) error {
		if p.kind == "network" || p.kind == "command" {
			return nil
		}
		var err error
		secrets, err = credentials(p.asset, c.CredentialDir)
		if err != nil {
			return err
		}
		again, err := e.currentSecurityCatalog(ctx, SecurityCatalogQuery{ProjectID: permit.operation.ProjectID, SessionID: permit.operation.SessionID, ResourceIDs: securityCatalogResources(permit.operation.Resources), TerminalID: permit.operation.TerminalID})
		if err != nil {
			return err
		}
		if securityCatalogMetadataDigest(again) != securityCatalogMetadataDigest(view) {
			return errors.New("security: credential metadata changed during frozen read")
		}
		return nil
	}); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	ctx, cancel := context.WithTimeout(ctx, securityProbeTimeout)
	defer cancel()
	var result any
	var err error
	switch p.kind {
	case "command":
		return e.executeFrozenCommand(ctx, c, a, *p.command)
	case "sql":
		result, err = executeSecuritySQLProbe(ctx, c, p, secrets)
	case "redis":
		result, err = executeSecurityRedisProbe(ctx, c, p, secrets)
	case "kubernetes":
		result, err = executeSecurityKubernetesProbe(ctx, c, p, a, secrets)
	case "network":
		return e.executeSecurityFetch(ctx, p, a)
	default:
		return nil, errors.New("security: unsupported fixed probe")
	}
	if err != nil {
		return nil, err
	}
	return scrubSecurityProbeResult(result, secrets), nil
}

func executeSecuritySQLProbe(ctx context.Context, c Config, p *securityReadProbe, secrets map[string]string) (any, error) {
	db, driver, err := databaseOpenWithCredentials(p.asset, true, "", secrets, true)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	defer db.Close()
	db.SetMaxIdleConns(0)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, errors.New("security: read-only diagnostic transaction failed")
	}
	defer tx.Rollback()
	if driver == "pgx" {
		for _, statement := range []string{"SET LOCAL statement_timeout = 5000", "SET LOCAL lock_timeout = 1000"} {
			if _, err = tx.ExecContext(ctx, statement); err != nil {
				return nil, errors.New("security: cannot enforce diagnostic deadline")
			}
		}
	}
	if driver == "mysql" {
		if _, err = tx.ExecContext(ctx, "SET SESSION MAX_EXECUTION_TIME=5000"); err != nil {
			return nil, &ToolNotExecutedError{Err: errors.New("security: cannot enforce MySQL diagnostic deadline")}
		}
	}
	rows, err := tx.QueryContext(ctx, p.query)
	if err != nil {
		return nil, errors.New("security: fixed diagnostic query failed")
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil || len(columns) > 16 {
		return nil, errors.New("security: diagnostic column schema invalid")
	}
	result := []map[string]any{}
	size := 0
	for rows.Next() {
		if len(result) >= 64 {
			return nil, errors.New("security: diagnostic row bound exceeded")
		}
		values := make([]any, len(columns))
		refs := make([]any, len(columns))
		for i := range values {
			refs[i] = &values[i]
		}
		if err = rows.Scan(refs...); err != nil {
			return nil, errors.New("security: diagnostic result invalid")
		}
		row := map[string]any{}
		for i, column := range columns {
			value := values[i]
			if b, ok := value.([]byte); ok {
				value = string(b)
			}
			row[column] = value
		}
		size += len(js(row))
		if size > securityProbeBytes {
			return nil, errors.New("security: diagnostic byte bound exceeded")
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		return nil, errors.New("security: diagnostic result incomplete")
	}
	return map[string]any{"metric": p.metric, "rows": result, "exitCode": 0, "bounded": true, "verifier_profile": p.scope.ProbeID}, nil
}

func executeSecurityRedisProbe(ctx context.Context, c Config, p *securityReadProbe, creds map[string]string) (any, error) {
	as := p.asset
	if !hostPattern.MatchString(str(as.Settings["host"])) {
		return nil, errors.New("security: exact saved Redis host required")
	}
	var err error
	dialer := net.Dialer{Timeout: securityProbeTimeout}
	address := net.JoinHostPort(str(as.Settings["host"]), strconv.Itoa(num(as.Settings["port"], 6379)))
	var connection net.Conn
	if as.Settings["tls"] == true {
		td := tls.Dialer{NetDialer: &dialer, Config: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: str(as.Settings["host"])}}
		connection, err = td.DialContext(ctx, "tcp", address)
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return nil, errors.New("security: Redis diagnostic connection failed")
	}
	defer connection.Close()
	deadline, _ := ctx.Deadline()
	connection.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	reader := bufio.NewReader(io.LimitReader(connection, securityProbeBytes+1))
	send := func(parts ...string) (any, error) {
		if err := respWrite(connection, parts); err != nil {
			return nil, errors.New("security: Redis diagnostic send failed")
		}
		return respRead(reader, 0)
	}
	if password := creds["password"]; password != "" {
		username := creds["username"]
		if username == "" {
			username = str(as.Settings["username"])
		}
		if username != "" {
			_, err = send("AUTH", username, password)
		} else {
			_, err = send("AUTH", password)
		}
		if err != nil {
			return nil, errors.New("security: Redis diagnostic authentication failed")
		}
	}
	if db := num(as.Settings["db"], 0); db != 0 {
		if _, err = send("SELECT", strconv.Itoa(db)); err != nil {
			return nil, errors.New("security: saved Redis database unavailable")
		}
	}
	var result any
	switch p.metric {
	case "health":
		result, err = send("PING")
	case "connections":
		result, err = send("INFO", "clients")
	case "activity":
		result, err = send("INFO", "stats")
	default:
		return nil, errors.New("security: unknown fixed Redis probe")
	}
	if err != nil {
		return nil, errors.New("security: Redis diagnostic incomplete")
	}
	return map[string]any{"metric": p.metric, "result": result, "exitCode": 0, "bounded": true, "verifier_profile": p.scope.ProbeID}, nil
}

func executeSecurityKubernetesProbe(ctx context.Context, c Config, p *securityReadProbe, a map[string]any, creds map[string]string) (any, error) {
	if str(p.asset.Settings["authMethod"]) == "kubeconfig" {
		resolved, err := kube.Resolve(creds["kubeconfig"], p.asset.Settings)
		if err != nil {
			return nil, &ToolNotExecutedError{Err: err}
		}
		metadata := resolved.Metadata()
		if str(metadata["endpoint"]) != str(p.asset.Settings["endpoint"]) || p.scope.Namespace != "*" && str(metadata["namespace"]) != p.scope.Namespace && str(a["namespace"]) == "" {
			return nil, errors.New("security: resolved Kubernetes identity differs from frozen source")
		}
	}
	client, err := kube.New(p.asset.Settings, creds)
	if err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	defer client.Close()
	namespace := p.scope.Namespace
	if namespace == "*" {
		namespace = ""
	}
	return client.Query(ctx, kube.Query{Metric: p.metric, Namespace: namespace, Continue: str(a["continue_token"]), Pod: str(a["pod"]), Container: str(a["container"]), SinceMinutes: int(p.scope.LogSeconds / 60), Previous: a["previous"] == true})
}

func (e *Engine) executeSecurityFetch(ctx context.Context, p *securityReadProbe, a map[string]any) (any, error) {
	u, err := securityFetchURL(str(a["url"]))
	if err != nil || u.String() != p.url {
		return nil, &ToolNotExecutedError{Err: errors.New("security: frozen URL changed")}
	}
	current, err := securityResolveIPs(ctx, u.Hostname())
	if err != nil || !slices.Equal(current, p.scope.ResolvedAddresses) {
		return nil, &ToolNotExecutedError{Err: errors.New("security: DNS identity changed before HTTP handoff")}
	}
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	if err = e.ValidateSecurityPermitAtIO(ctx, permit.operation.ProjectID, permit.operation.SessionID); err != nil {
		return nil, &ToolNotExecutedError{Err: err}
	}
	transport := &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: u.Hostname()}, DisableKeepAlives: true, MaxResponseHeaderBytes: 16 << 10, ResponseHeaderTimeout: securityProbeTimeout}
	defer transport.CloseIdleConnections()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != net.JoinHostPort(u.Hostname(), strconv.Itoa(p.scope.NetworkPort)) {
			return nil, errors.New("security: HTTP attempted foreign origin")
		}
		var last error
		for _, ip := range p.scope.ResolvedAddresses {
			conn, err := (&net.Dialer{Timeout: securityProbeTimeout}).DialContext(ctx, network, net.JoinHostPort(ip, strconv.Itoa(p.scope.NetworkPort)))
			if err == nil {
				return conn, nil
			}
			last = err
		}
		return nil, last
	}
	client := &http.Client{Transport: transport, Timeout: securityProbeTimeout, CheckRedirect: func(request *http.Request, previous []*http.Request) error {
		if len(previous) > 3 || request.URL.Scheme != u.Scheme || request.URL.Hostname() != u.Hostname() || securityURLPort(request.URL) != p.scope.NetworkPort || request.URL.User != nil {
			return errors.New("security: redirect outside frozen origin")
		}
		return e.ValidateSecurityPermitAtIO(ctx, permit.operation.ProjectID, permit.operation.SessionID)
	}}
	request, err := http.NewRequestWithContext(ctx, "GET", p.url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "Lake/0.1")
	response, err := client.Do(request)
	if err != nil {
		return nil, errors.New("security: bounded HTTP request failed")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, securityProbeBytes+1))
	if err != nil {
		return nil, errors.New("security: HTTP response incomplete")
	}
	return map[string]any{"url": p.url, "status": response.StatusCode, "content": string(body[:min(len(body), securityProbeBytes)]), "truncated": len(body) > securityProbeBytes, "bounded": true}, nil
}

// Eligibility describes actual implemented adapters, never a model-selected
// label or a digest of arbitrary SQL, MCP, raw Shell or script contents.
func SecurityReadVerifierProfile(op security.PreparedOperation) (string, bool) {
	if op.Proof == security.ProofCommandProfile && (op.Tool == "observe_host" || op.Tool == "inspect_host") && op.CommandProfileID == "process_snapshot" && op.CommandProfileVersion == security.CommandProfileVersion && op.Scope.ProbeID == "command.process_snapshot" && op.Scope.ProbeVersion == securityProbeVersion {
		return op.Scope.ProbeID, true
	}
	if op.Proof != security.ProofStructured || op.Scope.ProbeVersion != securityProbeVersion {
		return "", false
	}
	id := op.Scope.ProbeID
	switch op.Tool {
	case "observe_data":
		if slices.Contains([]string{"sql.health", "sql.connections", "sql.activity", "redis.health", "redis.connections", "redis.activity"}, id) {
			return id, true
		}
	case "query_kubernetes", "observe_cluster", "observe_cluster_logs":
		if strings.HasPrefix(id, "kubernetes.") && slices.Contains([]string{"identity", "nodes", "resources", "pods", "events", "namespaces", "deployments", "replicasets", "statefulsets", "daemonsets", "logs"}, strings.TrimPrefix(id, "kubernetes.")) {
			return id, true
		}
	case "web_fetch":
		if id == "network.fetch" {
			return id, true
		}
	}
	return "", false
}

func scrubSecurityProbeResult(value any, secrets map[string]string) any {
	raw := js(value)
	for _, secret := range secrets {
		if secret != "" {
			encoded, _ := json.Marshal(secret)
			raw = strings.ReplaceAll(raw, string(encoded[1:len(encoded)-1]), "[REDACTED]")
		}
	}
	var clean any
	if json.Unmarshal([]byte(raw), &clean) != nil {
		return map[string]any{"redacted": true}
	}
	return clean
}

// Bound the entire diagnostic wire stream as well as projected rows. PG's
// frontend separately rejects oversized declared protocol message lengths.
type securityReadBoundConn struct {
	net.Conn
	mu        sync.Mutex
	remaining int64
}

func (c *securityReadBoundConn) Read(buffer []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.remaining <= 0 {
		return 0, errors.New("security: diagnostic wire byte limit exceeded")
	}
	if int64(len(buffer)) > c.remaining {
		buffer = buffer[:c.remaining]
	}
	n, err := c.Conn.Read(buffer)
	c.remaining -= int64(n)
	return n, err
}
func securityBoundedSQLDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" && network != "tcp6" {
		return nil, errors.New("security: fixed database needs explicit TCP endpoint")
	}
	connection, err := (&net.Dialer{Timeout: securityProbeTimeout}).DialContext(ctx, network, address)
	if err != nil {
		return nil, err
	}
	return &securityReadBoundConn{Conn: connection, remaining: 256 << 10}, nil
}
