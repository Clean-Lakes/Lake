package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func shadowManagedFixture(t *testing.T) (*Engine, Config, Call) {
	t.Helper()
	e, c, call, _, _ := grantConfirmationFixture(t)
	policy, err := e.SecurityProjectPolicy(t.Context(), "project")
	if err != nil {
		t.Fatal(err)
	}
	for i := range policy.Rules {
		policy.Rules[i].Effect = security.EffectAllow
	}
	if _, err = e.PutSecurityProjectPolicy(t.Context(), SecurityPolicyAction{ActorID: "user", ActionID: "shadow-policy", ProjectID: "project", ExpectedRevision: policy.Revision}, policy); err != nil {
		t.Fatal(err)
	}
	permissions := DefaultPermissions()
	permissions.SilentReadFiles = false
	c.Permissions = &permissions
	s, _ := e.get("case")
	s.mu.Lock()
	s.state.Config = c
	s.state.SecurityManaged = true
	s.mu.Unlock()
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: "begin-shadow", Mode: "shadow", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest}, []string{"project"}); err != nil {
		t.Fatal(err)
	}
	return e, c, call
}

func TestSecurityShadowRealManagedInvokeComparesBeforeIOWithoutConsumingAuthority(t *testing.T) {
	e, c, call := shadowManagedFixture(t)
	s, _ := e.get("case")
	// A shadow comparison must never ask the old Web policy bridge to classify
	// the operation: that bridge can mutate adoption/target state.
	e.Bridge = func(_ context.Context, _, name string, _ map[string]any, _ bool) (any, error) {
		if name == "policy" {
			t.Error("shadow invoked stateful legacy policy")
		}
		return nil, errors.New("unexpected bridge I/O")
	}
	value, err := e.invoke(t.Context(), s, c, call)
	if err != nil || !strings.Contains(js(value), "bounded actual content") {
		t.Fatal(value, err)
	}
	db, _, _, _ := e.securityTaskDB()
	var events []securityAuthorityEvent
	if err = db.Where("kind = ?", "shadow.compare").Find(&events).Error; err != nil || len(events) != 1 {
		t.Fatal(events, err)
	}
	var fact securityShadowFact
	if err = json.Unmarshal([]byte(events[0].Result), &fact); err != nil || fact.Comparison != "widening" || fact.LegacyEffect != security.EffectApprovalRequired || fact.ManagedEffect != security.EffectAllow || len(fact.DescriptorDigest) != 64 {
		t.Fatal(fact, err)
	}
	if strings.Contains(events[0].Result, "bounded.log") || strings.Contains(events[0].Result, "bounded actual content") {
		t.Fatal("audit leaked payload", events[0].Result)
	}
	for _, model := range []any{&securityTaskGrantRow{}, &nativeApproval{}} {
		var n int64
		if err = db.Model(model).Count(&n).Error; err != nil || n != 0 {
			t.Fatal("shadow consumed or issued authority", n, err)
		}
	}
	var op nativeOperation
	if err = db.First(&op).Error; err != nil || op.Status != "succeeded" || !events[0].At.Before(op.StartedAt) {
		t.Fatal("comparison was not recorded before dispatch", op.Status, events[0].At, op.StartedAt, err)
	}
}

