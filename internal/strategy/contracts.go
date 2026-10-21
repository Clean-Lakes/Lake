// Package strategy defines versioned learning contracts. It has no runtime,
// database, model, tool, or authorization implementation.
package strategy

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"
)

const SchemaVersion = 1
const MaxContentBytes = 100000

type ScopeKind string

const (
	UserScope    ScopeKind = "user"
	ProjectScope ScopeKind = "project"
)

// Scope is an ownership selector, not an authorization grant. The host must
// resolve it against the authenticated local identity and existing projects.
type Scope struct {
	Kind      ScopeKind `json:"kind"`
	ProjectID string    `json:"projectId,omitempty"`
}

func (s Scope) Validate() error {
	switch s.Kind {
	case UserScope:
		if s.ProjectID != "" {
			return errors.New("user scope cannot contain a project ID")
		}
	case ProjectScope:
		if strings.TrimSpace(s.ProjectID) == "" || strings.TrimSpace(s.ProjectID) != s.ProjectID {
			return errors.New("project scope requires an exact project ID")
		}
	default:
		return errors.New("unknown strategy scope")
	}
	return nil
}

// Budget caps apply to the whole optimization task, not to each role or
// candidate. These values do not create counters or authorize any retries.
type Budget struct {
	ExtraReadRetries         int   `json:"extraReadRetries"`
	MaxRevisions             int   `json:"maxRevisions"`
	MaxNoProgressRevisions   int   `json:"maxNoProgressRevisions"`
	MaxConcurrentExperiments int   `json:"maxConcurrentExperiments"`
	MaxRuns                  int   `json:"maxRuns"`
	MaxOptimizationRequests  int   `json:"maxOptimizationRequests"`
	MaxAdditionalTokens      int64 `json:"maxAdditionalTokens"`
	MaxActiveSeconds         int64 `json:"maxActiveSeconds"`
	UserWaitTTLSeconds       int64 `json:"userWaitTtlSeconds"`
}

func DefaultBudget() Budget {
	return Budget{
		ExtraReadRetries: 2, MaxRevisions: 2, MaxNoProgressRevisions: 2,
		MaxConcurrentExperiments: 1, MaxRuns: 6, MaxOptimizationRequests: 12,
		MaxAdditionalTokens: 100000, MaxActiveSeconds: 600, UserWaitTTLSeconds: 86400,
	}
}

// Validate rejects missing/negative bounds and values beyond the v1 ceiling.
// Zero extra retries or revisions disables that added behavior, not its budget.
func (b Budget) Validate() error {
	ceiling := DefaultBudget()
	if b.ExtraReadRetries < 0 || b.ExtraReadRetries > ceiling.ExtraReadRetries ||
		b.MaxRevisions < 0 || b.MaxRevisions > ceiling.MaxRevisions {
		return errors.New("retry or revision limit is outside the v1 ceiling")
	}
	for _, pair := range [][2]int64{
		{int64(b.MaxNoProgressRevisions), int64(ceiling.MaxNoProgressRevisions)},
		{int64(b.MaxConcurrentExperiments), int64(ceiling.MaxConcurrentExperiments)},
		{int64(b.MaxRuns), int64(ceiling.MaxRuns)},
		{int64(b.MaxOptimizationRequests), int64(ceiling.MaxOptimizationRequests)},
		{b.MaxAdditionalTokens, ceiling.MaxAdditionalTokens},
		{b.MaxActiveSeconds, ceiling.MaxActiveSeconds},
		{b.UserWaitTTLSeconds, ceiling.UserWaitTTLSeconds},
	} {
		if pair[0] <= 0 || pair[0] > pair[1] {
			return errors.New("optimization budget must be positive and within the v1 ceiling")
		}
	}
	return nil
}

// Settings revision/epoch zero means implicit, unsaved defaults. Stored
// mutations allocate positive monotonic revisions and epochs in the host.
type Settings struct {
	Scope                Scope  `json:"scope"`
	Revision             int64  `json:"revision"`
	Epoch                int64  `json:"epoch"`
	MasterEnabled        bool   `json:"masterEnabled"`
	ApplyEnabled         bool   `json:"applyEnabled"`
	LearnEnabled         bool   `json:"learnEnabled"`
	CorrectEnabled       bool   `json:"correctEnabled"`
	OnlineCorrectEnabled bool   `json:"onlineCorrectEnabled"`
	Budget               Budget `json:"budget"`
}

func DefaultSettings(scope Scope) Settings {
	return Settings{Scope: scope, Budget: DefaultBudget()}
}

func (s Settings) Validate() error {
	if err := s.Scope.Validate(); err != nil {
		return err
	}
	if s.Revision < 0 || s.Epoch < 0 || (s.Revision == 0) != (s.Epoch == 0) {
		return errors.New("settings revision and epoch must both be zero or positive")
	}
	return s.Budget.Validate()
}

