package ai

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"

	"gorm.io/gorm"
)

// Measure the durable registration increment independently from model, network
// and process latency. The fixed large pure-evaluator fixture is tested in the
// domain package; this is the original SQLite transaction/ledger comparison.
func TestSecurityDispatchRegistrationRelativeP95(t *testing.T) {
	db, now, template, owner, grant := permitFixture(t)
	if err := db.Model(&securityTaskGrantRow{}).Where("id = ?", grant.ID).Update("remaining_uses", 10000).Error; err != nil {
		t.Fatal(err)
	}
	measure := func(managed bool) time.Duration {
		latencies := make([]time.Duration, 128)
		for i := range latencies {
			op := template
			op.ID = fmt.Sprintf("performance-%t-%d", managed, i)
			op.CallID = op.ID
			start := time.Now()
			err := db.Transaction(func(tx *gorm.DB) error {
				if managed {
					if err := commitPermitOperation(tx, op, owner, now); err != nil {
						return err
					}
				} else if err := tx.Create(&nativeOperation{ID: op.ID, SessionID: op.SessionID, RootTurnID: op.RootTurnID, CallID: op.CallID, Tool: op.Tool, Status: "dispatched", Risk: "readonly", StartedAt: now}).Error; err != nil {
					return err
				}
				return tx.Create(&nativeEvidence{OperationID: op.ID, SessionID: op.SessionID, Status: "dispatched", At: now}).Error
			})
			latencies[i] = time.Since(start)
			if err != nil {
				t.Fatal(err)
			}
		}
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		return latencies[len(latencies)*95/100]
	}
	legacy, managed := measure(false), measure(true)
	t.Logf("original SQLite registration p95=%s; security registration p95=%s; increment=%s; 128 samples each; no model/network/process", legacy, managed, managed-legacy)
}

func TestSecurityActualFilePreparationAndRegistrationP95(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "metric.txt")
	if err = os.WriteFile(path, []byte("bounded fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	as := Asset{ID: "resource", Kind: "local"}
	e, c := fixedReadManagedFixture(t, as, security.Rule{Capability: "file.read", Effect: security.EffectAllow, Limits: security.ScopeLimits{FileRoots: []string{dir}}})
	c.Runtime = "local"
	policy, err := e.SecurityProjectPolicy(t.Context(), "project")
	if err != nil {
		t.Fatal(err)
	}
	policy.Rules = append(policy.Rules, security.Rule{Capability: "local.execute", Effect: security.EffectAllow})
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "performance-local", ProjectID: "project", ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	latencies := make([]time.Duration, 64)
	for i := range latencies {
		a := map[string]any{"asset_ref": assetAlias(as.ID), "path": path}
		call := Call{ID: fmt.Sprintf("prepared-performance-%d", i), Name: "read", Arguments: js(a)}
		start := time.Now()
		prepared, decision, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
		if err != nil || prepared == nil || decision.Effect != security.EffectAllow {
			t.Fatal(decision, err)
		}
		ctx := SecurityOperationContext(t.Context(), prepared)
		op, err := e.dispatchNativeOperation(ctx, s, prepared.executionConfig, call, "readonly", "resource", prepared.digest)
		latencies[i] = time.Since(start)
		if err != nil {
			t.Fatal(err)
		}
		// The benchmark deliberately performs no read I/O. Record that exact
		// known fact instead of inventing a successful observation.
		if err = e.finishNativeOperation(op, c, nil, &ToolNotExecutedError{Err: fmt.Errorf("performance registration only; adapter not called")}); err != nil {
			t.Fatal(err)
		}
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	t.Logf("actual file target resolution+FD metadata+canonical prepare+original registration p95=%s; 64 samples; no model/network/read execution", latencies[len(latencies)*95/100])
}
