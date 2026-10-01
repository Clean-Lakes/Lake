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

package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestStoreLifecycle(t *testing.T) {
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "lake-data")
	s, err := Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	first, err := s.CreateLake(ctx, "订单", "order system")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateLake(ctx, "公共基础设施", "shared")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateLake(ctx, first.Name, "duplicate"); err == nil {
		t.Fatal("duplicate lake name accepted")
	}
	if err := s.UseLake(ctx, first.ID); err != nil {
		t.Fatal(err)
	}

	web, err := s.CreateHost(ctx, ResourceInput{LakeID: first.ID, Name: "prod-web-01", Env: "prod", Tags: map[string]string{"zone": "a"}, SSH: SSHSpec{Host: "10.0.0.5", Port: 22, Username: "ops"}})
	if err != nil {
		t.Fatal(err)
	}
	if web.ExecuteAuthz {
		t.Fatal("new resource unexpectedly authorizes writes")
	}
	shared, err := s.CreateHost(ctx, ResourceInput{LakeID: second.ID, Name: "prod-web-01", SSH: SSHSpec{Host: "10.0.0.6", Port: 2222, Username: "ops"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateHost(ctx, ResourceInput{LakeID: first.ID, Name: web.Name, SSH: web.SSH}); err == nil {
		t.Fatal("duplicate resource name in one lake accepted")
	}
	resolved, err := s.ResolveResource(ctx, web.Name)
	if err != nil || resolved.ID != web.ID {
		t.Fatalf("resolve short path = %+v, %v", resolved, err)
	}
	resolved, err = s.ResolveResource(ctx, second.Name+"/"+shared.Name)
	if err != nil || resolved.ID != shared.ID {
		t.Fatalf("resolve full path = %+v, %v", resolved, err)
	}
	web, err = s.SetExecuteAuthz(ctx, web.ID, true)
	if err != nil || !web.ExecuteAuthz {
		t.Fatalf("enable authz = %+v, %v", web, err)
	}
	if _, err := s.AddLink(ctx, web.ID, shared.ID, "depends_on"); err != nil {
		t.Fatal(err)
	}
	if links, err := s.ListLinks(ctx, shared.ID); err != nil || len(links) != 1 || links[0].FromID != web.ID {
		t.Fatalf("cross-lake links = %+v, %v", links, err)
	}

	if _, err := s.SetCredentialRef(ctx, web.ID, "raw-private-key"); err == nil {
		t.Fatal("raw credential value accepted")
	}
	if _, err := s.SetCredentialRef(ctx, web.ID, "file:/tmp/id_rsa"); err == nil {
		t.Fatal("external private-key path accepted")
	}
	if _, err := s.SetCredentialRef(ctx, web.ID, "file:ssh/0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatalf("Lake-managed private-key reference rejected: %v", err)
	}
	credential, err := s.SetCredentialRef(ctx, web.ID, "keychain:lake/prod-web-01")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetCredentialRef(ctx, web.ID, "keychain:lake/rotated"); err != nil {
		t.Fatal(err)
	}
	attachments, err := s.ListAttachments(ctx, web.ID)
	if err != nil || len(attachments) != 1 || attachments[0].ID != credential.ID || attachments[0].Ref != "keychain:lake/rotated" {
		t.Fatalf("credential rotation = %+v, %v", attachments, err)
	}

	script, err := s.SaveScript(ctx, ScriptInput{ResourceID: web.ID, Name: "check-disk.sh", Language: "sh", Content: []byte("df -h\n")})
	if err != nil {
		t.Fatal(err)
	}
	_, content, err := s.ReadScript(ctx, script.ID)
	if err != nil || string(content) != "df -h\n" {
		t.Fatalf("read script = %q, %v", content, err)
	}
	if err := os.WriteFile(filepath.Join(root, script.Path), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.ReadScript(ctx, script.ID); err == nil {
		t.Fatal("changed script passed hash check")
	}

	run, err := s.StartPatrol(ctx, "check disk")
	if err != nil {
		t.Fatal(err)
	}
	actionID, err := NewActionID()
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range []string{"requested", "started", "unknown"} {
		if _, err := s.AppendJournal(ctx, JournalInput{RunID: run.RunID, ActionID: actionID, Actor: "agent", TargetPath: first.Name + "/" + web.Name, Tool: "lake_exec", Risk: "write", Event: event}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := s.ListJournal(ctx, JournalFilter{ActionID: actionID})
	if err != nil || len(entries) != 3 || entries[0].Event != "unknown" {
		t.Fatalf("journal = %+v, %v", entries, err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM journal WHERE action_id = ?`, actionID); err == nil {
		t.Fatal("journal DELETE accepted")
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE journal SET event = 'completed' WHERE action_id = ?`, actionID); err == nil {
		t.Fatal("journal UPDATE accepted")
	}
	run, err = s.FinishPatrol(ctx, run.RunID, "unknown")
	if err != nil || run.FinishedAt == nil {
		t.Fatalf("finish patrol = %+v, %v", run, err)
	}

	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	current, err := s.CurrentLake(ctx)
	if err != nil || current.ID != first.ID {
		t.Fatalf("persisted current lake = %+v, %v", current, err)
	}
	if entries, err := s.ListJournal(ctx, JournalFilter{RunID: run.RunID}); err != nil || len(entries) != 3 {
		t.Fatalf("persisted journal = %+v, %v", entries, err)
	}
	for _, path := range []string{root, filepath.Join(root, "scripts"), filepath.Join(root, "keys"), filepath.Join(root, "lake.db")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0077 != 0 {
			t.Fatalf("insecure permissions on %s: %v", path, info.Mode().Perm())
		}
	}
}

func TestStoreRejectsInvalidAndMissingReferences(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "lake?data"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Force a new SQLite connection for each call: FK enforcement must survive
	// connection replacement and the path's query character must be escaped.
	s.db.SetMaxIdleConns(0)
	if _, err := s.CurrentLake(ctx); !errors.Is(err, ErrNoCurrentLake) {
		t.Fatalf("current lake error = %v", err)
	}
	if _, err := s.CreateLake(ctx, "bad/name", ""); err == nil {
		t.Fatal("path separator in lake name accepted")
	}
	if _, err := s.CreateHost(ctx, ResourceInput{LakeID: "missing", Name: "host", SSH: SSHSpec{Host: "127.0.0.1", Port: 22, Username: "ops"}}); err == nil {
		t.Fatal("resource with nonexistent lake accepted")
	}
	if _, err := s.CreateHost(ctx, ResourceInput{LakeID: "missing", Name: "host", SSH: SSHSpec{Host: "user@host", Port: 22, Username: "ops"}}); err == nil {
		t.Fatal("invalid SSH host accepted")
	}
	if _, err := s.SetExecuteAuthz(ctx, "missing", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing authz error = %v", err)
	}
}

func TestMutationRollsBackDataAndJournalTogether(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	err = s.Mutate(ctx, func(m *Mutation) error {
		if _, err := m.CreateLake(ctx, "回滚测试", ""); err != nil {
			return err
		}
		_, err := m.AppendJournal(ctx, JournalInput{ActionID: "one", Actor: "cli", TargetPath: "回滚测试", Tool: "lake.add", Risk: "none", Event: "invalid"})
		return err
	})
	if err == nil {
		t.Fatal("invalid journal event accepted")
	}
	if _, err := s.GetLakeByName(ctx, "回滚测试"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("lake persisted after rollback: %v", err)
	}
	if err := s.Mutate(ctx, func(m *Mutation) error {
		if _, err := m.CreateLake(ctx, "已提交", ""); err != nil {
			return err
		}
		_, err := m.AppendJournal(ctx, JournalInput{ActionID: "two", Actor: "cli", TargetPath: "已提交", Tool: "lake.add", Risk: "none", Event: "completed"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetLakeByName(ctx, "已提交"); err != nil {
		t.Fatal(err)
	}
	if entries, err := s.ListJournal(ctx, JournalFilter{ActionID: "two"}); err != nil || len(entries) != 1 {
		t.Fatalf("committed journal = %+v, %v", entries, err)
	}
}