func TestSecurityShadowWideningRequiresExactSnapshotCASAcknowledgementBeforeEnforcement(t *testing.T) {
	e, c, call := shadowManagedFixture(t)
	a, _ := args(call)
	p, d, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil || status.Precondition != "SHADOW_WIDENING_CONFIRMATION_REQUIRED" || len(status.ShadowDifferences) != 1 {
		t.Fatal(status, err)
	}
	id := status.ShadowDifferences[0].ID
	db, storeID, _, _ := e.securityTaskDB()
	// An old recovery identity cannot satisfy the current exact-ID review.
	oldFact := securityShadowFact{Version: 2, Tool: "read", Comparison: "widening", LegacyEffect: security.EffectApprovalRequired, ManagedEffect: security.EffectAllow, DescriptorDigest: hash("old")}
	if err = securityActionRecord(db, storeID, "old-epoch", "host", "shadow:old", "shadow.compare", "old", js(oldFact), 0, 0, oldFact, time.Now()); err != nil {
		t.Fatal(err)
	}
	var old securityAuthorityEvent
	db.First(&old, "recovery_epoch = ?", "old-epoch")
	for _, test := range []struct {
		name     string
		digest   string
		revision int64
		ids      []string
		mode     string
	}{
		{"unacknowledged", status.Digest, status.Revision, nil, "enforced"},
		{"stale-digest", hash("stale"), status.Revision, []string{id}, "shadow"},
		{"wrong-id", status.Digest, status.Revision, []string{"invented"}, "shadow"},
		{"old-epoch", status.Digest, status.Revision, []string{old.ID}, "shadow"},
		{"stale-cas", status.Digest, status.Revision - 1, []string{id}, "shadow"},
		{"duplicate", status.Digest, status.Revision, []string{id, id}, "shadow"},
		{"cannot-ack-and-enable", status.Digest, status.Revision, []string{id}, "enforced"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: test.name, Mode: test.mode, ExpectedRevision: test.revision, ConfirmedDigest: test.digest, ConfirmedShadowDifferences: test.ids}, []string{"project"})
			if err == nil {
				t.Fatal("invalid acknowledgement accepted")
			}
			var row securityRuntimeModeRow
			db.First(&row, "id = 1")
			if row.Revision != status.Revision || row.Mode != "shadow" {
				t.Fatal("failed request changed mode", row)
			}
			var n int64
			db.Model(&securityAuthorityEvent{}).Where("kind = ?", "shadow.acknowledge").Count(&n)
			if n != 0 {
				t.Fatal("failed request persisted acknowledgement")
			}
		})
	}
	action := SecurityModeAction{ActorID: "local-user", ActionID: "ack-reviewed-difference", Mode: "shadow", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest, ConfirmedShadowDifferences: []string{id}}
	acknowledged, err := e.SetSecurityMode(t.Context(), action, []string{"project"})
	if err != nil || acknowledged.Precondition != "READY" || acknowledged.Mode != "shadow" || acknowledged.Digest == status.Digest || !acknowledged.ShadowDifferences[0].Acknowledged {
		t.Fatal(acknowledged, err)
	}
	replay, err := e.SetSecurityMode(t.Context(), action, []string{"project"})
	if err != nil || replay.Revision != acknowledged.Revision {
		t.Fatal("ack replay changed state", replay, err)
	}
	action.ConfirmedShadowDifferences = []string{"invented"}
	if _, err = e.SetSecurityMode(t.Context(), action, []string{"project"}); err == nil {
		t.Fatal("action ID payload reuse accepted")
	}
	if SecurityEnforcementStatus().Ready {
		enabled, err := e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: "enforce-reviewed-snapshot", Mode: "enforced", ExpectedRevision: acknowledged.Revision, ConfirmedDigest: acknowledged.Digest}, []string{"project"})
		if err != nil || enabled.Mode != "enforced" {
			t.Fatal(enabled, err)
		}
	}
	var n int64
	db.Model(&securityTaskGrantRow{}).Count(&n)
	if n != 0 {
		t.Fatal("mode acknowledgement issued a grant")
	}
}

func TestSecurityShadowIncompleteNeverFabricatesAllowAndMissingTaskDoesNotUseExecutionErrors(t *testing.T) {
	e, c, call := shadowManagedFixture(t)
	a, _ := args(call)
	p, d, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"shell", "terminal_send_input", "inspect_host", "open_ssh_terminal"} {
		original := p.descriptor.Tool
		p.descriptor.Tool = name
		fact := securityShadowComparison(c, Call{ID: call.ID, Name: name}, p, d)
		p.descriptor.Tool = original
		if fact.Comparison != "incomplete" || fact.LegacyEffect != "" {
			t.Fatal("missing host metadata guessed allow", fact)
		}
	}
	permissions := DefaultPermissions()
	permissions.BlockUnreferencedAssets = true
	c.Permissions = &permissions
	fact := securityShadowComparison(c, call, p, d)
	if fact.LegacyEffect != security.EffectDeny || fact.Comparison != "widening" {
		t.Fatal("pure legacy deny not compared", fact)
	}
	s, _ := e.get("case")
	e.recordSecurityShadowCall(t.Context(), s, c, Call{ID: "no-task-success", Name: "read"}, true)
	e.recordSecurityShadowCall(t.Context(), s, c, Call{ID: "no-task-error", Name: "read"}, false)
	db, _, _, _ := e.securityTaskDB()
	var events []securityAuthorityEvent
	db.Where("kind = ?", "shadow.compare").Find(&events)
	if len(events) != 2 {
		t.Fatal(events)
	}
	for _, event := range events {
		var fact securityShadowFact
		json.Unmarshal([]byte(event.Result), &fact)
		if fact.Comparison != "incomplete" || fact.LegacyEffect != "" || fact.ManagedEffect != "" || fact.Reason != "missing_task_binding" {
			t.Fatal(fact)
		}
	}
}

