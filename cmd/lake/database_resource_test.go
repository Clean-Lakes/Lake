package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cloudwego/eino/lake/agent"
	"github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/lake/credential"
	"github.com/cloudwego/eino/lake/store"
)

func TestDatabaseReadRejectsResourceOutsideFrozenLake(t *testing.T) {
	ctx := context.Background()
	s, err := store.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first, err := s.CreateLake(ctx, "第一湖", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateLake(ctx, "第二湖", "")
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := s.CreateDatabase(ctx, "mysql", store.ResourceInput{LakeID: second.ID, Name: "数据库二", DB: store.DatabaseSpec{Host: "127.0.0.1", Port: 3306, Username: "reader", TLSMode: "disable"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetExecuteAuthz(ctx, foreign.ID, true); err != nil {
		t.Fatal(err)
	}
	scope := agent.RunScope{LakeID: first.ID, ToolNames: []string{"lake_database_inspect"}}
	if _, err := runDatabaseInspect(ctx, s, databaseInspectInput{Resource: "第二湖/数据库二", Check: "version"}, scope); !errors.Is(err, policy.ErrDenied) {
		t.Fatalf("foreign database passed policy: %v", err)
	}
}

func TestDatabaseResourceImportAndInspectionGuard(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, err := store.Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.CreateLake(ctx, "测试湖", ""); err != nil {
		t.Fatal(err)
	}
	const password = "fixture-secret-do-not-print"
	for _, tc := range []struct {
		name, kind, wantKind string
		port                 int
	}{
		{"mysql", "mysql", "mysql", 3306},
		{"pg", "pg", "postgres", 5432},
		{"starrocks", "starsrock", "starrocks", 9030},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			err := addDatabaseResource(ctx, s, []string{"测试湖/" + tc.name, "--kind", tc.kind, "--host", "127.0.0.1", "--user", "reader", "--password-stdin", "--json"}, strings.NewReader(password), &out, &errOut)
			if err != nil {
				t.Fatalf("add database: %v %s", err, errOut.String())
			}
			var view map[string]any
			if err := json.Unmarshal(out.Bytes(), &view); err != nil {
				t.Fatal(err)
			}
			if view["kind"] != tc.wantKind || view["db"].(map[string]any)["port"] != float64(tc.port) {
				t.Fatalf("resource view: %+v", view)
			}
			if strings.Contains(out.String(), password) || strings.Contains(out.String(), "file:database/") {
				t.Fatal("resource output exposed database credential")
			}
			resource, err := s.ResolveResource(ctx, "测试湖/"+tc.name)
			if err != nil {
				t.Fatal(err)
			}
			attachments, err := s.ListAttachments(ctx, resource.ID)
			if err != nil || len(attachments) != 1 {
				t.Fatalf("database attachment: %+v %v", attachments, err)
			}
			secret, err := (credential.FileVault{Root: root}).LoadDatabasePassword(attachments[0].Ref)
			if err != nil || string(secret) != password {
				t.Fatalf("database password import failed: %v", err)
			}
			if _, err := runDatabaseInspect(ctx, s, databaseInspectInput{Resource: "测试湖/" + tc.name, Check: "version"}); err == nil || !strings.Contains(err.Error(), "授权") {
				t.Fatalf("unauthorized inspection: %v", err)
			}
			if _, err := runDatabaseInspect(ctx, s, databaseInspectInput{Resource: "测试湖/" + tc.name, Check: "DROP DATABASE demo"}); err == nil || !strings.Contains(err.Error(), "固定检查") {
				t.Fatalf("arbitrary SQL accepted: %v", err)
			}
		})
	}
	entries, err := filepath.Glob(filepath.Join(root, "secrets", "database", "*"))
	if err != nil || len(entries) != 3 {
		t.Fatalf("database secret files: %v %v", entries, err)
	}
	for _, path := range entries {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("secret permissions: %s %v", path, err)
		}
	}
}

func TestDatabaseInspectionSQLIsFixed(t *testing.T) {
	for _, kind := range []string{"mysql", "postgres", "starrocks"} {
		for _, check := range []string{"version", "databases", "tables"} {
			query, err := databaseInspectionSQL(kind, check)
			if err != nil || query == "" {
				t.Fatalf("%s %s: %q %v", kind, check, query, err)
			}
		}
	}
	if _, err := databaseInspectionSQL("mysql", "SELECT * FROM users"); err == nil {
		t.Fatal("arbitrary SQL must be rejected")
	}
}
