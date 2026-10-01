/*
 * Copyright 2026 CloudWeGo Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/store"
)

func TestCLIDataLayerFlow(t *testing.T) {
	root := filepath.Join(t.TempDir(), "lake-home")
	call := func(args ...string) string {
		t.Helper()
		var out, errOut bytes.Buffer
		if err := run(context.Background(), args, root, &out, &errOut); err != nil {
			t.Fatalf("lake %s: %v; stderr=%s", strings.Join(args, " "), err, errOut.String())
		}
		return out.String()
	}

	var lake map[string]any
	if err := json.Unmarshal([]byte(call("add", "订单", "--desc", "order system", "--json")), &lake); err != nil {
		t.Fatal(err)
	}
	if lake["name"] != "订单" || lake["description"] != "order system" {
		t.Fatalf("created lake = %+v", lake)
	}
	if !strings.Contains(call("ls"), "订单") {
		t.Fatal("lake list omitted created lake")
	}
	if !strings.Contains(call("use", "订单"), "当前湖") {
		t.Fatal("use did not select current lake")
	}

	var resource map[string]any
	created := call("res", "add", "prod-web-01", "--ssh", "ops@10.0.0.5:2222", "--env", "prod", "--tag", "zone=a", "--json")
	if err := json.Unmarshal([]byte(created), &resource); err != nil {
		t.Fatal(err)
	}
	ssh := resource["ssh"].(map[string]any)
	if resource["lake"] != "订单" || resource["name"] != "prod-web-01" || ssh["port"] != float64(2222) || resource["execute_authz"] != false {
		t.Fatalf("created resource = %+v", resource)
	}
	if !strings.Contains(call("res", "ls"), "prod-web-01") {
		t.Fatal("resource list omitted created host")
	}
	call("res", "authz", "订单/prod-web-01", "on")

	var listed []map[string]any
	if err := json.Unmarshal([]byte(call("res", "ls", "--json")), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0]["execute_authz"] != true {
		t.Fatalf("persisted resource = %+v", listed)
	}
	var journal []map[string]any
	if err := json.Unmarshal([]byte(call("journal", "--tail", "--json")), &journal); err != nil {
		t.Fatal(err)
	}
	if len(journal) != 4 || journal[0]["tool"] != "lake.res.authz" || journal[0]["target_path"] != "订单/prod-web-01" {
		t.Fatalf("journal = %+v", journal)
	}

	// Each CLI call reopens the database. A store reader must see the same state.
	s, err := store.Open(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	resolved, err := s.ResolveResource(context.Background(), "prod-web-01")
	if err != nil || !resolved.ExecuteAuthz {
		t.Fatalf("resolved after reopen = %+v, %v", resolved, err)
	}
}

func TestCLIConversationManagementAndAllLakeResources(t *testing.T) {
	root := t.TempDir()
	call := func(args ...string) string {
		t.Helper()
		var out, errOut bytes.Buffer
		if err := run(context.Background(), args, root, &out, &errOut); err != nil {
			t.Fatalf("lake %s: %v; stderr=%s", strings.Join(args, " "), err, errOut.String())
		}
		return out.String()
	}
	call("add", "测试湖")
	call("add", "生产湖")
	call("res", "add", "测试湖/web", "--ssh", "root@test.example:22")
	call("res", "add", "生产湖/db", "--ssh", "root@prod.example:22")
	var resources []map[string]any
	if err := json.Unmarshal([]byte(call("res", "ls", "--all", "--json")), &resources); err != nil {
		t.Fatal(err)
	}
	if len(resources) != 2 || resources[0]["lake"] == resources[1]["lake"] {
		t.Fatalf("all resources=%+v", resources)
	}
	var conversation map[string]any
	if err := json.Unmarshal([]byte(call("conversation", "create", "测试湖", "--json")), &conversation); err != nil {
		t.Fatal(err)
	}
	id := conversation["id"].(string)
	if conversation["lake"] != "测试湖" {
		t.Fatalf("conversation=%+v", conversation)
	}
	call("conversation", "rename", id, "巡检记录", "--json")
	if !strings.Contains(call("conversation", "show", id, "--json"), "巡检记录") {
		t.Fatal("renamed title missing")
	}
	call("conversation", "archive", id, "--json")
	if !strings.Contains(call("conversation", "archived", "--json"), id) {
		t.Fatal("archived conversation missing")
	}
	call("conversation", "restore", id, "--json")
	if !strings.Contains(call("conversation", "list", "--json"), id) {
		t.Fatal("restored conversation missing")
	}
}

func TestCLIRejectsInvalidChangesWithoutJournalEntry(t *testing.T) {
	root := t.TempDir()
	var out, errOut bytes.Buffer
	call := func(args ...string) error {
		out.Reset()
		errOut.Reset()
		return run(context.Background(), args, root, &out, &errOut)
	}
	if err := call("add", "订单"); err != nil {
		t.Fatal(err)
	}
	if err := call("add", "订单"); err == nil {
		t.Fatal("duplicate lake accepted")
	}
	if err := call("use", "订单"); err != nil {
		t.Fatal(err)
	}
	if err := call("res", "add", "bad", "--ssh", "ops@host:"); err == nil {
		t.Fatal("empty SSH port accepted")
	}
	if err := call("res", "add", "bad", "--ssh", "ops@host:22", "--tag", "invalid"); err == nil {
		t.Fatal("invalid tag accepted")
	}
	s, err := store.Open(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	lake, err := s.CurrentLake(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	resources, err := s.ListResources(context.Background(), lake.ID)
	if err != nil || len(resources) != 0 {
		t.Fatalf("unexpected resources = %+v, %v", resources, err)
	}
	journal, err := s.ListJournal(context.Background(), store.JournalFilter{})
	if err != nil || len(journal) != 2 {
		t.Fatalf("failed changes wrote journal = %+v, %v", journal, err)
	}
}

func TestBulkAuthorizationPersistsForLake(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	call := func(args ...string) string {
		t.Helper()
		var out, errOut bytes.Buffer
		if err := run(ctx, args, root, &out, &errOut); err != nil {
			t.Fatalf("lake %s: %v; stderr=%s", strings.Join(args, " "), err, errOut.String())
		}
		return out.String()
	}
	call("add", "测试湖")
	call("use", "测试湖")
	call("res", "add", "host-1", "--ssh", "ops@10.0.0.1")
	call("res", "add", "host-2", "--ssh", "ops@10.0.0.2")
	if !strings.Contains(call("res", "authz", "--all", "on"), "2 个资源") {
		t.Fatal("bulk authorization did not report both resources")
	}
	var resources []map[string]any
	if err := json.Unmarshal([]byte(call("res", "ls", "--json")), &resources); err != nil {
		t.Fatal(err)
	}
	for _, resource := range resources {
		if resource["execute_authz"] != true {
			t.Fatalf("authorization did not persist: %+v", resource)
		}
	}
	call("res", "authz", "--all", "off", "--lake", "测试湖")
	if err := json.Unmarshal([]byte(call("res", "ls", "--json")), &resources); err != nil {
		t.Fatal(err)
	}
	for _, resource := range resources {
		if resource["execute_authz"] != false {
			t.Fatalf("bulk revocation did not persist: %+v", resource)
		}
	}
}

func TestParseSSH(t *testing.T) {
	tests := []struct {
		input string
		host  string
		port  int
		valid bool
	}{
		{"ops@host", "host", 22, true},
		{"ops@host:2200", "host", 2200, true},
		{"ops@[::1]:2200", "::1", 2200, true},
		{"ops@::1", "::1", 22, true},
		{"ops@host:", "", 0, false},
		{"ops@host:99999", "", 0, false},
		{"host", "", 0, false},
	}
	for _, tc := range tests {
		ssh, err := parseSSH(tc.input)
		if (err == nil) != tc.valid {
			t.Fatalf("parseSSH(%q) = %+v, %v", tc.input, ssh, err)
		}
		if tc.valid && (ssh.Host != tc.host || ssh.Port != tc.port) {
			t.Fatalf("parseSSH(%q) = %+v", tc.input, ssh)
		}
	}
}

type memoryVault struct {
	items map[string][]byte
	next  int
}

func (v *memoryVault) Import(key []byte) (string, error) {
	v.next++
	ref := fmt.Sprintf("keychain:ssh/%032x", v.next)
	v.items[ref] = append([]byte(nil), key...)
	return ref, nil
}

func (v *memoryVault) Delete(ref string) error {
	delete(v.items, ref)
	return nil
}

func TestIdentityIsCopiedIntoCredentialVault(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	vault := &memoryVault{items: make(map[string][]byte)}
	originalVault := keyVault
	keyVault = vault
	t.Cleanup(func() { keyVault = originalVault })
	keyPath := filepath.Join(t.TempDir(), "id_rsa")
	keyContent := []byte("-----BEGIN OPENSSH PRIVATE KEY-----\ntest-content\n")
	if err := os.WriteFile(keyPath, keyContent, 0600); err != nil {
		t.Fatal(err)
	}
	call := func(args ...string) error {
		var out, errOut bytes.Buffer
		return run(ctx, args, root, &out, &errOut)
	}
	if err := call("add", "测试湖"); err != nil {
		t.Fatal(err)
	}
	if err := call("res", "add", "测试湖/36.151.150.63", "--ssh", "ops@36.151.150.63", "--identity", keyPath); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	resource, err := s.ResolveResource(ctx, "测试湖/36.151.150.63")
	if err != nil {
		t.Fatal(err)
	}
	attachments, err := s.ListAttachments(ctx, resource.ID)
	if err != nil || len(attachments) != 1 || !strings.HasPrefix(attachments[0].Ref, "keychain:") {
		t.Fatalf("identity reference = %+v, %v", attachments, err)
	}
	if !bytes.Equal(vault.items[attachments[0].Ref], keyContent) {
		t.Fatal("imported private key content differs")
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(vault.items[attachments[0].Ref], keyContent) {
		t.Fatal("deleting the source file affected the imported key")
	}
	if err := os.WriteFile(keyPath, keyContent, 0600); err != nil {
		t.Fatal(err)
	}
	oldRef := attachments[0].Ref
	if err := call("res", "identity", "测试湖/36.151.150.63", "--file", keyPath); err != nil {
		t.Fatal(err)
	}
	attachments, err = s.ListAttachments(ctx, resource.ID)
	if err != nil || len(attachments) != 1 || attachments[0].Ref == oldRef || len(vault.items) != 1 {
		t.Fatalf("identity rotation = %+v, items=%d, err=%v", attachments, len(vault.items), err)
	}
	if !bytes.Equal(vault.items[attachments[0].Ref], keyContent) {
		t.Fatal("rotated private key content differs")
	}
	if err := call("res", "add", "测试湖/36.151.150.63", "--ssh", "ops@36.151.150.63", "--identity", keyPath); err == nil {
		t.Fatal("duplicate host was accepted")
	}
	if len(vault.items) != 1 {
		t.Fatal("failed transaction left an orphaned keychain item")
	}
	if err := os.Chmod(keyPath, 0644); err != nil {
		t.Fatal(err)
	}
	if err := call("res", "add", "测试湖/unsafe", "--ssh", "ops@36.151.150.63", "--identity", keyPath); err == nil {
		t.Fatal("world-readable private key accepted")
	}
	if _, err := s.ResolveResource(ctx, "测试湖/unsafe"); err == nil {
		t.Fatal("rejected host was saved")
	}
}
