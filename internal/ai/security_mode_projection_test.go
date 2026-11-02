package ai

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func assertBoundedSecurityModeStatus(t *testing.T, status SecurityModeStatus, total, pending int) {
	t.Helper()
	if len(status.ShadowDifferences) != min(total, securityShadowStatusLimit) || status.ShadowDifferencesTotal != total || status.ShadowWideningRemaining != pending || status.ShadowDifferencesTruncated != (total > securityShadowStatusLimit) {
		t.Fatalf("incorrect projection counts: visible=%d total=%d pending=%d truncated=%t", len(status.ShadowDifferences), status.ShadowDifferencesTotal, status.ShadowWideningRemaining, status.ShadowDifferencesTruncated)
	}
	if size := len(js(status)); size >= 65536 {
		t.Fatalf("mode response exceeds the existing private CLI bound: %d bytes", size)
	}
	for i, difference := range status.ShadowDifferences {
		if i < min(pending, securityShadowStatusLimit) && (difference.Comparison != "widening" || difference.Acknowledged) {
			t.Fatal("history hid a pending widening", difference.ID)
		}
	}
}

func TestSecurityModeBoundedProjectionKeepsFullDigestAndBatchedAcknowledgement(t *testing.T) {
	e, _, _ := shadowManagedFixture(t)
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	err = e.workMutation(db, func(tx *gorm.DB) error {
		for i := 0; i < 1000; i++ {
			fact := securityShadowFact{Version: 2, Tool: "read", DescriptorDigest: hash(fmt.Sprint(i)), LegacyEffect: security.EffectAllow, ManagedEffect: security.EffectAllow, Comparison: "equal"}
			if i < 300 {
				fact.LegacyEffect, fact.Comparison = security.EffectApprovalRequired, "widening"
			} else if i >= 700 {
				fact.LegacyEffect, fact.ManagedEffect, fact.Comparison, fact.Reason = "", "", "incomplete", "missing_task_binding"
			}
			if err := securityActionRecord(tx, storeID, epoch, "host", fmt.Sprintf("shadow:projection:%d", i), "shadow.compare", fmt.Sprint(i), js(fact), 0, 0, fact, time.Now(), "project"); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	status, err := e.SecurityMode(t.Context(), []string{"project"})
	if err != nil || status.Precondition != "SHADOW_WIDENING_CONFIRMATION_REQUIRED" {
		t.Fatal(status.Precondition, err)
	}
	assertBoundedSecurityModeStatus(t, status, 1000, 300)
	original := status
	// A new equal fact is invisible behind the first pending review batch. It
	// must nevertheless change the complete digest and invalidate the old ACK.
	fact := securityShadowFact{Version: 2, Tool: "read", DescriptorDigest: hash("hidden-new-fact"), LegacyEffect: security.EffectAllow, ManagedEffect: security.EffectAllow, Comparison: "equal"}
	if err = e.workMutation(db, func(tx *gorm.DB) error {
		return securityActionRecord(tx, storeID, epoch, "host", "shadow:hidden-new-fact", "shadow.compare", "hidden-new-fact", js(fact), 0, 0, fact, time.Now(), "project")
	}); err != nil {
		t.Fatal(err)
	}
	status, err = e.SecurityMode(t.Context(), []string{"project"})
	if err != nil || status.Digest == original.Digest || !slices.Equal(status.ShadowDifferences, original.ShadowDifferences) {
		t.Fatal("hidden fact did not affect the full snapshot independently of its projection", err)
	}
	assertBoundedSecurityModeStatus(t, status, 1001, 300)
	if _, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: "stale-before-hidden-fact", Mode: "shadow", ExpectedRevision: original.Revision, ConfirmedDigest: original.Digest, ConfirmedShadowDifferences: []string{original.ShadowDifferences[0].ID}}, []string{"project"}); err == nil {
		t.Fatal("an undisplayed fact changed but the stale snapshot ACK was accepted")
	}
	for batch := 0; batch < 3; batch++ {
		// Visible-only acknowledgement cannot hide the 200/100 still-pending
		// facts. Every current fact remains in the enforcement precondition.
		if SecurityEnforcementStatus().Ready {
			if _, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: fmt.Sprintf("premature-enable-%d", batch), Mode: "enforced", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest}, []string{"project"}); err == nil {
				t.Fatal("undisplayed widening did not block enforcement")
			}
		}
		ids := []string{}
		for _, difference := range status.ShadowDifferences {
			if difference.Comparison == "widening" && !difference.Acknowledged {
				ids = append(ids, difference.ID)
			}
		}
		if len(ids) != 100 {
			t.Fatal("the next pending batch was not exposed", len(ids))
		}
		status, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: fmt.Sprintf("review-batch-%d", batch), Mode: "shadow", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest, ConfirmedShadowDifferences: ids}, []string{"project"})
		if err != nil {
			t.Fatal(err)
		}
		assertBoundedSecurityModeStatus(t, status, 1001, 200-batch*100)
		want := "SHADOW_WIDENING_CONFIRMATION_REQUIRED"
		if batch == 2 {
			want = "READY"
		}
		if status.Precondition != want || status.Mode != "shadow" {
			t.Fatal("a review batch changed the wrong authority state", status.Precondition, status.Mode)
		}
	}
	if SecurityEnforcementStatus().Ready {
		status, err = e.SetSecurityMode(t.Context(), SecurityModeAction{ActorID: "local-user", ActionID: "enable-all-reviewed", Mode: "enforced", ExpectedRevision: status.Revision, ConfirmedDigest: status.Digest}, []string{"project"})
		if err != nil || status.Mode != "enforced" {
			t.Fatal(status.Mode, err)
		}
		assertBoundedSecurityModeStatus(t, status, 1001, 0)
	}
}

