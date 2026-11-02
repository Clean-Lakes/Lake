package ai

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/agent/storage"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func superFixture(t *testing.T) (*Engine, SuperSourceBinding) {
	t.Helper()
	e, err := New(t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Shutdown)
	b := SuperSourceBinding{SourceID: "user-source", ProjectID: "project", Kind: "user", ActorRef: "local-owner", Revision: "rev1"}
	if err = e.RegisterSuperSource(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	return e, b
}

func TestSuperStoreBacksUpBeforeMigrationAndRejectsFutureReader(t *testing.T) {
	e, _ := superFixture(t)
	backups, err := filepath.Glob(filepath.Join(e.runtimeDirectory(), "before-superagent-*.sqlite"))
	if err != nil || len(backups) != 1 {
		t.Fatal(backups, err)
	}
	info, err := os.Stat(backups[0])
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("backup is not private", err)
	}
	prior, err := storage.OpenChecked(backups[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	if prior.DB.Migrator().HasTable(&superSchemaRow{}) {
		t.Fatal("backup was made after migration")
	}
	if err = prior.SQL.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&superSchemaRow{}).Where("id = ?", 1).Update("version", superSchemaVersion+1).Error; err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(e.runtimeDirectory(), "sessions.sqlite")
	e.Shutdown()
	next, err := storage.OpenChecked(path, nil)
	if err == nil {
		next.SQL.Close()
		t.Fatal("future schema reached SDK AutoMigrate")
	}
}

func TestSuperEventConcurrentDuplicateIsImmutable(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	in := SuperEventInput{SourceEventID: "message-1", ThreadRef: "topic", Kind: "message", Payload: "Investigate orders", NextCursor: "cursor-1"}
	var created atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, fresh, err := e.ReceiveSuperEvent(ctx, b, in)
			if err != nil {
				t.Error(err)
			}
			if fresh {
				created.Add(1)
			}
		}()
	}
	wg.Wait()
	if created.Load() != 1 {
		t.Fatal("duplicate admission", created.Load())
	}
	rows, err := e.PendingSuperEvents(ctx, b, 16)
	if err != nil || len(rows) != 1 || rows[0].Payload != in.Payload {
		t.Fatal(rows, err)
	}
	in.Payload = "Replace immutable payload"
	if _, _, err = e.ReceiveSuperEvent(ctx, b, in); err == nil {
		t.Fatal("changed event accepted")
	}
	in.Payload = "Investigate orders"
	in.NextCursor = "stale-cursor"
	if _, fresh, err := e.ReceiveSuperEvent(ctx, b, in); err != nil || fresh {
		t.Fatal(fresh, err)
	}
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	var source superSourceRow
	if err = db.First(&source, "id = ?", b.SourceID).Error; err != nil || source.Cursor != "cursor-1" {
		t.Fatal(source.Cursor, err)
	}
}

func TestSuperEventRejectsForeignBindingAndCredentials(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	in := SuperEventInput{SourceEventID: "m", Kind: "message", Payload: "ordinary"}
	for _, field := range []string{"project", "actor", "revision", "source"} {
		bad := b
		switch field {
		case "project":
			bad.ProjectID = "other"
		case "actor":
			bad.ActorRef = "other"
		case "revision":
			bad.Revision = "old"
		case "source":
			bad.SourceID = "unregistered"
		}
		if _, _, err := e.ReceiveSuperEvent(ctx, bad, in); err == nil {
			t.Fatal("foreign binding accepted", field)
		}
	}
	e.SetSecurityHostSecrets([]string{"fixture-secret-not-a-live-credential"})
	in.Payload = "fixture-secret-not-a-live-credential"
	if _, _, err := e.ReceiveSuperEvent(ctx, b, in); err == nil {
		t.Fatal("host secret persisted")
	}
	in.Payload = "-----BEGIN OPENSSH PRIVATE KEY----- fixture"
	if _, _, err := e.ReceiveSuperEvent(ctx, b, in); err == nil {
		t.Fatal("private key persisted")
	}
	rows, err := e.PendingSuperEvents(ctx, b, 16)
	if err != nil || len(rows) != 0 {
		t.Fatal(rows, err)
	}
}

func TestSuperSchemaRejectsNewerVersionBeforeMigration(t *testing.T) {
	e, _ := superFixture(t)
	db, err := e.superStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&superSchemaRow{}).Where("id = ?", 1).Update("version", superSchemaVersion+1).Error; err != nil {
		t.Fatal(err)
	}
	if err = MigrateSuperagentStore(db); err == nil {
		t.Fatal("future schema accepted")
	}
	var row superSchemaRow
	if err = db.First(&row, "id = ?", 1).Error; err != nil || row.Version != superSchemaVersion+1 {
		t.Fatal(row, err)
	}
}

func TestSuperEventsSurviveRuntimeRestart(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	_, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "m", Kind: "message", Payload: "persisted"})
	if err != nil {
		t.Fatal(err)
	}
	dir := e.Dir
	e.Shutdown()
	next, err := New(dir, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(next.Shutdown)
	rows, err := next.PendingSuperEvents(ctx, b, 16)
	if err != nil || len(rows) != 1 || rows[0].Payload != "persisted" {
		t.Fatal(rows, err)
	}
}

func TestSuperEventWaitsForCommittedHostContext(t *testing.T) {
	e, b := superFixture(t)
	ctx := context.Background()
	event, _, err := e.ReceiveSuperEvent(ctx, b, SuperEventInput{SourceEventID: "staged", Kind: "message", Payload: "Inspect an attached file", HostStaged: true})
	if err != nil {
		t.Fatal(err)
	}
	if pending, err := e.PendingSuperEvents(ctx, b, 16); err != nil || len(pending) != 0 {
		t.Fatal("uncommitted context admitted", pending, err)
	}
	if _, err = e.ApplySuperDecision(ctx, b, SuperDecision{EventID: event.ID, PartKey: "file", Action: "create", Title: "File", RoleKey: "files", Quote: event.Payload, Reason: "too early"}); err == nil {
		t.Fatal("staged event routed")
	}
	digest := hash("committed host reference data")
	for i := 0; i < 2; i++ {
		if err = e.ConfirmSuperEventContext(ctx, b, event.ID, digest); err != nil {
			t.Fatal(err)
		}
	}
	if err = e.ConfirmSuperEventContext(ctx, b, event.ID, hash("changed reference data")); err == nil {
		t.Fatal("immutable host context changed")
	}
	if pending, err := e.PendingSuperEvents(ctx, b, 16); err != nil || len(pending) != 1 {
		t.Fatal(pending, err)
	}
}
