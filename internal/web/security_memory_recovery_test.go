package web

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/ai"
	"github.com/Clean-Lakes/Lake/internal/security"
)

func securityMemoryStoreImage(s *Store) string {
	return s.read(func() any {
		image := Object{}
		for _, table := range s.rows("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name GLOB 'natural*' OR name GLOB 'projectMem*' OR name='resourceMemoryGenerations') ORDER BY name") {
			name := stringOf(table["name"])
			image[name] = Object{"schema": table["sql"], "rows": s.rows("SELECT * FROM " + name)}
		}
		return jsonText(image)
	}).(string)
}

func memoryRecoveryOperatorAction(t *testing.T, b *Server, method, path, actionID string, body Object, expected int) Object {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(jsonText(body)))
	r.Host = fmt.Sprintf("localhost:%d", b.options.Port)
	r.Header.Set("Authorization", "Bearer synthetic-test-auth-token")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", actionID)
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	if w.Code != expected {
		t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
	}
	var result Object
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSecurityMemoryRecoveredStartupDoesNotInitializeOrRebuildMemory(t *testing.T) {
	for _, missingSchema := range []bool{false, true} {
		t.Run(fmt.Sprint(missingSchema), func(t *testing.T) {
			b, h := fixture(t)
			session, _ := newSession(t, h)
			project := stringOf(b.Store.Session(session)["projectId"])
			ctx := StrategyContext{ProjectID: project}
			if _, err := b.Store.SetNaturalMemorySettings(ctx, "real-opt-in-fixture", 0, true); err != nil {
				t.Fatal(err)
			}
			snap, job := naturalSource(t, b.Store, ctx, session, "以后本项目的报告先列结论。")
			if _, err := b.Store.CommitMemoryExtraction(job, snap, nil, ai.Usage{}, naturalResult(snap.UserText, "report-order", false, 0)); err != nil {
				t.Fatal(err)
			}
			notices := objects(b.Store.Snapshot(session)["naturalMemoryNotices"])
			if len(notices) != 1 {
				t.Fatal("notice fixture missing")
			}
			memory := b.Store.CommitProjectMemory(project, MemoryMutation{Key: "known-sensitive-fact", Type: "project", Description: "synthetic fixture", Body: "private current fact", Verification: "user-stated", SourceKind: "manual-ui"})
			settingsBefore := b.Store.MemorySettings(project)
			if err := b.Store.EnqueueMemoryTurn(testMemorySnapshot(project, session, "preserved-running-job", integer(settingsBefore["epoch"]), integer(settingsBefore["revision"]))); err != nil {
				t.Fatal(err)
			}
			if missingSchema {
				if _, err := b.Store.db.Exec("PRAGMA foreign_keys=OFF"); err != nil {
					t.Fatal(err)
				}
			}
			b.Store.update(func() any {
				b.Store.exec("UPDATE projectMemoryJobs SET status='running',leaseToken='preserved-lease' WHERE status='queued'")
				if missingSchema {
					for _, table := range b.Store.rows("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB 'natural*' OR name GLOB 'projectMem*' OR name='resourceMemoryGenerations')") {
						b.Store.exec("DROP TABLE " + stringOf(table["name"]))
					}
				}
				return nil
			})
			if missingSchema {
				if _, err := b.Store.db.Exec("PRAGMA foreign_keys=ON"); err != nil {
					t.Fatal(err)
				}
			}
			before := securityMemoryStoreImage(b.Store)
			path := filepath.Join(memoryProjectionPath(b.Store.Dir, project), "MEMORY.md")
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("private-current-projection-do-not-rebuild"), 0600); err != nil {
				t.Fatal(err)
			}
			home := b.options.Home
			b.Close()
			control, err := ai.ReadSecurityControl(home)
			if err != nil {
				t.Fatal(err)
			}
			// This fixture tests Memory startup isolation, not public activation.
			control.RecoveryID = strings.Repeat("b", 64)
			encoded, _ := json.Marshal(control)
			if err = os.WriteFile(filepath.Join(home, "security", "control.json"), encoded, 0600); err != nil {
				t.Fatal(err)
			}
			reopened, err := New(context.Background(), Options{Home: home, Token: "synthetic-test-auth-token", DynamicPort: true, Output: io.Discard})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if !reopened.Store.skipMemoryInitialization {
				t.Fatal("recovered Home ran Memory initialization")
			}
			if settings := reopened.Store.MemorySettings(project); settings["useEnabled"] != false || settings["extractionEnabled"] != false {
				t.Fatal("old settings became runtime consent")
			}
			if consent := reopened.Store.NaturalConsent(project); consent.GlobalEnabled || consent.ProjectEnabled {
				t.Fatal("old natural consent was restored")
			}
			view := memoryRecoveryOperatorAction(t, reopened, "GET", "/api/sessions/"+session+"/snapshot", "", nil, 200)
			if stringOf(object(view["session"])["id"]) != session || len(objects(view["naturalMemoryNotices"])) != 0 {
				t.Fatal("non-Memory conversation unavailable or old Memory references disclosed")
			}
			memoryRecoveryOperatorAction(t, reopened, "GET", "/api/projects/"+project+"/memory-settings", "", nil, 200)
			memoryRecoveryOperatorAction(t, reopened, "GET", "/api/projects/"+project+"/natural-memory/settings", "", nil, 200)
			if _, _, err = reopened.prepareHTTPServer(); err != nil {
				t.Fatal(err)
			}
			if after := securityMemoryStoreImage(reopened.Store); after != before {
				t.Fatal("Memory schema, jobs or original consent changed before owner qualification")
			}
			if data, err := os.ReadFile(path); err != nil || string(data) != "private-current-projection-do-not-rebuild" {
				t.Fatal("recovery rebuilt Memory Markdown from an older projection", err)
			}
			if !missingSchema {
				if _, err := reopened.Engine.PutSecurityProjectPolicy(context.Background(), ai.SecurityPolicyAction{ActorID: "local-user", ActionID: "deny-memory-fixture", ProjectID: project}, security.ProjectPolicy{ProjectID: project, SchemaVersion: 1, Mode: "restricted", Rules: []security.Rule{{Capability: "memory.read", Effect: security.EffectDeny}, {Capability: "memory.write", Effect: security.EffectDeny}}}); err != nil {
					t.Fatal(err)
				}
				memoryRecoveryOperatorAction(t, reopened, "DELETE", "/api/projects/"+project+"/memory/known-sensitive-fact", "forget-known-project-fact", Object{"expectedRevision": memory["revision"]}, 200)
				current := reopened.Store.read(func() any {
					return reopened.Store.row("SELECT epoch,revision FROM projectMemorySettings WHERE projectId=?", project)
				}).(Object)
				if integer(current["epoch"]) <= integer(settingsBefore["epoch"]) || integer(current["revision"]) <= integer(settingsBefore["revision"]) {
					t.Fatal("recovery forget reset the current privacy floor")
				}
				memoryRecoveryOperatorAction(t, reopened, "POST", "/api/projects/"+project+"/natural-memory/formed-preferences/"+stringOf(notices[0]["entryId"])+"/forget", "forget-known-natural-fact", Object{"expectedRevision": notices[0]["revision"]}, 200)
				if data, err := os.ReadFile(path); err != nil || string(data) != "private-current-projection-do-not-rebuild" {
					t.Fatal("explicit tombstone rebuilt other unqualified Memory projections", err)
				}
			}
		})
	}
}

