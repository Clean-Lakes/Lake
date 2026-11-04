package ai

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	"github.com/Clean-Lakes/Lake/internal/security"
)

func TestSecurityMemoryRecoveryDefaultDeniesEvenWhenResourceGateOpen(t *testing.T) {
	h := securityFixture(t)
	e := &Engine{SecurityRuntime: h}
	ctx := context.Background()
	if err := e.CheckSecurityMemoryEligibility(ctx, "project", SecurityMemoryRead); err != nil {
		t.Fatal("unrestored Home lost ordinary Memory consent semantics", err)
	}
	control := h.control
	control.RecoveryID, _ = securityID()
	// Only a test control fixture: no public activation proof or gate bypass is
	// introduced. Even an open resource gate cannot imply Memory consent.
	if err := writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), control); err != nil {
		t.Fatal(err)
	}
	for _, purpose := range []SecurityMemoryPurpose{SecurityMemoryRead, SecurityMemoryUse, SecurityMemoryCapture, SecurityMemoryIndex, SecurityMemoryProvider, SecurityMemoryBackground} {
		if err := e.CheckSecurityMemoryEligibility(ctx, "project", purpose); !errors.Is(err, ErrSecurityMemoryRecoveryUnqualified) {
			t.Fatal("restored Memory accepted resource authorization", purpose, err)
		}
	}
	if err := e.QualifySecurityMemoryRecovery(ctx, "project", "security-policy-confirmed"); !errors.Is(err, ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("Security policy action became independent Memory consent", err)
	}
	if err := e.CheckSecurityMemoryEligibility(ctx, "project", "invalid"); !errors.Is(err, ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("invalid purpose accepted", err)
	}
}