func TestSecurityModeLegacyActionReplayReceivesBoundedProjection(t *testing.T) {
	e, _, _ := shadowManagedFixture(t)
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		t.Fatal(err)
	}
	action := SecurityModeAction{ActorID: "local-user", ActionID: "old-unbounded-replay", Mode: "shadow", ExpectedRevision: 1, ConfirmedDigest: hash("original-reviewed-snapshot")}
	stored := SecurityModeStatus{Mode: "shadow", Revision: 2, Digest: hash("original-reviewed-snapshot"), Precondition: "SHADOW_WIDENING_CONFIRMATION_REQUIRED", Coverage: SecurityEnforcementStatus()}
	for i := 0; i < 300; i++ {
		stored.ShadowDifferences = append(stored.ShadowDifferences, SecurityShadowDifference{ID: fmt.Sprint(i), Tool: "read", DescriptorDigest: hash(fmt.Sprint(i)), LegacyEffect: security.EffectApprovalRequired, ManagedEffect: security.EffectAllow, Comparison: "widening"})
	}
	if err = e.workMutation(db, func(tx *gorm.DB) error {
		return securityActionRecord(tx, storeID, epoch, action.ActorID, action.ActionID, "mode.set", "home", js(action), 1, 2, stored, time.Now())
	}); err != nil {
		t.Fatal(err)
	}
	replay, err := e.SetSecurityMode(t.Context(), action, []string{"project"})
	if err != nil || replay.Mode != stored.Mode || replay.Revision != stored.Revision || replay.Digest != stored.Digest || replay.Precondition != stored.Precondition {
		t.Fatal("bounded replay changed the recorded authority outcome", err)
	}
	assertBoundedSecurityModeStatus(t, replay, 300, 300)
	var count int64
	if err = db.Model(&securityAuthorityEvent{}).Where("actor_id = ? AND action_id = ?", action.ActorID, action.ActionID).Count(&count).Error; err != nil || count != 1 {
		t.Fatal("projection replay created another action", count, err)
	}
}
