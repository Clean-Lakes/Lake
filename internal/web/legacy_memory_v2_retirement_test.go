package web

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/ai"
)

func retiredMemoryV2Snapshot(t *testing.T, s *Store, project, session, turn string) ai.MemoryTurnSnapshot {
	t.Helper()
	settings := s.MemorySettings(project)
	snapshot := testMemorySnapshot(project, session, turn, integer(settings["epoch"]), integer(settings["revision"]))
	snapshot.SchemaVersion = 2
	snapshot = ai.SealMemorySnapshot(snapshot)
	if err := s.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestMemoryV2RetiredJobsPreserveUnknownAndAllowCurrentQueueAcrossRestart(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s != nil {
			s.Close()
		}
	})
	project := stringOf(s.CreateProject("Retired V2 audit")["id"])
	session := stringOf(s.CreateSession(project, "Source", nil)["id"])
	snapshots := []ai.MemoryTurnSnapshot{}
	usage := jsonText(ai.Usage{Input: 44, Output: 11, Total: 55, Known: true})
	for _, status := range []string{"queued", "retry_wait", "budget_wait", "running", "succeeded"} {
		snapshot := retiredMemoryV2Snapshot(t, s, project, session, status)
		snapshots = append(snapshots, snapshot)
		s.update(func() any {
			// Stopped historical fixture: these states predate V2 retirement.
			s.exec("UPDATE projectMemoryJobs SET status=?,attempts=3,usageJSON=?,leaseToken='old-lease',leaseOwner='old-owner',leaseUntilMs=? WHERE turnSequence=(SELECT sequence FROM projectMemoryTurns WHERE turnId=?)", status, usage, time.Now().Add(time.Hour).UnixMilli(), status)
			return nil
		})
	}
	s.update(func() any {
		// Historical format only; no committed V2 migration marker is created.
		s.exec(memoryV2Schema)
		s.exec(`INSERT INTO projectMemoryJobAttemptsV2(attemptId,jobId,projectId,startedAt,status,inputUsage,outputUsage,usageKnown,modelRefHash,reason)
 SELECT 'original-attempt',j.jobId,?,?,'dispatched',44,11,0,'original-model-hash','result_unknown'
 FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.turnId='running'`, project, time.Now().Add(-40*24*time.Hour).UTC().Format(time.RFC3339Nano))
		return nil
	})
	audit := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemoryJobAttemptsV2")) }).(string)
	terminal := s.read(func() any {
		return jsonText(s.row("SELECT j.* FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.turnId='succeeded'"))
	}).(string)
	current := testMemorySnapshot(project, session, "current-v1", 0, 0)
	if err := s.EnqueueMemoryTurn(current); err != nil {
		t.Fatal(err)
	}
	s.RecoverMemoryJobs()
	job := s.ClaimMemoryJob()
	if job == nil || job["turnId"] != current.TurnID {
		t.Fatal("retired queue blocked the current V1 source")
	}
	s.SettleMemoryJob(stringOf(job["jobId"]), stringOf(job["leaseToken"]), "no_op", "", ai.Usage{})
	for _, snapshot := range snapshots {
		row := s.read(func() any {
			return s.row("SELECT j.*,t.snapshotJSON,t.snapshotHash FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.turnId=?", snapshot.TurnID)
		}).(Object)
		if row["snapshotHash"] != snapshot.SnapshotHash || row["snapshotJSON"] != jsonText(snapshot) || integer(row["attempts"]) != 3 || row["usageJSON"] != usage {
			t.Fatal("retirement rewrote historical source/usage", snapshot.TurnID)
		}
		if snapshot.TurnID != "succeeded" && (row["status"] != "blocked" || row["lastErrorCode"] != retiredMemoryV2Code || row["leaseToken"] != "") {
			t.Fatal("retired source remains dispatchable", snapshot.TurnID)
		}
	}
	// Manual retry cannot reset original attempts, charged usage or source hash.
	oldJob := s.read(func() any {
		return s.row("SELECT j.jobId FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.turnId='running'")
	}).(Object)
	expectPanic(t, 410, func() {
		s.RetryMemoryJob(project, stringOf(oldJob["jobId"]), integer(s.MemorySettings(project)["revision"]))
	})
	// A stale handoff can neither revive scheduling nor accept changed content.
	if err := s.EnqueueMemoryTurn(snapshots[0]); err != nil {
		t.Fatal(err)
	}
	changed := snapshots[0]
	changed.UserText = "different historical input"
	changed = ai.SealMemorySnapshot(changed)
	if err := s.EnqueueMemoryTurn(changed); err == nil {
		t.Fatal("changed historical snapshot accepted")
	}
	// The live V1 commit path must also reject a late V2 result.
	if _, err := s.CommitMemoryExtraction(Object{}, snapshots[0], nil, ai.Usage{}); err == nil || !strings.Contains(err.Error(), retiredMemoryV2Code) {
		t.Fatal("late V2 output accepted by V1", err)
	}
	// Even old, unfinished dispatches retain their original identity and charge.
	s.memoryV2 = true
	s.PruneMemoryArtifacts()
	s.memoryV2 = false
	if got := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemoryJobAttemptsV2")) }).(string); got != audit {
		t.Fatal("retirement/pruning changed an unknown dispatch")
	}
	if got := s.read(func() any {
		return jsonText(s.row("SELECT j.* FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.turnId='succeeded'"))
	}).(string); got != terminal {
		t.Fatal("retirement changed a terminal job")
	}
	dir := s.Dir
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	s.RecoverMemoryJobs()
	s.RecoverMemoryJobs()
	if s.ClaimMemoryJob() != nil {
		t.Fatal("restart reclaimed retired work")
	}
	if got := s.read(func() any { return jsonText(s.rows("SELECT * FROM projectMemoryJobAttemptsV2")) }).(string); got != audit {
		t.Fatal("restart changed unknown identity/usage")
	}
}

