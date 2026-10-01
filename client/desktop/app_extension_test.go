package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtensionStatusOnlyExposesAllowedFields(t *testing.T) {
	dir := t.TempDir()
	cli := filepath.Join(dir, "lake")
	script := `#!/bin/sh
case "$1 $2" in
  "settings ") echo '{"mcp":[{"name":"demo","transport":"http","enabled":true,"headers":{"Authorization":"Bearer secret-header"},"secret_ref":"secret-ref"}],"api_key":"secret-model"}' ;;
  "plugin list") echo '[{"name":"demo","version":"1","state":"enabled","sha256":"digest","source":"secret-plugin"}]' ;;
  "skill list") echo '[{"name":"readme","scope":"user","sha256":"digest","body":"secret-skill"}]' ;;
  "hook status") echo '{"status":"disabled","sha256":"digest","hooks":2,"command":"secret-hook"}' ;;
  "code list") echo '[{"path":"PROJECT_PATH"}]' ;;
  *) exit 2 ;;
esac
`
	canonical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	script = strings.ReplaceAll(script, "PROJECT_PATH", canonical)
	if err := os.WriteFile(cli, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LAKE_CLI_PATH", cli)
	a := NewApp()
	a.ctx = context.Background()
	got, err := a.ExtensionStatus(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"secret-header", "secret-model", "secret-plugin", "secret-skill", "secret-hook", "secret-ref", "Authorization", "body"} {
		if strings.Contains(got, secret) {
			t.Errorf("extension status exposed %q", secret)
		}
	}
	var status struct {
		MCP []struct {
			Name string `json:"name"`
		} `json:"mcp"`
		Plugins []struct {
			Name string `json:"name"`
		} `json:"plugins"`
		Skills []struct {
			Name string `json:"name"`
		} `json:"skills"`
		Hook struct {
			Status string `json:"status"`
		} `json:"hook"`
	}
	if err := json.Unmarshal([]byte(got), &status); err != nil {
		t.Fatal(err)
	}
	if len(status.MCP) != 1 || status.MCP[0].Name != "demo" || len(status.Plugins) != 1 || len(status.Skills) != 1 || status.Hook.Status != "disabled" {
		t.Fatalf("incomplete status: %+v", status)
	}
	if _, err := a.ExtensionStatus(t.TempDir()); err == nil {
		t.Fatal("unregistered project accepted")
	}
}

func TestDesktopSettingsRejectsSecretPayload(t *testing.T) {
	a := NewApp()
	for _, payload := range []string{
		`{"action":"model_save","api_key":"secret"}`,
		`{"action":"mcp_save","server":{"headers":{"Authorization":"Bearer secret"}}}`,
		`{"action":"mcp_save","server":{"env":{"TOKEN":"secret"}}}`,
	} {
		if _, err := a.Settings(payload); err == nil {
			t.Errorf("accepted secret payload: %s", payload)
		}
	}
}