func TestSecurityMemoryConfiguredPolicyTightensIndependentOwnerConsent(t *testing.T) {
	h := securityFixture(t)
	e := &Engine{SecurityRuntime: h}
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE security_project_policies(project_id TEXT PRIMARY KEY,store_id TEXT,recovery_epoch TEXT,revision INTEGER,confirmed INTEGER,data TEXT)`); err != nil {
		t.Fatal(err)
	}
	setPolicy := func(read, write security.Effect) {
		t.Helper()
		policy := security.ProjectPolicy{ProjectID: "project", SchemaVersion: 1, Mode: "restricted", Revision: 1, Rules: []security.Rule{{Capability: "memory.read", Effect: read}, {Capability: "memory.write", Effect: write}}}
		data, _ := json.Marshal(policy)
		if _, err = db.Exec(`INSERT INTO security_project_policies VALUES(?,?,?,1,1,?) ON CONFLICT(project_id) DO UPDATE SET confirmed=1,data=excluded.data`, "project", h.control.StoreID, h.control.RecoveryEpoch, string(data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.CheckSecurityMemoryEligibility(ctx, "unconfigured", SecurityMemoryRead); err != nil {
		t.Fatal("unconfigured owner consent was replaced by project defaults", err)
	}
	setPolicy(security.EffectDeny, security.EffectAllow)
	if err := e.CheckSecurityMemoryEligibility(ctx, "project", SecurityMemoryRead); err == nil {
		t.Fatal("configured deny was bypassed by Memory consent")
	}
	if err := e.CheckSecurityMemoryEligibility(ctx, "project", SecurityMemoryCapture); err != nil {
		t.Fatal("project allow should leave owner consent as a separate check", err)
	}
	setPolicy(security.EffectAsk, security.EffectAsk)
	for _, purpose := range []SecurityMemoryPurpose{SecurityMemoryRead, SecurityMemoryUse, SecurityMemoryIndex, SecurityMemoryProvider, SecurityMemoryCapture, SecurityMemoryBackground} {
		if err := e.CheckSecurityMemoryEligibility(ctx, "project", purpose); err == nil {
			t.Fatal("ask without a read permit or project write allow executed", purpose)
		}
	}
	setPolicy(security.EffectAllow, security.EffectAllow)
	if err := e.CheckSecurityMemoryEligibility(ctx, "project", SecurityMemoryRead); err != nil {
		t.Fatal("current explicit allow rejected", err)
	}
	if _, err = db.Exec(`UPDATE security_project_policies SET confirmed=0 WHERE project_id='project'`); err != nil {
		t.Fatal(err)
	}
	if err := e.CheckSecurityMemoryEligibility(ctx, "project", SecurityMemoryRead); err == nil {
		t.Fatal("unconfirmed project policy granted Memory access")
	}
}

func TestSecurityMemoryRecoveryStopsCallbacksCaptureAndProvider(t *testing.T) {
	h := securityFixture(t)
	control := h.control
	control.RecoveryID, _ = securityID()
	if err := writeSecurityJSON(filepath.Join(h.Home, "security", "control.json"), control); err != nil {
		t.Fatal(err)
	}
	e := &Engine{SecurityRuntime: h}
	calls := 0
	e.NaturalMemory = func(context.Context, string, NaturalRecallQuery) ([]NaturalRecallItem, error) {
		calls++
		return nil, nil
	}
	e.Bridge = func(context.Context, string, string, map[string]any, bool) (any, error) {
		calls++
		return map[string]any{"index": "old private memory"}, nil
	}
	c := Config{MemoryProjectID: "project", MemoryEnabled: true, MemoryExtractionEnabled: true, NaturalMemory: &NaturalMemoryConsent{ProjectEnabled: true}}
	if _, err := e.naturalItems(context.Background(), "session", c, NaturalRecallQuery{}); !errors.Is(err, ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("recall reached old provider", err)
	}
	if got := e.requestMemoryContext(context.Background(), "session", c); got != "" {
		t.Fatal("restored index leaked into provider input")
	}
	s := &session{state: State{Config: c, View: View{Session: "session", RootTurnID: "turn"}}}
	e.beginMemoryCapture(s, c, TurnInput{UserText: "以后都这样记住", StrategyMessageID: "real-user"})
	e.collectMemorySnapshot(s, c, TurnInput{UserText: "请记住", StrategyMessageID: "real-user"})
	if s.state.MemoryCapture != nil || len(s.state.MemoryOutbox) != 0 {
		t.Fatal("restored consent captured a new source")
	}
	if _, _, err := e.ExtractMemory(WithSecurityMemoryProject(context.Background(), "project"), Model{}, []Message{{Role: "system", Content: "memory"}, {Role: "user", Content: "old source"}}); !errors.Is(err, ErrSecurityMemoryRecoveryUnqualified) {
		t.Fatal("restored background provider was not denied", err)
	}
	if calls != 0 {
		t.Fatal("unqualified memory invoked a host callback")
	}
}

func TestSecurityMemoryRecoveryEvidenceRequiresIndependentBoundFloors(t *testing.T) {
	request := SecurityMemoryRecoveryRequest{ProjectID: "project", ActionID: "actual-memory-consent", BindingDigest: hash("paired-recovery")}
	valid := SecurityMemoryRecoveryEvidence{ProviderID: "memory-owner", ProtocolVersion: "test-owner-protocol", ProjectID: request.ProjectID, ActionID: request.ActionID, BindingDigest: request.BindingDigest, ConsentFloorDigest: hash("latest-consent"), ForgetFloorDigest: hash("irreversible-forget-floor"), CurrentStateDigest: hash("current-provider-generation"), Purposes: []SecurityMemoryPurpose{SecurityMemoryRead}}
	if !validMemoryRecoveryEvidence(request, valid) {
		t.Fatal("well-formed provider evidence rejected")
	}
	for _, field := range []string{"consent", "forget", "current", "project", "action", "binding", "purpose"} {
		invalid := valid
		switch field {
		case "consent":
			invalid.ConsentFloorDigest = ""
		case "forget":
			invalid.ForgetFloorDigest = ""
		case "current":
			invalid.CurrentStateDigest = "not-a-digest"
		case "project":
			invalid.ProjectID = "other-project"
		case "action":
			invalid.ActionID = "task-grant"
		case "binding":
			invalid.BindingDigest = hash("other-checkpoint")
		case "purpose":
			invalid.Purposes = []SecurityMemoryPurpose{"all"}
		}
		if validMemoryRecoveryEvidence(request, invalid) {
			t.Fatal("incomplete or mismatched provider floor evidence accepted", field)
		}
	}
}