func TestSecurityMemoryRecoveryBlocksExistingReadAndWorkerBoundaries(t *testing.T) {
	b, handler := fixture(t)
	session, _ := newSession(t, handler)
	project := stringOf(b.Store.Session(session)["projectId"])
	control, err := ai.ReadSecurityControl(b.options.Home)
	if err != nil {
		t.Fatal(err)
	}
	control.RecoveryID = strings.Repeat("a", 64)
	data, _ := json.Marshal(control)
	if err = os.WriteFile(filepath.Join(b.options.Home, "security", "control.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/projects/" + project + "/memory", "/api/projects/" + project + "/natural-memory/entries", "/api/natural-memory/entries"} {
		response := apiTest(t, handler, "GET", path, nil, 409)
		if !strings.Contains(stringOf(response["error"]), "Memory") {
			t.Fatal("Memory guard did not explain independent qualification", path)
		}
	}
	if _, err := b.projectMemoryBridge(context.Background(), session, "project_memory_index", Object{}); !errors.Is(err, ai.ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("bridge read accepted restored consent", err)
	}
	if _, err := b.naturalRecallProvider(context.Background(), session, ai.NaturalRecallQuery{}); !errors.Is(err, ai.ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("recall provider accepted restored consent", err)
	}
	if err := b.reconcileMemoryOutboxForSession(session); !errors.Is(err, ai.ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("restored outbox was ingested", err)
	}
	before := b.Store.read(func() any { return jsonText(b.Store.rows("SELECT * FROM projectMemoryJobs ORDER BY jobId")) })
	b.processOneMemoryJob()
	after := b.Store.read(func() any { return jsonText(b.Store.rows("SELECT * FROM projectMemoryJobs ORDER BY jobId")) })
	if before != after {
		t.Fatal("unqualified worker mutated Memory jobs")
	}
}
