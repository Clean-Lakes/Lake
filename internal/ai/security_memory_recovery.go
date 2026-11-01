package ai

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Clean-Lakes/Lake/internal/platform"
	"github.com/Clean-Lakes/Lake/internal/security"
)

var ErrSecurityMemoryRecoveryUnqualified = errors.New("security: restored Memory requires independent consent and forget-floor qualification")

type SecurityMemoryPurpose string

const (
	SecurityMemoryCapture    SecurityMemoryPurpose = "capture"
	SecurityMemoryUse        SecurityMemoryPurpose = "use"
	SecurityMemoryRead       SecurityMemoryPurpose = "read"
	SecurityMemoryIndex      SecurityMemoryPurpose = "index"
	SecurityMemoryProvider   SecurityMemoryPurpose = "provider"
	SecurityMemoryBackground SecurityMemoryPurpose = "background"
)

// SecurityMemoryRecoveryVerifier belongs to the current Memory provider, not
// Security policy or model arguments. It must compare the latest preserved
// consent/withdrawal/forget floors with incoming and current Memory state, and
// verify the original current-user Memory action independently. Missing or
// unsupported provider protocols must return an error, never optimistic consent.
// Verification is local and read-only, must not call an Engine, and runs again
// at each use; returning an earlier cached decision is not sufficient.
type SecurityMemoryRecoveryVerifier interface {
	VerifyMemoryRecovery(context.Context, SecurityMemoryRecoveryRequest) (SecurityMemoryRecoveryEvidence, error)
}

type SecurityMemoryRecoveryRequest struct {
	RecoveryID, StoreID, RecoveryEpoch, ProjectID, ActionID, BindingDigest string
	PreservedManifestHash, IncomingManifestHash                            string
	PreservedCheckpoint, IncomingCheckpoint, CurrentDataRoot               string
}

// Evidence contains commitments only. Memory content, source messages, forgotten
// keys and credentials must not be copied into Security's qualification marker.
type SecurityMemoryRecoveryEvidence struct {
	ProviderID, ProtocolVersion, ProjectID, ActionID, BindingDigest string
	ConsentFloorDigest, ForgetFloorDigest, CurrentStateDigest       string
	Purposes                                                        []SecurityMemoryPurpose
}

type securityMemoryRecoveryMarker struct {
	FormatVersion int                            `json:"formatVersion"`
	RecoveryID    string                         `json:"recoveryID"`
	StoreID       string                         `json:"storeID"`
	RecoveryEpoch string                         `json:"recoveryEpoch"`
	ProjectID     string                         `json:"projectID"`
	QualifiedAt   time.Time                      `json:"qualifiedAt"`
	Evidence      SecurityMemoryRecoveryEvidence `json:"evidence"`
}

type securityMemoryProjectContext struct{}

func verifyMemoryRecoveryProvider(ctx context.Context, provider SecurityMemoryRecoveryVerifier, request SecurityMemoryRecoveryRequest) (evidence SecurityMemoryRecoveryEvidence, err error) {
	defer func() {
		if recover() != nil {
			evidence, err = SecurityMemoryRecoveryEvidence{}, ErrSecurityMemoryRecoveryUnqualified
		}
	}()
	evidence, err = provider.VerifyMemoryRecovery(ctx, request)
	evidence.Purposes = append([]SecurityMemoryPurpose(nil), evidence.Purposes...)
	return evidence, err
}

// WithSecurityMemoryProject attaches a host-resolved project for the existing
// Memory extraction provider. It does not grant consent or bypass qualification.
func WithSecurityMemoryProject(ctx context.Context, projectID string) context.Context {
	return context.WithValue(ctx, securityMemoryProjectContext{}, projectID)
}

func validSecurityMemoryPurpose(purpose SecurityMemoryPurpose) bool {
	switch purpose {
	case SecurityMemoryCapture, SecurityMemoryUse, SecurityMemoryRead, SecurityMemoryIndex, SecurityMemoryProvider, SecurityMemoryBackground:
		return true
	}
	return false
}

func memoryRecoveryMarkerPath(home, recoveryID, projectID string) string {
	return filepath.Join(home, "security", "recoveries", recoveryID, "memory-"+hash(projectID)+".json")
}

