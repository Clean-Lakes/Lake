package ai

import (
	"context"
	"errors"
	"runtime"
	"slices"
	"time"

	"github.com/Clean-Lakes/Lake/internal/security"
	"gorm.io/gorm"
)

type securityCommandTargetRow struct {
	ProjectID                                              string `gorm:"primaryKey"`
	ResourceID                                             string `gorm:"primaryKey"`
	StoreID, RecoveryEpoch, ConnectionDigest, OS, Services string
	ConnectionRevision, Revision                           int64
	Enabled                                                bool
}

func (securityCommandTargetRow) TableName() string { return "security_command_targets" }

type SecurityCommandTargetProfile struct {
	State                        string
	CurrentConnectionRevision    int64
	ProjectID, ResourceID, OS    string
	Revision, ConnectionRevision int64
	ConnectionDigest             string
	Enabled, Configured          bool
	Services                     []security.ServiceDefinition
	DiagnosticProfiles           []string
}
type SecurityCommandTargetAction struct {
	SecurityPolicyAction
	ResourceID, OS string
	Enabled        bool
	Services       []security.ServiceDefinition
}

func loadSecurityCommandTarget(tx *gorm.DB, projectID, resourceID, storeID, epoch string) (out SecurityCommandTargetProfile, err error) {
	var resource securityResourceRevisionRow
	if err = tx.First(&resource, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, resourceID, storeID, epoch).Error; err != nil {
		return out, err
	}
	if resource.State != "ready" || resource.Kind != "local" && resource.Kind != "ssh" {
		return out, security.ErrConflict
	}
	out = SecurityCommandTargetProfile{State: "ready", CurrentConnectionRevision: resource.ConnectionRevision, ProjectID: projectID, ResourceID: resourceID, ConnectionRevision: resource.ConnectionRevision, ConnectionDigest: resource.ConnectionDigest, Services: []security.ServiceDefinition{}}
	var row securityCommandTargetRow
	err = tx.First(&row, "project_id = ? AND resource_id = ?", projectID, resourceID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) && resource.Local {
		out.OS = runtime.GOOS
		out.Enabled = true
		out.DiagnosticProfiles = []string{"disk_usage", "process_snapshot"}
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if row.Revision < 1 || row.OS != "linux" && row.OS != "darwin" || resource.Local && row.OS != runtime.GOOS || row.StoreID != storeID || row.RecoveryEpoch != epoch || row.ConnectionRevision != resource.ConnectionRevision || row.ConnectionDigest != resource.ConnectionDigest {
		return out, security.ErrConflict
	}
	out.Configured = true
	out.OS, out.Revision, out.Enabled = row.OS, row.Revision, row.Enabled
	if err = decodeSecurityJSON(row.Services, &out.Services); err != nil {
		return out, err
	}
	out.DiagnosticProfiles = []string{"disk_usage", "process_snapshot"}
	if row.OS == "linux" && len(out.Services) > 0 {
		out.DiagnosticProfiles = append(out.DiagnosticProfiles, "service_status", "service_logs")
	}
	return out, nil
}
func (e *Engine) SecurityCommandTarget(ctx context.Context, projectID, resourceID string) (SecurityCommandTargetProfile, error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return SecurityCommandTargetProfile{}, err
	}
	return loadSecurityCommandTarget(db.WithContext(ctx), projectID, resourceID, storeID, epoch)
}
func (e *Engine) PutSecurityCommandTarget(ctx context.Context, a SecurityCommandTargetAction) (out SecurityCommandTargetProfile, err error) {
	if !validPolicyAction(a.SecurityPolicyAction) || a.ResourceID == "" || len(a.Services) > 100 || a.OS != "linux" && a.OS != "darwin" {
		return out, errSecurityAction
	}
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	err = e.withSecurityDispatchBarrier(func() error {
		return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			request := js(a)
			replay, err := securityActionReplay(tx, storeID, epoch, a.ActorID, a.ActionID, request, &out)
			if replay || err != nil {
				return err
			}
			var resource securityResourceRevisionRow
			if err = tx.First(&resource, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", a.ProjectID, a.ResourceID, storeID, epoch).Error; err != nil {
				return err
			}
			if resource.Kind != "local" && resource.Kind != "ssh" || a.Enabled && resource.State != "ready" || resource.Local && a.OS != runtime.GOOS {
				return errSecurityAction
			}
			services := slices.Clone(a.Services)
			seen := map[string]bool{}
			for i := range services {
				service := &services[i]
				if service.ResourceID == "" {
					service.ResourceID = a.ResourceID
				}
				if !identifier.MatchString(service.ID) || seen[service.ID] || service.ResourceID != a.ResourceID {
					return errSecurityAction
				}
				seen[service.ID] = true
				if _, err = security.CompileCommand(security.CommandRequest{ProfileID: "service_status", Version: security.CommandProfileVersion, OS: a.OS, ResourceID: a.ResourceID, Arguments: security.CommandArguments{ServiceID: service.ID}, Services: services}); err != nil {
					return err
				}
			}
			var row securityCommandTargetRow
			err = tx.First(&row, "project_id = ? AND resource_id = ?", a.ProjectID, a.ResourceID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				row = securityCommandTargetRow{ProjectID: a.ProjectID, ResourceID: a.ResourceID, StoreID: storeID, RecoveryEpoch: epoch}
			} else if err != nil {
				return err
			}
			if row.StoreID != storeID || row.RecoveryEpoch != epoch || row.Revision != a.ExpectedRevision {
				return security.ErrConflict
			}
			before := row.Revision
			row.Revision++
			row.ConnectionRevision, row.ConnectionDigest, row.OS, row.Enabled, row.Services = resource.ConnectionRevision, resource.ConnectionDigest, a.OS, a.Enabled, js(services)
			if err = tx.Save(&row).Error; err != nil {
				return err
			}
			out = SecurityCommandTargetProfile{State: "ready", CurrentConnectionRevision: resource.ConnectionRevision, ProjectID: a.ProjectID, ResourceID: a.ResourceID, OS: a.OS, Revision: row.Revision, ConnectionRevision: row.ConnectionRevision, ConnectionDigest: row.ConnectionDigest, Enabled: row.Enabled, Configured: true, Services: services, DiagnosticProfiles: []string{"disk_usage", "process_snapshot"}}
			if !row.Enabled {
				out.State = "disabled"
			}
			if a.OS == "linux" && len(services) > 0 {
				out.DiagnosticProfiles = append(out.DiagnosticProfiles, "service_status", "service_logs")
			}
			return securityActionRecord(tx, storeID, epoch, a.ActorID, a.ActionID, "command.target.put", a.ResourceID, request, before, row.Revision, out, time.Now().UTC(), a.ProjectID)
		})
	})
	return out, err
}

