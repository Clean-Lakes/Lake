package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/credential"
)

func TestMCPCredentialLoginUsesVaultWithoutEcho(t *testing.T) {
	root := t.TempDir()
	var out bytes.Buffer
	if err := settingsCommand(root, strings.NewReader(`{"action":"mcp_save","server":{"name":"remote","transport":"http","url":"https://example.com/mcp","enabled":true}}`), &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	secret := "Bearer test-secret-value"
	if err := mcpCredentialCommand([]string{"login", "--name", "remote", "--header", "Authorization"}, root, strings.NewReader(secret+"\n"), &out, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), secret) {
		t.Fatal("credential echoed")
	}
	data, err := (credential.FileVault{Root: root}).LoadMCPSecrets("remote")
	if err != nil {
		t.Fatal(err)
	}
	var saved mcpSecrets
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Headers["Authorization"] != secret {
		t.Fatal("header not saved")
	}
	settings, err := readLakeSettings(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.MCP) != 1 || settings.MCP[0].Headers != nil {
		t.Fatal("credential entered settings JSON")
	}
	out.Reset()
	if err := settingsCommand(root, strings.NewReader(`{"action":"get"}`), &out); err != nil { t.Fatal(err) }
	if strings.Contains(out.String(), secret) || strings.Contains(out.String(), "secret_ref") || strings.Contains(out.String(), "Authorization") {
		t.Fatal("credential information entered settings response")
	}
}

func TestMCPCredentialLoginRejectsWrongTransport(t *testing.T) {
	root := t.TempDir()
	var out bytes.Buffer
	if err := settingsCommand(root, strings.NewReader(`{"action":"mcp_save","server":{"name":"local","transport":"stdio","command":"server","enabled":true}}`), &out); err != nil {
		t.Fatal(err)
	}
	if err := mcpCredentialCommand([]string{"login", "--name", "local", "--header", "Authorization"}, root, strings.NewReader("secret\n"), &out, &out); err == nil {
		t.Fatal("HTTP header accepted for stdio")
	}
}