func (e *Engine) memoryRecoveryRequest(ctx context.Context, projectID, actionID string) (*Engine, SecurityMemoryRecoveryRequest, error) {
	var request SecurityMemoryRecoveryRequest
	owner, err := securityRootEngine(e)
	if err != nil {
		return nil, request, err
	}
	h := owner.SecurityRuntime
	if h == nil {
		return owner, request, nil // Existing isolated/legacy engines have no restore identity.
	}
	if h.lock != nil {
		if _, err := h.lock.Stat(); err != nil {
			return owner, request, ErrSecurityMemoryRecoveryUnqualified
		}
	}
	if err = ctx.Err(); err != nil {
		return owner, request, err
	}
	control, err := ReadSecurityControl(h.Home)
	if err != nil {
		return owner, request, err
	}
	if control.StoreID != h.control.StoreID || control.RecoveryEpoch != h.control.RecoveryEpoch || control.RuntimeRoot != h.RuntimeRoot || control.Gate != "open" || !control.StoreReady || h.readOnly {
		return owner, request, ErrSecurityMemoryRecoveryUnqualified
	}
	if control.RecoveryID == "" {
		return owner, request, nil
	}
	if strings.TrimSpace(projectID) == "" || len(projectID) > 256 {
		return owner, request, ErrSecurityMemoryRecoveryUnqualified
	}
	if owner.SecurityMemoryRecoveryVerifier == nil {
		return owner, request, ErrSecurityMemoryRecoveryUnqualified
	}
	var journal securityRestoreJournal
	if err = privateSecurityRead(filepath.Join(h.Home, "security", "restore.pending.json"), &journal); err != nil {
		return owner, request, err
	}
	if !validSecurityRestoreJournal(journal) || journal.After.StoreID != control.StoreID || journal.After.RecoveryEpoch != control.RecoveryEpoch || journal.After.RecoveryID != control.RecoveryID || !activatedRecoveryControl(h.Home, control, journal) {
		return owner, request, ErrSecurityMemoryRecoveryUnqualified
	}
	root := filepath.Join(h.Home, "security", "recoveries", control.RecoveryID)
	if err = verifyRecoveryCheckpointBindings(ctx, root, journal); err != nil {
		return owner, request, err
	}
	request = SecurityMemoryRecoveryRequest{RecoveryID: control.RecoveryID, StoreID: control.StoreID, RecoveryEpoch: control.RecoveryEpoch, ProjectID: projectID, ActionID: actionID, PreservedManifestHash: journal.PreservedManifestHash, IncomingManifestHash: journal.IncomingManifestHash, PreservedCheckpoint: filepath.Join(root, "preserved"), IncomingCheckpoint: filepath.Join(root, "incoming"), CurrentDataRoot: filepath.Dir(control.RuntimeRoot)}
	request.BindingDigest = hash(js(struct{ RecoveryID, StoreID, RecoveryEpoch, ProjectID, Preserved, Incoming string }{request.RecoveryID, request.StoreID, request.RecoveryEpoch, projectID, request.PreservedManifestHash, request.IncomingManifestHash}))
	return owner, request, nil
}

func validMemoryRecoveryEvidence(request SecurityMemoryRecoveryRequest, evidence SecurityMemoryRecoveryEvidence) bool {
	if evidence.ProviderID == "" || len(evidence.ProviderID) > 128 || evidence.ProtocolVersion == "" || len(evidence.ProtocolVersion) > 128 || evidence.ProjectID != request.ProjectID || evidence.ActionID != request.ActionID || request.ActionID == "" || evidence.BindingDigest != request.BindingDigest || len(evidence.Purposes) == 0 {
		return false
	}
	for _, digest := range []string{evidence.ConsentFloorDigest, evidence.ForgetFloorDigest, evidence.CurrentStateDigest} {
		if _, err := hex.DecodeString(digest); len(digest) != 64 || err != nil {
			return false
		}
	}
	seen := map[SecurityMemoryPurpose]bool{}
	for _, purpose := range evidence.Purposes {
		if !validSecurityMemoryPurpose(purpose) || seen[purpose] {
			return false
		}
		seen[purpose] = true
	}
	return true
}

