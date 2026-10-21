package web

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/strategy"
)

func TestStrategyCrashHelper(t *testing.T) {
	if os.Getenv("LAKE_STRATEGY_CRASH_HELPER") != "1" {
		t.Skip("subprocess fixture")
	}
	dir := os.Getenv("LAKE_STRATEGY_CRASH_DIR")
	ctx := StrategyContext{ProjectID: os.Getenv("LAKE_STRATEGY_CRASH_PROJECT")}
	point := os.Getenv("LAKE_STRATEGY_CRASH_POINT")
	s, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if point == "transaction" {
		s.update(func() any {
			s.exec("UPDATE strategyAssets SET title='uncommitted title'")
			s.strategyEvent("project:"+ctx.ProjectID, ctx.ProjectID, "orphan", 1, "uncommitted", Object{})
			os.Exit(23)
			return nil
		})
	}
	lease, err := s.ClaimStrategyJob(ctx)
	if err != nil || lease == nil {
		t.Fatal(lease, err)
	}
	id, token := stringOf(lease["id"]), stringOf(lease["leaseToken"])
	info := Object{"jobId": id, "token": token, "runtimeId": lease["runtimeId"]}
	if point == "intent" {
		runtimeID, err := s.PrepareStrategyDispatch(ctx, id, token)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, "synthetic-external-start"), []byte(runtimeID), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if point == "committed" {
		result, err := s.CompleteStrategyProposal(ctx, id, token, strategyInput("Durable candidate."))
		if err != nil {
			t.Fatal(err)
		}
		info["result"] = result
	}
	if err = os.WriteFile(filepath.Join(dir, "crash-result.json"), []byte(jsonText(info)), 0600); err != nil {
		t.Fatal(err)
	}
	// No deferred Close: simulate a process dying after a durable boundary.
	os.Exit(23)
}
func TestStrategyProcessCrashKeepsSingleCommitAndDispatchIdentity(t *testing.T) {
	for _, point := range []string{"transaction", "leased", "intent", "committed"} {
		t.Run(point, func(t *testing.T) {
			dir := t.TempDir()
			s, err := OpenStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			ctx := StrategyContext{ProjectID: stringOf(s.CreateProject("crash fixture")["id"])}
			scope := strategy.Scope{Kind: strategy.ProjectScope, ProjectID: ctx.ProjectID}
			enableStrategyFixture(t, s)
			queued := queueStrategyFixture(t, s, ctx, scope, "crash-job")
			s.Close()
			binary, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			child := exec.Command(binary, "-test.run=^TestStrategyCrashHelper$", "-test.timeout=30s")
			child.Env = append(os.Environ(), "LAKE_STRATEGY_CRASH_HELPER=1", "LAKE_STRATEGY_CRASH_DIR="+dir, "LAKE_STRATEGY_CRASH_PROJECT="+ctx.ProjectID, "LAKE_STRATEGY_CRASH_POINT="+point)
			out, err := child.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != 23 {
				t.Fatalf("fixture did not crash at boundary: %s (%v)", out, err)
			}
			s, err = OpenStore(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if point == "transaction" {
				if s.row("SELECT title FROM strategyAssets")["title"] == "uncommitted title" || s.row("SELECT seq FROM strategyEvents WHERE aggregateId='orphan'") != nil {
					t.Fatal("uncommitted state survived process death")
				}
			}
			lease, err := s.ClaimStrategyJob(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if point == "transaction" || point == "leased" {
				if lease == nil || lease["id"] != queued.JobID || lease["dispatchState"] != "none" {
					t.Fatal("safe lease not recovered", lease)
				}
				return
			}
			if lease != nil {
				t.Fatal("dispatched/finished job automatically replayed", lease)
			}
			raw, err := os.ReadFile(filepath.Join(dir, "crash-result.json"))
			if err != nil {
				t.Fatal(err)
			}
			info := object(parsed(string(raw)))
			if point == "intent" {
				job, err := s.GetStrategyJob(ctx, queued.JobID)
				if err != nil || job["dispatchState"] != "unknown" || job["runtimeId"] != info["runtimeId"] {
					t.Fatal("lost unknown identity", job, err)
				}
				lease, err = s.AcquireStrategyReconciliation(ctx, queued.JobID, stringOf(info["runtimeId"]))
				if err != nil {
					t.Fatal(err)
				}
				if _, err = s.PrepareStrategyDispatch(ctx, queued.JobID, stringOf(lease["leaseToken"])); err == nil {
					t.Fatal("reconciliation authorized a new dispatch")
				}
				if _, err = s.ObserveStrategyDispatch(ctx, queued.JobID, "wrong-runtime", "complete"); err == nil {
					t.Fatal("wrong identity accepted")
				}
				if _, err = s.ObserveStrategyDispatch(ctx, queued.JobID, stringOf(info["runtimeId"]), "complete"); err != nil {
					t.Fatal(err)
				}
				if _, err = s.CompleteStrategyProposal(ctx, queued.JobID, stringOf(lease["leaseToken"]), strategyInput("Durable candidate.")); err != nil {
					t.Fatal(err)
				}
				effect, _ := os.ReadFile(filepath.Join(dir, "synthetic-external-start"))
				if string(effect) != info["runtimeId"] {
					t.Fatal("synthetic start identity changed")
				}
			} else {
				result, err := s.CompleteStrategyProposal(ctx, queued.JobID, stringOf(info["token"]), strategyInput("Durable candidate."))
				if err != nil || result.AssetID != object(info["result"])["assetId"] {
					t.Fatal("result replay lost durable receipt", result, err)
				}
			}
			if integer(s.row("SELECT COUNT(*) AS n FROM strategyAssets")["n"]) != 2 {
				t.Fatal("duplicate candidate created")
			}
			if integer(s.row("SELECT COUNT(*) AS n FROM strategyEvents WHERE type='job_succeeded'")["n"]) != 1 {
				t.Fatal("completion outbox duplicated")
			}
		})
	}
}