func (e *Engine) compileSecurityCommandProfile(ctx context.Context, c Config, op *security.PreparedOperation, a map[string]any, selected Asset, profile string) (*security.FrozenCommand, error) {
	if selected.Kind != "local" && selected.Kind != "ssh" {
		return nil, errors.New("security: profile requires registered host target")
	}
	target, err := e.SecurityCommandTarget(ctx, op.ProjectID, selected.ID)
	if err != nil {
		return nil, err
	}
	if !target.Enabled {
		return nil, errors.New("security: command target disabled")
	}
	arguments := security.CommandArguments{}
	if raw, ok := a["profile_arguments"]; ok {
		if err = decodeSecurityJSON(js(raw), &arguments); err != nil {
			return nil, err
		}
	}
	version := security.CommandProfileVersion
	if provided, exists := a["command_profile_version"]; exists && js(provided) != "1" {
		return nil, errors.New("security: command profile version must be exact integer 1")
	}
	if version != security.CommandProfileVersion {
		return nil, errors.New("security: command profile version mismatch")
	}
	compiled, err := security.CompileCommand(security.CommandRequest{ProfileID: profile, Version: version, OS: target.OS, ResourceID: selected.ID, Arguments: arguments, Services: target.Services})
	if err != nil {
		return nil, err
	}
	scope := compiled.Profile()
	op.CommandTargetRevision = target.Revision
	op.Proof, op.CommandProfileID, op.CommandProfileVersion, op.CommandArgumentsDigest = security.ProofCommandProfile, scope.ID, scope.Version, scope.ArgumentsDigest
	op.ServiceID = arguments.ServiceID
	if !slices.Contains(op.Capabilities, compiled.Capability()) {
		op.Capabilities = append(op.Capabilities, compiled.Capability())
	}
	if arguments.LogLines > 0 {
		op.Scope.LogLines = int64(arguments.LogLines)
	}
	if arguments.LogMinutes > 0 {
		op.Scope.LogSeconds = int64(arguments.LogMinutes * 60)
	}
	return &compiled, nil
}

