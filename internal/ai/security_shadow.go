package ai

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

// SecurityShadowDifference is management-only audit data. No arguments,
// connection settings, secrets, or approval payloads enter this projection.
type SecurityShadowDifference struct {
	ID                    string          `json:"id"`
	Tool                  string          `json:"tool"`
	DescriptorDigest      string          `json:"descriptorDigest"`
	LegacyEffect          security.Effect `json:"legacyEffect"`
	ManagedEffect         security.Effect `json:"managedEffect"`
	Comparison            string          `json:"comparison"`
	Reason                string          `json:"reason"`
	Acknowledged          bool            `json:"acknowledged"`
	AcknowledgementDigest string          `json:"acknowledgementDigest,omitempty"`
}

type securityShadowFact struct {
	Version          int             `json:"version"`
	Tool             string          `json:"tool"`
	DescriptorDigest string          `json:"descriptorDigest"`
	LegacyEffect     security.Effect `json:"legacyEffect"`
	ManagedEffect    security.Effect `json:"managedEffect"`
	Comparison       string          `json:"comparison"`
	Reason           string          `json:"reason"`
}

type securityShadowAcknowledgement struct {
	DifferenceIDs  []string `json:"differenceIds"`
	SnapshotDigest string   `json:"snapshotDigest"`
}

// This is deliberately a partial reproduction of the old *pure* approval
// decision. A bridge policy lookup can adopt terminals or depend on live target
// state; shadow must not call it, guess its result, or treat an I/O error as deny.
func securityShadowLegacyEffect(c Config, call Call, p *SecurityPreparedOperation) (security.Effect, string) {
	if p == nil {
		return "", "missing_task_binding"
	}
	op, a := p.descriptor, p.executionArgs
	if op.Tool != call.Name || op.TerminalID != "" || c.TerminalID != "" || str(a["terminal_id"]) != "" {
		return "", "terminal_metadata_unavailable"
	}
	pc := map[string]any{}
	switch call.Name {
	case "list_assets", "list_resource_groups", "render_chart":
	case "read", "ls", "glob", "grep", "write", "edit", "multi_edit", "append", "delete", "stage_attachment", "execute_sql", "list_db_objects", "db_table_ddl", "redis_command", "query_kubernetes", "kubernetes_capabilities", "kubernetes_action", "observe_data":
		if len(op.Resources) != 1 {
			return "", "target_metadata_unavailable"
		}
		as, err := asset(c, str(a["asset_ref"]))
		if err != nil || as.ID != op.Resources[0].ID {
			return "", "target_metadata_unavailable"
		}
		pc["asset_ref"], pc["runtime"] = as.ID, as.Kind
		if c.AssetRef == "" && (as.Kind == "local" || as.Kind == "ssh") {
			hosts := 0
			for _, candidate := range c.Assets {
				if candidate.Kind == "local" || candidate.Kind == "ssh" {
					hosts++
				}
			}
			if hosts > 1 {
				return "", "target_selection_metadata_unavailable"
			}
		}
		if call.Name == "delete" {
			pc["catastrophic"] = CatastrophicDelete(str(a["path"]))
		}
		if call.Name == "query_kubernetes" {
			pc["kubernetesLogs"] = a["metric"] == "logs"
		}
	default:
		return "", "legacy_policy_metadata_unavailable"
	}
	for _, key := range []string{"command", "input", "initial_input"} {
		if CatastrophicCommand(str(a[key])) {
			pc["catastrophic"] = true
		}
	}
	if err := enforceTargetScope(c, call.Name, a, pc); err != nil {
		return security.EffectDeny, ""
	}
	kind, err := approvalKind(c, call.Name, ToolRisk(call.Name, a), pc)
	if err != nil {
		return security.EffectDeny, ""
	}
	if kind != "" {
		return security.EffectApprovalRequired, ""
	}
	return security.EffectAllow, ""
}

func securityShadowComparison(c Config, call Call, p *SecurityPreparedOperation, decision security.Decision) securityShadowFact {
	fact := securityShadowFact{Version: 2, Tool: call.Name, Comparison: "incomplete"}
	if _, ok := security.LookupTool(call.Name); !ok {
		fact.Tool = "unregistered"
		fact.Reason = "unregistered_tool"
		return fact
	}
	fact.LegacyEffect, fact.Reason = securityShadowLegacyEffect(c, call, p)
	if p == nil {
		return fact
	}
	fact.DescriptorDigest, fact.ManagedEffect = p.digest, decision.Effect
	if fact.Reason != "" {
		return fact
	}
	rank := map[security.Effect]int{security.EffectDeny: 0, security.EffectApprovalRequired: 1, security.EffectAllow: 2}
	oldRank, oldOK := rank[fact.LegacyEffect]
	newRank, newOK := rank[fact.ManagedEffect]
	if !oldOK || !newOK {
		fact.Reason = "decision_unavailable"
		return fact
	}
	fact.Comparison = "equal"
	if newRank > oldRank {
		fact.Comparison = "widening"
	} else if newRank < oldRank {
		fact.Comparison = "narrowing"
	}
	return fact
}