// QualifySecurityMemoryRecovery is a host-provider integration point. There is
// deliberately no HTTP/CLI/model "confirm Memory" endpoint. The Memory verifier
// must validate the exact original Memory action and irreversible forget floors.
func (e *Engine) QualifySecurityMemoryRecovery(ctx context.Context, projectID, memoryActionID string) error {
	if strings.TrimSpace(memoryActionID) == "" || len(memoryActionID) > 256 {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	owner, request, err := e.memoryRecoveryRequest(ctx, projectID, memoryActionID)
	if err != nil {
		return err
	}
	if request.RecoveryID == "" || owner.SecurityMemoryRecoveryVerifier == nil {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	evidence, err := verifyMemoryRecoveryProvider(ctx, owner.SecurityMemoryRecoveryVerifier, request)
	if err != nil || !validMemoryRecoveryEvidence(request, evidence) {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	slices.Sort(evidence.Purposes)
	marker := securityMemoryRecoveryMarker{FormatVersion: 1, RecoveryID: request.RecoveryID, StoreID: request.StoreID, RecoveryEpoch: request.RecoveryEpoch, ProjectID: projectID, QualifiedAt: time.Now().UTC(), Evidence: evidence}
	return e.withSecurityDispatchBarrier(func() error {
		// Recheck identity and provider floors after obtaining the owner barrier.
		_, current, err := e.memoryRecoveryRequest(ctx, projectID, memoryActionID)
		if err != nil || current.BindingDigest != request.BindingDigest {
			return ErrSecurityMemoryRecoveryUnqualified
		}
		currentEvidence, err := verifyMemoryRecoveryProvider(ctx, owner.SecurityMemoryRecoveryVerifier, current)
		if err != nil || !validMemoryRecoveryEvidence(current, currentEvidence) {
			return ErrSecurityMemoryRecoveryUnqualified
		}
		slices.Sort(currentEvidence.Purposes)
		if js(currentEvidence) != js(evidence) {
			return ErrSecurityMemoryRecoveryUnqualified
		}
		directory := filepath.Join(owner.SecurityRuntime.Home, "security", "recoveries", request.RecoveryID, "memory-actions")
		if err = platform.MkdirAll(directory, 0700); err != nil {
			return err
		}
		actionPath := filepath.Join(directory, hash(projectID+"\x00"+memoryActionID)+".json")
		var previous securityMemoryRecoveryMarker
		if err = privateSecurityRead(actionPath, &previous); err == nil {
			if previous.RecoveryID != marker.RecoveryID || previous.StoreID != marker.StoreID || previous.RecoveryEpoch != marker.RecoveryEpoch || previous.ProjectID != projectID || js(previous.Evidence) != js(marker.Evidence) {
				return ErrSecurityMemoryRecoveryUnqualified
			}
			marker = previous
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		} else if err = writeSecurityJSON(actionPath, marker); err != nil {
			return err
		}
		if err = platform.SyncDirectory(filepath.Dir(directory)); err != nil {
			return err
		}
		return writeSecurityJSON(memoryRecoveryMarkerPath(owner.SecurityRuntime.Home, request.RecoveryID, projectID), marker)
	})
}

// CheckSecurityMemoryEligibility is required at Memory read/capture/index and
// provider/background boundaries, independently of every SecurityTask/grant and
// of the resource gate. Normal Memory consent and tombstone checks still apply.
func (e *Engine) CheckSecurityMemoryEligibility(ctx context.Context, projectID string, purpose SecurityMemoryPurpose) error {
	if !validSecurityMemoryPurpose(purpose) {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	owner, request, err := e.memoryRecoveryRequest(ctx, projectID, "")
	if err != nil {
		return err
	}
	if err = owner.checkSecurityMemoryProjectPolicy(ctx, projectID, purpose); err != nil {
		return err
	}
	if request.RecoveryID == "" {
		return nil
	}
	if owner.SecurityMemoryRecoveryVerifier == nil {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	var marker securityMemoryRecoveryMarker
	if privateSecurityRead(memoryRecoveryMarkerPath(owner.SecurityRuntime.Home, request.RecoveryID, projectID), &marker) != nil || marker.FormatVersion != 1 || marker.RecoveryID != request.RecoveryID || marker.StoreID != request.StoreID || marker.RecoveryEpoch != request.RecoveryEpoch || marker.ProjectID != projectID || marker.QualifiedAt.IsZero() {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	var action securityMemoryRecoveryMarker
	actionPath := filepath.Join(owner.SecurityRuntime.Home, "security", "recoveries", request.RecoveryID, "memory-actions", hash(projectID+"\x00"+marker.Evidence.ActionID)+".json")
	if privateSecurityRead(actionPath, &action) != nil || js(action) != js(marker) {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	request.ActionID = marker.Evidence.ActionID
	if !validMemoryRecoveryEvidence(request, marker.Evidence) || !slices.Contains(marker.Evidence.Purposes, purpose) {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	current, err := verifyMemoryRecoveryProvider(ctx, owner.SecurityMemoryRecoveryVerifier, request)
	if err != nil || !validMemoryRecoveryEvidence(request, current) {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	slices.Sort(current.Purposes)
	if js(current) != js(marker.Evidence) {
		return ErrSecurityMemoryRecoveryUnqualified
	}
	return ctx.Err()
}

// Only an existing confirmed policy tightens the independent Memory-owner
// consent. Read-only SQL avoids lazy migrations and Home-mutex recursion in
// capture hooks. This check never issues authority or changes a Memory table.
func (e *Engine) checkSecurityMemoryProjectPolicy(ctx context.Context, projectID string, purpose SecurityMemoryPurpose) error {
	h := e.SecurityRuntime
	if h == nil {
		return nil
	}
	db, err := openSecurityReadOnly(filepath.Join(h.RuntimeRoot, "sessions.sqlite"))
	if err != nil {
		return err
	}
	var exists int
	err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='security_project_policies'").Scan(&exists)
	if err != nil || exists == 0 {
		db.Close()
		return err
	}
	var storeID, epoch, data string
	var revision int64
	var confirmed bool
	err = db.QueryRowContext(ctx, "SELECT store_id,recovery_epoch,revision,confirmed,data FROM security_project_policies WHERE project_id=?", projectID).Scan(&storeID, &epoch, &revision, &confirmed, &data)
	db.Close()
	if errors.Is(err, sql.ErrNoRows) {
		return nil // Existing Memory consent semantics for unconfigured projects.
	}
	if err != nil {
		return err
	}
	var policy security.ProjectPolicy
	if !confirmed || storeID != h.control.StoreID || epoch != h.control.RecoveryEpoch || json.Unmarshal([]byte(data), &policy) != nil || policy.ProjectID != projectID || policy.Revision != revision {
		return errors.New("security: current confirmed Memory project policy required")
	}
	capability := "memory.read"
	if purpose == SecurityMemoryCapture || purpose == SecurityMemoryBackground {
		capability = "memory.write"
	}
	permit, _ := ctx.Value(securityPermitContextKey{}).(*SecurityPermit)
	resourceIDs := []string{""}
	if permit != nil && permit.operation.ProjectID == projectID && slices.Contains(permit.operation.Capabilities, capability) && len(permit.operation.Resources) > 0 {
		resourceIDs = nil
		for _, resource := range permit.operation.Resources {
			resourceIDs = append(resourceIDs, resource.ID)
		}
	}
	needsPermit := false
	for _, resourceID := range resourceIDs {
		rule, matched := security.ResolveCapabilityRule(policy.Rules, capability, resourceID)
		if !matched || rule.Effect == security.EffectDeny {
			return errors.New("security: Memory capability denied by project policy")
		}
		if rule.Effect != security.EffectAllow {
			// Background/capture has no approval channel. A task grant can never
			// imply capture consent; only project allow plus owner consent works.
			if capability != "memory.read" || rule.Effect != security.EffectAsk || permit == nil || permit.operation.ProjectID != projectID || !slices.Contains(permit.operation.Capabilities, capability) {
				return errors.New("security: Memory requires current project allow or an explicit read permit")
			}
			needsPermit = true
		}
	}
	if needsPermit {
		return e.ValidateSecurityPermitAtIO(ctx, projectID, permit.operation.SessionID)
	}
	return nil
}