func freezeSecurityGrantCommandTargets(tx *gorm.DB, storeID, epoch, projectID string, grant *security.TaskGrant, reconfirm bool) error {
	if len(grant.CommandProfiles) == 0 {
		if len(grant.CommandTargetRevisions) > 0 {
			return errSecurityAction
		}
		return nil
	}
	refs := []security.RevisionRef{}
	knownServices := map[string]bool{}
	for _, resource := range grant.Resources {
		target, err := loadSecurityCommandTarget(tx, projectID, resource.ID, storeID, epoch)
		if err != nil {
			return err
		}
		if !target.Enabled {
			return errSecurityAction
		}
		refs = append(refs, security.RevisionRef{ID: resource.ID, Revision: target.Revision})
		for _, service := range target.Services {
			knownServices[service.ID] = true
		}
	}
	for _, serviceID := range grant.ServiceIDs {
		if !knownServices[serviceID] {
			return errors.New("security: grant service absent from registered target")
		}
	}
	if !reconfirm && len(grant.CommandTargetRevisions) > 0 {
		if len(grant.CommandTargetRevisions) != len(refs) {
			return security.ErrConflict
		}
		for _, current := range refs {
			matches := 0
			for _, provided := range grant.CommandTargetRevisions {
				if current == provided {
					matches++
				}
			}
			if matches != 1 {
				return security.ErrConflict
			}
		}
	}
	grant.CommandTargetRevisions = refs
	return nil
}

// Management may inspect a stale definition to explicitly replace/revoke it;
// execution always uses the stricter loadSecurityCommandTarget path above.
func (e *Engine) SecurityCommandTargetConfiguration(ctx context.Context, projectID, resourceID string) (out SecurityCommandTargetProfile, err error) {
	db, storeID, epoch, err := e.securityTaskDB()
	if err != nil {
		return out, err
	}
	var current securityResourceRevisionRow
	if err = db.WithContext(ctx).First(&current, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, resourceID, storeID, epoch).Error; err != nil {
		return out, err
	}
	var row securityCommandTargetRow
	err = db.WithContext(ctx).First(&row, "project_id = ? AND resource_id = ? AND store_id = ? AND recovery_epoch = ?", projectID, resourceID, storeID, epoch).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return loadSecurityCommandTarget(db, projectID, resourceID, storeID, epoch)
	}
	if err != nil {
		return out, err
	}
	out = SecurityCommandTargetProfile{ProjectID: projectID, ResourceID: resourceID, OS: row.OS, Revision: row.Revision, ConnectionRevision: row.ConnectionRevision, ConnectionDigest: row.ConnectionDigest, CurrentConnectionRevision: current.ConnectionRevision, Configured: true, Enabled: row.Enabled, State: "ready", DiagnosticProfiles: []string{"disk_usage", "process_snapshot"}}
	if err = decodeSecurityJSON(row.Services, &out.Services); err != nil {
		return out, err
	}
	if !row.Enabled {
		out.State = "disabled"
	} else if current.State != "ready" || current.ConnectionRevision != row.ConnectionRevision || current.ConnectionDigest != row.ConnectionDigest {
		out.State = "stale"
	}
	if out.OS == "linux" && len(out.Services) > 0 {
		out.DiagnosticProfiles = append(out.DiagnosticProfiles, "service_status", "service_logs")
	}
	return out, nil
}