type AssetKind string

const (
	UserPreference  AssetKind = "user_preference"
	DomainProcedure AssetKind = "domain_procedure"
	ToolGuidance    AssetKind = "tool_guidance"
	ReportGuidance  AssetKind = "report_guidance"
)

type VerificationLevel string

const (
	UserConfirmed      VerificationLevel = "user_confirmed"
	SingleObservation  VerificationLevel = "single_observation"
	FixtureValidated   VerificationLevel = "fixture_validated"
	MultiTaskValidated VerificationLevel = "multi_task_validated"
)

type RevisionRef struct {
	AssetID     string `json:"assetId"`
	Revision    int64  `json:"revision"`
	ContentHash string `json:"contentHash"`
}

func (r RevisionRef) Validate() error {
	if strings.TrimSpace(r.AssetID) == "" || strings.TrimSpace(r.AssetID) != r.AssetID || r.Revision <= 0 {
		return errors.New("an exact asset ID and positive revision are required")
	}
	return validateHash(r.ContentHash)
}

// Applicability uses exact server-validated selectors. Instructions in Body
// and a declared resource type cannot add resources or operation permissions.
type Applicability struct {
	Profiles      []string `json:"profiles,omitempty"`
	ResourceKinds []string `json:"resourceKinds,omitempty"`
	DomainTags    []string `json:"domainTags,omitempty"`
}

// AssetRevision is immutable. Lifecycle and adoption belong to later events
// and bindings, never an in-place edit of this payload or its source files.
type AssetRevision struct {
	Ref            RevisionRef       `json:"ref"`
	ParentRevision int64             `json:"parentRevision"`
	Kind           AssetKind         `json:"kind"`
	Body           string            `json:"body"`
	Applicability  Applicability     `json:"applicability"`
	Verification   VerificationLevel `json:"verification"`
	SourceIDs      []string          `json:"sourceIds"`
}

func (r AssetRevision) Validate() error {
	if err := r.Ref.Validate(); err != nil {
		return err
	}
	if r.ParentRevision < 0 || r.ParentRevision >= r.Ref.Revision ||
		(r.Ref.Revision == 1 && r.ParentRevision != 0) || (r.Ref.Revision > 1 && r.ParentRevision == 0) {
		return errors.New("revision parent must refer to an earlier revision of this asset")
	}
	switch r.Kind {
	case UserPreference, DomainProcedure, ToolGuidance, ReportGuidance:
	default:
		return errors.New("unknown strategy asset kind")
	}
	switch r.Verification {
	case UserConfirmed, SingleObservation, FixtureValidated, MultiTaskValidated:
	default:
		return errors.New("unknown verification level")
	}
	if !utf8.ValidString(r.Body) || strings.TrimSpace(r.Body) == "" || len(r.Body) > MaxContentBytes {
		return errors.New("strategy body must be nonempty UTF-8 within the byte limit")
	}
	if ContentHash(r.Body) != r.Ref.ContentHash {
		return errors.New("strategy content hash does not match its exact bytes")
	}
	if len(r.SourceIDs) == 0 {
		return errors.New("strategy revision requires a source, including manual authoring")
	}
	seen := map[string]bool{}
	for _, id := range r.SourceIDs {
		if strings.TrimSpace(id) == "" || strings.TrimSpace(id) != id || seen[id] {
			return errors.New("source IDs must be exact, nonempty and unique")
		}
		seen[id] = true
	}
	return nil
}

// ContentHash hashes exact UTF-8 bytes; line endings and whitespace are not
// normalized. It is not a secret scanner, signature or authorization proof.
func ContentHash(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

func validateHash(value string) error {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size || strings.ToLower(value) != value {
		return errors.New("content hash must be lowercase SHA-256 hex")
	}
	return nil
}

type StopReason string

const (
	Completed              StopReason = "completed"
	BudgetExhausted        StopReason = "budget_exhausted"
	NoProgress             StopReason = "no_progress"
	PermissionBlocked      StopReason = "permission_blocked"
	TargetAmbiguous        StopReason = "target_ambiguous"
	CapabilityMissing      StopReason = "capability_missing"
	AwaitingReconciliation StopReason = "awaiting_reconciliation"
	AwaitingUser           StopReason = "awaiting_user"
	Cancelled              StopReason = "cancelled"
	Failed                 StopReason = "failed"
)

type ExperimentArm string

const (
	BaselineArm   ExperimentArm = "baseline"
	AssetsArm     ExperimentArm = "assets"
	CorrectionArm ExperimentArm = "assets_with_correction"
)
