package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDockerPostgresMySQLRedisIntegration(t *testing.T) {
	if os.Getenv("LAKE_AI_SERVICE_TESTS") != "1" {
		t.Skip("set LAKE_AI_SERVICE_TESTS=1 for isolated local Docker services")
	}
	endpointBytes, err := exec.Command("docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}").Output()
	if err != nil {
		t.Fatal("Docker unavailable")
	}
	endpoint := strings.TrimSpace(string(endpointBytes))
	if !strings.HasPrefix(endpoint, "unix://") {
		t.Skip("service fixtures require a local Unix Docker socket")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cli := func(t *testing.T, args ...string) string {
		t.Helper()
		cmd := exec.CommandContext(ctx, "docker", append([]string{"--host", endpoint}, args...)...)
		b, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated Docker command failed (%s)", args[0])
		}
		return strings.TrimSpace(string(b))
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	secrets := filepath.Join(dir, ".lake", "secrets")
	_ = os.MkdirAll(secrets, 0700)
	e, _ := New(filepath.Join(dir, "ai"), nil, nil)
	defer e.Shutdown()
	containers := []string{}
	defer func() {
		for _, name := range containers {
			_ = exec.Command("docker", "--host", endpoint, "rm", "-f", name).Run()
		}
	}()
	configs := []struct {
		driver, image, port string
		env                 []string
		user                string
	}{{"postgres", "postgres:16", "5432", []string{"-e", "POSTGRES_PASSWORD=fixture-only-password", "-e", "POSTGRES_DB=fixture"}, "postgres"}, {"mysql", "mysql:8.4", "3306", []string{"-e", "MYSQL_ROOT_PASSWORD=fixture-only-password", "-e", "MYSQL_DATABASE=fixture", "-e", "MYSQL_ROOT_HOST=%"}, "root"}}
	assets := []Asset{}
	for _, dbcase := range configs {
		t.Run(dbcase.driver, func(t *testing.T) {
			if exec.Command("docker", "--host", endpoint, "image", "inspect", dbcase.image).Run() != nil {
				t.Skip("fixture image must be cached before integration test")
			}
			name := "lake-ai-" + dbcase.driver + "-" + uid()[:8]
			containers = append(containers, name)
			run := append([]string{"run", "--pull=never", "--rm", "-d", "--name", name, "-p", "127.0.0.1::" + dbcase.port}, dbcase.env...)
			_ = cli(t, append(run, dbcase.image)...)
			portText := cli(t, "port", name, dbcase.port+"/tcp")
			var port int
			_, _ = fmt.Sscanf(portText, "127.0.0.1:%d", &port)
			if port == 0 {
				t.Fatal("fixture port missing")
			}
			ref := dbcase.driver + ".json"
			credential, _ := json.Marshal(map[string]string{"username": dbcase.user, "password": "fixture-only-password"})
			_ = os.WriteFile(filepath.Join(secrets, ref), credential, 0600)
			as := Asset{ID: dbcase.driver, Name: name, Kind: "database", Settings: map[string]any{"driver": dbcase.driver, "host": "127.0.0.1", "port": port, "database": "fixture", "credentialRef": ref, "sslmode": "disable", "tls": false}}
			assets = append(assets, as)
			conn, _, err := databaseOpen(as, false, "")
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			ready := false
			for end := time.Now().Add(45 * time.Second); time.Now().Before(end); {
				probe, cancel := context.WithTimeout(ctx, time.Second)
				err = conn.PingContext(probe)
				cancel()
				if err == nil {
					ready = true
					break
				}
				time.Sleep(250 * time.Millisecond)
			}
			if !ready {
				t.Fatal("database fixture did not become ready")
			}
			c := Config{Assets: []Asset{as}}
			_, err = e.database(ctx, c, "execute_sql", map[string]any{"asset_ref": as.ID, "sql": "CREATE TABLE sample(id INTEGER PRIMARY KEY, label VARCHAR(40) NOT NULL)"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = e.database(ctx, c, "execute_sql", map[string]any{"asset_ref": as.ID, "sql": "INSERT INTO sample VALUES(1,'observed')"})
			if err != nil {
				t.Fatal(err)
			}
			value, err := e.database(ctx, c, "execute_sql", map[string]any{"asset_ref": as.ID, "sql": "SELECT * FROM sample"})
			if err != nil || !strings.Contains(js(value), "observed") {
				t.Fatal(value, err)
			}
			schema := "public"
			if dbcase.driver == "mysql" {
				schema = "fixture"
			}
			value, err = e.database(ctx, c, "list_db_objects", map[string]any{"asset_ref": as.ID, "schema": schema, "query_type": "table"})
			if err != nil || !strings.Contains(js(value), "sample") {
				t.Fatal(value, err)
			}
			value, err = e.database(ctx, c, "db_table_ddl", map[string]any{"asset_ref": as.ID, "schema": schema, "table": "sample"})
			if err != nil || !strings.Contains(js(value), "PRIMARY KEY") {
				t.Fatal(value, err)
			}
		})
	}
	name := "lake-ai-redis-" + uid()[:8]
	containers = append(containers, name)
	_ = cli(t, "run", "--pull=never", "--rm", "-d", "--name", name, "-p", "127.0.0.1::6379", "redis:7.4-alpine")
	portText := cli(t, "port", name, "6379/tcp")
	var port int
	_, _ = fmt.Sscanf(portText, "127.0.0.1:%d", &port)
	redisAsset := Asset{ID: "redis", Kind: "redis", Settings: map[string]any{"host": "127.0.0.1", "port": port}}
	dockerAsset := Asset{ID: "docker", Kind: "docker", Settings: map[string]any{"endpoint": endpoint}}
	assets = append(assets, redisAsset, dockerAsset)
	c := Config{Runtime: "local", Assets: assets}
	var value any
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); {
		value, err = e.redis(ctx, c, map[string]any{"asset_ref": "redis", "command": "PING"})
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if value != "PONG" {
		t.Fatal(value, err)
	}
	if _, err = e.redis(ctx, c, map[string]any{"asset_ref": "redis", "command": "SET fixture observed"}); err != nil {
		t.Fatal(err)
	}
	value, err = e.redis(ctx, c, map[string]any{"asset_ref": "redis", "command": "GET fixture"})
	if err != nil || value != "observed" {
		t.Fatal(value, err)
	}
	value, err = e.docker(ctx, c, "list_docker_containers", map[string]any{"asset_ref": "docker", "pattern": name})
	if err != nil || !strings.Contains(js(value), name) {
		t.Fatal(value, err)
	}
	value, err = e.docker(ctx, c, "docker_container_logs", map[string]any{"asset_ref": "docker", "container_name": name})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	s.state.Config = c
	fileArgs := map[string]any{"runtime": "container", "asset_ref": "docker", "container_id": name, "path": "/tmp/ai-file", "content": "container-observed"}
	if _, err = e.file(ctx, s, c, "write", fileArgs); err != nil {
		t.Fatal(err)
	}
	value, err = e.file(ctx, s, c, "read", fileArgs)
	if err != nil || str(obj(value)["content"]) != "container-observed" {
		t.Fatal(value, err)
	}
	for _, action := range []string{"pause", "start", "restart"} { // start is a no-op on an already running fixture.
		if action == "start" {
			_ = cli(t, "unpause", name)
		}
		if _, err = e.docker(ctx, c, "docker_container_action", map[string]any{"asset_ref": "docker", "container_name": name, "action": action}); err != nil {
			t.Fatal(err)
		}
	}
}