func (e *Engine) recordSecurityShadowDecision(ctx context.Context, s *session, c Config, call Call, prepared *SecurityPreparedOperation, decision security.Decision) error {
	if e.securityHome() == nil {
		return nil
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	s.mu.Lock()
	sid, root := s.state.View.Session, s.state.View.RootTurnID
	remembered := slices.Clone(s.state.ReferencedAssetIDs)
	s.mu.Unlock()
	if prepared != nil {
		// The new preparer resolves its own execution target. That resolution is
		// not evidence that the old host had a selected target or adopted terminal.
		frozen := prepared.executionConfig
		frozen.AssetRef, frozen.TerminalID, frozen.Runtime = c.AssetRef, c.TerminalID, c.Runtime
		c = frozen
	}
	c.ReferencedAssets = validRemembered(c, append(slices.Clone(c.ReferencedAssets), remembered...))
	fact := securityShadowComparison(c, call, prepared, decision)
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		mode, err := securityRuntimeModeTx(tx, storeID, epoch)
		if err != nil || mode.Mode != "shadow" {
			return err
		}
		action := "shadow:" + hash(sid+"\x00"+root+"\x00"+call.ID+"\x00"+fact.DescriptorDigest+"\x00"+hash(js(fact)))
		if replay, err := securityActionReplay(tx, storeID, epoch, "host", action, js(fact), &securityShadowFact{}); replay || err != nil {
			return err
		}
		return securityActionRecord(tx, storeID, epoch, "host", action, "shadow.compare", call.ID, js(fact), 0, 0, fact, time.Now().UTC(), configSecurityProject(c))
	})
}

func authenticSecurityShadowEvent(event securityAuthorityEvent) bool {
	return event.ID != "" && event.ActorID != "" && event.ActionKey == hash(event.StoreID+"\x00"+event.RecoveryEpoch+"\x00"+event.ActorID+"\x00"+event.ActionID) && event.RequestHash == hash(event.Result)
}

// Read only original authority events in the current identity. Request-supplied
// IDs never become facts, and an old recovery epoch cannot acknowledge this one.
func securityShadowSnapshotTx(tx *gorm.DB, storeID, epoch string) ([]SecurityShadowDifference, error) {
	var events []securityAuthorityEvent
	if err := tx.Where("store_id = ? AND recovery_epoch = ? AND kind IN ?", storeID, epoch, []string{"shadow.compare", "shadow.acknowledge"}).Order("id").Find(&events).Error; err != nil {
		return nil, err
	}
	acknowledged := map[string]string{}
	for _, event := range events {
		if event.Kind != "shadow.acknowledge" || event.ActorID == "host" || !authenticSecurityShadowEvent(event) {
			continue
		}
		var ack securityShadowAcknowledgement
		if json.Unmarshal([]byte(event.Result), &ack) != nil || len(ack.SnapshotDigest) != 64 {
			return nil, errors.New("security: malformed shadow acknowledgement")
		}
		for _, id := range ack.DifferenceIDs {
			acknowledged[id] = hash(js([]string{event.ID, event.RequestHash, event.ActorID, event.ActionID}))
		}
	}
	differences := []SecurityShadowDifference{}
	for _, event := range events {
		if event.Kind != "shadow.compare" {
			continue
		}
		if event.ActorID != "host" || !strings.HasPrefix(event.ActionID, "shadow:") || !authenticSecurityShadowEvent(event) {
			return nil, errors.New("security: untrusted shadow comparison")
		}
		var fact securityShadowFact
		if json.Unmarshal([]byte(event.Result), &fact) != nil {
			return nil, errors.New("security: malformed shadow comparison")
		}
		if fact.Version == 0 && fact.Comparison == "missing_task_binding" {
			// Older shadow audit recorded only this limitation, plus an execution
			// outcome. Preserve the limitation; neither success nor failure is policy.
			fact = securityShadowFact{Version: 2, Tool: fact.Tool, Comparison: "incomplete", Reason: "missing_task_binding"}
		}
		if fact.Version != 2 {
			return nil, errors.New("security: unsupported shadow comparison")
		}
		if _, ok := security.LookupTool(fact.Tool); !ok && fact.Tool != "unregistered" {
			return nil, errors.New("security: invalid shadow tool")
		}
		differences = append(differences, SecurityShadowDifference{ID: event.ID, Tool: fact.Tool, DescriptorDigest: fact.DescriptorDigest, LegacyEffect: fact.LegacyEffect, ManagedEffect: fact.ManagedEffect, Comparison: fact.Comparison, Reason: fact.Reason, Acknowledged: acknowledged[event.ID] != "", AcknowledgementDigest: acknowledged[event.ID]})
	}
	return differences, nil
}

func acknowledgeSecurityShadowTx(tx *gorm.DB, storeID, epoch string, action SecurityModeAction, differences []SecurityShadowDifference) error {
	if action.ActorID == "host" {
		return errSecurityAction
	}
	ids := slices.Clone(action.ConfirmedShadowDifferences)
	slices.Sort(ids)
	if len(ids) == 0 || len(slices.Compact(slices.Clone(ids))) != len(ids) {
		return errSecurityAction
	}
	valid := map[string]bool{}
	for _, difference := range differences {
		if difference.Comparison == "widening" && !difference.Acknowledged {
			valid[difference.ID] = true
		}
	}
	for _, id := range ids {
		if !valid[id] {
			return errors.New("security: exact current unacknowledged shadow widening IDs required")
		}
	}
	ack := securityShadowAcknowledgement{DifferenceIDs: ids, SnapshotDigest: action.ConfirmedDigest}
	return securityActionRecord(tx, storeID, epoch, action.ActorID, action.ActionID+":shadow-acknowledge", "shadow.acknowledge", "home", js(ack), action.ExpectedRevision, action.ExpectedRevision+1, ack, time.Now().UTC())
}
