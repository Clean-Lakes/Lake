package ai

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

func inheritedSuperCatalogPolicyTx(tx *gorm.DB, policy security.ProjectPolicy) (bool, error) {
	var event securityAuthorityEvent
	err := tx.First(&event, "project_id = ? AND object_id = ? AND kind = ? AND after_revision = ? AND store_id = ? AND recovery_epoch = ?", policy.ProjectID, policy.ProjectID, "policy.put", policy.Revision, policy.StoreID, policy.RecoveryEpoch).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	return err == nil && event.ActorID == "host" && strings.HasPrefix(event.ActionID, "superagent-catalog:"), err
}

// Legacy permissions authorize operations on the chosen project resource,
// rather than a second file/schema/namespace selection. Express that existing
// authority as the exact host-prepared operation scope for the evaluator; task,
// parent, resource, connection and current session checks still apply separately.
func inheritedSuperOperationLimits(scope security.OperationScope) security.ScopeLimits {
	limits := security.ScopeLimits{FileRoots: []string{scope.FilePath}, DatabaseID: scope.DatabaseID, Schemas: []string{scope.Schema}, MaxRows: scope.MaxRows, MaxDurationMS: scope.MaxDurationMS, ClusterID: scope.ClusterID, Namespaces: []string{scope.Namespace}, ResourceKinds: []string{scope.ResourceKind}, Verbs: []string{scope.Verb}, MaxLogLines: scope.LogLines, MaxLogSeconds: scope.LogSeconds}
	if scope.NetworkHost != "" {
		target := security.NetworkLimit{Scheme: scope.NetworkScheme, Host: scope.NetworkHost, Port: scope.NetworkPort}
		for _, address := range scope.ResolvedAddresses {
			if ip, err := netip.ParseAddr(address); err == nil {
				target.AddressCIDRs = append(target.AddressCIDRs, netip.PrefixFrom(ip, ip.BitLen()).String())
			}
		}
		limits.NetworkTargets = []security.NetworkLimit{target}
	}
	return limits
}

// InheritSuperProjectAccess is a trusted host adapter for the existing project
// catalog and session permissions. It does not grant from model input or replace
// an explicitly managed project policy. The legacy adapter still applies the
// current session's captured permissions to every operation.
func (e *Engine) InheritSuperProjectAccess(ctx context.Context, projectID string) error {
	if projectID == "" {
		return errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return err
	}
	return e.workMutation(db.WithContext(ctx), func(tx *gorm.DB) error {
		var row securityProjectPolicyRow
		err := tx.First(&row, "project_id = ?", projectID).Error
		missing := errors.Is(err, gorm.ErrRecordNotFound)
		if err != nil && !missing {
			return err
		}
		mode, err := securityRuntimeModeTx(tx, storeID, epoch)
		if err != nil {
			return err
		}
		if missing && mode.Mode == "enforced" {
			return errors.New("security: enforced Home requires a confirmed project policy")
		}
		var policy security.ProjectPolicy
		if !missing {
			policy, err = loadSecurityPolicy(tx, projectID, storeID, epoch)
			if err != nil {
				return err
			}
			// Only this adapter's exact current revision follows the catalog.
			// A user's later policy edit ends inheritance, even if its data is
			// otherwise identical. Original explicit restrictions stay intact.
			inherited, err := inheritedSuperCatalogPolicyTx(tx, policy)
			if err != nil || !inherited {
				return err
			}
		}
		var ids []string
		if err = tx.Model(&securityResourceRevisionRow{}).Where("project_id = ? AND store_id = ? AND recovery_epoch = ? AND state = ?", projectID, storeID, epoch, "ready").Order("resource_id").Pluck("resource_id", &ids).Error; err != nil {
			return err
		}
		if !missing && slices.Equal(policy.ResourceIDs, ids) {
			return nil
		}
		if missing {
			policy = security.ProjectPolicy{ProjectID: projectID, SchemaVersion: security.SchemaVersion, Mode: "legacy"}
			caps := []string{"local.execute", "command.diagnostics", "service.restart"}
			for _, name := range security.RegisteredTools() {
				spec, _ := security.LookupTool(name)
				caps = append(caps, spec.Capabilities...)
			}
			slices.Sort(caps)
			for _, capability := range slices.Compact(caps) {
				policy.Rules = append(policy.Rules, security.Rule{Capability: capability, Effect: security.EffectAllow})
			}
		}
		policy.ResourceIDs = ids
		if err = raiseSecurityPolicyReaderGuard(tx, storeID, epoch); err != nil {
			return err
		}
		_, err = putSecurityProjectPolicy(tx, storeID, epoch, SecurityPolicyAction{ActorID: "host", ActionID: fmt.Sprintf("superagent-catalog:%s:%d", projectID, policy.Revision+1), ProjectID: projectID, ExpectedRevision: policy.Revision}, policy, time.Now().UTC())
		return err
	})
}