func TestMemoryV2RetiredWorkerMakesNoAuxiliaryRequestsAndForegroundContinues(t *testing.T) {
	b, h := fixture(t)
	session, ref := newSession(t, h)
	project := stringOf(b.Store.Session(session)["projectId"])
	// Pre-name the session so title generation is outside request accounting.
	b.Store.RenameSession(session, "Current foreground")
	apiTest(t, h, "PUT", "/api/projects/"+project+"/sre", Object{"enabled": false}, 200)
	// Keep new V1 extraction out of this retired-work dispatch fixture.
	apiTest(t, h, "PATCH", "/api/projects/"+project+"/memory-settings", Object{"useEnabled": false, "extractionEnabled": false, "expectedRevision": 0}, 200)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		emitModel(w, "Current foreground completed.", nil)
	}))
	defer provider.Close()
	b.Models.Save(&ai.Model{URL: provider.URL, Name: "retirement-loopback", Protocol: "openai", ContextWindow: 200000, MaxOutput: 1024})
	apiTest(t, h, "POST", "/api/sessions/"+session+"/ai/configure", Object{"asset_ref": ref}, 200)
	snapshot := retiredMemoryV2Snapshot(t, b.Store, project, session, "old-v2")
	b.processOneMemoryJob()
	b.Store.memoryV2 = true
	b.processOneMemoryJob()
	b.Store.memoryV2 = false
	if requests.Load() != 0 {
		t.Fatal("retired worker dispatched a provider request")
	}
	apiTest(t, h, "POST", "/api/sessions/"+session+"/messages", Object{"text": "Explain this briefly without operations."}, 202)
	waitAI(t, b, session, "completed")
	b.workers.Wait()
	foregroundRequests := requests.Load()
	if foregroundRequests == 0 {
		t.Fatal("foreground never reached the provider")
	}
	b.processOneMemoryJob()
	row := b.Store.read(func() any {
		return b.Store.row("SELECT j.status,j.lastErrorCode,t.snapshotHash FROM projectMemoryJobs j JOIN projectMemoryTurns t ON t.sequence=j.turnSequence WHERE t.turnId=?", snapshot.TurnID)
	}).(Object)
	if requests.Load() != foregroundRequests {
		t.Fatal("worker dispatched after foreground", requests.Load(), foregroundRequests)
	}
	if row["status"] != "blocked" || row["lastErrorCode"] != retiredMemoryV2Code || row["snapshotHash"] != snapshot.SnapshotHash {
		t.Fatal("new task changed retired V2 work", row)
	}
}

func TestMemoryV2RetiredWithdrawnNaturalSourceStaysRedacted(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	project := stringOf(s.CreateProject("Withdrawn source")["id"])
	session := stringOf(s.CreateSession(project, "Source", nil)["id"])
	snapshot := testMemorySnapshot(project, session, "withdrawn-v2", 0, 0)
	snapshot.SchemaVersion = 2
	// A historical consent snapshot never replaces the host's current opt-out.
	snapshot.Natural = &ai.NaturalMemoryConsent{ProjectEnabled: true}
	snapshot = ai.SealMemorySnapshot(snapshot)
	if err := s.EnqueueMemoryTurn(snapshot); err != nil {
		t.Fatal(err)
	}
	row := s.read(func() any {
		return s.row("SELECT t.snapshotJSON,t.snapshotHash,j.status FROM projectMemoryTurns t JOIN projectMemoryJobs j ON j.turnSequence=t.sequence WHERE t.turnId=?", snapshot.TurnID)
	}).(Object)
	coverage := s.read(func() any {
		return s.row("SELECT stage FROM naturalMemoryCoverage WHERE sourceKey=?", naturalCoverageKey(snapshot))
	}).(Object)
	if row["snapshotJSON"] != "" || row["snapshotHash"] != snapshot.SnapshotHash || row["status"] != "blocked" || coverage["stage"] != "withdrawn" {
		t.Fatal("retirement retained withdrawn natural content")
	}
	s.RecoverMemoryJobs()
	if s.ClaimMemoryJob() != nil {
		t.Fatal("redacted retired source became dispatchable")
	}
}

func TestMemoryV2RetiredExtractionAbsentFromProduction(t *testing.T) {
	forbidden := map[string]bool{
		"processMemoryV2Job": true, "ReserveMemoryDispatch": true, "settleMemoryDispatch": true,
		"memoryExtractionPromptV2": true, "MemoryExtractMutationV2": true, "parseMemoryExtractionV2": true,
		"CommitMemoryCandidates": true, "memoryExtractionInputV2": true, "validateMemoryExtractionSources": true,
		"ValidateMemoryClaimSupport": true, "ClassifyMemoryCandidate": true, "memoryExtractionSources": true,
		"memorySnapshotBindingsValid": true, "invalidateMemoryExtraction": true,
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			if id, ok := n.(*ast.Ident); ok && forbidden[id.Name] {
				t.Errorf("retired V2 execution dependency %s in %s", id.Name, path)
			}
			return true
		})
	}
}