func TestSecurityShadowComparisonLeavesGrantApprovalAndBudgetUntouched(t *testing.T) {
	e, c, call, p, proposal := grantConfirmationFixture(t)
	record := storeSelectedGrantProposal(t, e, c, p, proposal, securityGrantTaskChoice)
	db, _, _, _ := e.securityTaskDB()
	if err := e.workMutation(db, func(tx *gorm.DB) error {
		return e.claimSecurityTaskGrantApprovalTx(t.Context(), tx, record, p, time.Now().UTC())
	}); err != nil {
		t.Fatal(err)
	}
	a, _ := args(call)
	p, d, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil || d.Effect != security.EffectAllow {
		t.Fatal(d, err)
	}
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: "shadow", Mode: "shadow", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest}, []string{"project"}); err != nil {
		t.Fatal(err)
	}
	var before securityTaskGrantRow
	db.First(&before)
	s, _ := e.get("case")
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	var after securityTaskGrantRow
	db.First(&after)
	if before.RemainingUses != after.RemainingUses || before.Revision != after.Revision {
		t.Fatal("shadow consumed task grant")
	}
	var opCount int64
	db.Model(&nativeOperation{}).Count(&opCount)
	if opCount != 0 {
		t.Fatal("shadow created execution")
	}
	var approval nativeApproval
	db.First(&approval, "id = ?", record.ID)
	if approval.Status != "consumed" {
		t.Fatal("shadow changed original approval", approval.Status)
	}
}

func TestSecurityShadowFrozenNewTargetIsNotEvidenceOfLegacySelection(t *testing.T) {
	e, c, call := shadowManagedFixture(t)
	a, _ := args(call)
	p, d, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil {
		t.Fatal(err)
	}
	c.AssetRef = ""
	c.Assets = append(c.Assets, Asset{ID: "second-host", Kind: "ssh"})
	p.executionConfig.Assets = c.Assets
	// Prepare assigned its resolved target, but the old host's current selection
	// is unknown and two host choices exist. Neither old allow nor deny is known.
	if p.executionConfig.AssetRef == "" {
		t.Fatal("fixture did not resolve new target")
	}
	s, _ := e.get("case")
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil || len(status.ShadowDifferences) != 1 {
		t.Fatal(status, err)
	}
	fact := status.ShadowDifferences[0]
	if fact.Comparison != "incomplete" || fact.LegacyEffect != "" || fact.Reason != "target_selection_metadata_unavailable" {
		t.Fatal(fact)
	}
}

func TestSecurityShadowRepreparedSameCallCanRecordDifferentDecisionWithoutActionConflict(t *testing.T) {
	e, c, call := shadowManagedFixture(t)
	a, _ := args(call)
	p, d, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	// The SDK can resume the exact same descriptor after a single confirmation.
	// Both pure decisions are separate facts; audit idempotence must not prevent
	// the original approval from being claimed or the fresh call from continuing.
	d.Effect = security.EffectApprovalRequired
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	d.Effect = security.EffectAllow
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	db, _, _, _ := e.securityTaskDB()
	var n int64
	db.Model(&securityAuthorityEvent{}).Where("kind = ?", "shadow.compare").Count(&n)
	if n != 2 {
		t.Fatal("decision audit replay was not idempotent", n)
	}
}

func TestSecurityShadowAcknowledgementCannotBypassChangedCatalogReview(t *testing.T) {
	e, c, call := shadowManagedFixture(t)
	a, _ := args(call)
	p, d, err := e.PrepareCatalogOperation(t.Context(), "case", c, call, a)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := e.get("case")
	if err = e.recordSecurityShadowDecision(t.Context(), s, c, call, p, d); err != nil {
		t.Fatal(err)
	}
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil {
		t.Fatal(err)
	}
	db, _, _, _ := e.securityTaskDB()
	if err = db.Model(&securityResourceRevisionRow{}).Where("project_id = ?", "project").Update("state", "changing").Error; err != nil {
		t.Fatal(err)
	}
	action := SecurityModeAction{ActorID: "local-user", ActionID: "stale-catalog-ack", Mode: "shadow", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest, ConfirmedShadowDifferences: []string{status.ShadowDifferences[0].ID}}
	if _, err = e.SetSecurityMode(t.Context(), action, []string{"project"}); err == nil {
		t.Fatal("catalog changed after review but stale acknowledgement was accepted")
	}
	current, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil {
		t.Fatal(err)
	}
	action.ActionID = "current-catalog-ack"
	action.ConfirmedDigest = current.Digest
	acknowledged, err := e.SetSecurityMode(t.Context(), action, []string{"project"})
	if err != nil || acknowledged.Precondition != "CATALOG_CONFIRMATION_REQUIRED" {
		t.Fatal("acknowledgement bypassed catalog confirmation", acknowledged, err)
	}
	if _, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: "invalid-enable", Mode: "enforced", ExpectedRevision: acknowledged.Revision, ConfirmedDigest: acknowledged.Digest}, []string{"project"}); err == nil {
		t.Fatal("unreviewed catalog enabled")
	}
}
