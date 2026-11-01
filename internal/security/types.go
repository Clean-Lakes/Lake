package security

import "time"

type TargetKind string

const (
	TargetResource    TargetKind = "resource"
	TargetResourceSet TargetKind = "resource_set"
	TargetProject     TargetKind = "project"
	TargetSession     TargetKind = "session"
	TargetNone        TargetKind = "none"
)

type ProofLevel string

const (
	ProofStructured     ProofLevel = "structured"
	ProofCommandProfile ProofLevel = "command_profile"
	ProofOpaque         ProofLevel = "opaque"
)

type Effect string

const (
	EffectAllow            Effect = "allow"
	EffectAsk              Effect = "ask"
	EffectDeny             Effect = "deny"
	EffectApprovalRequired Effect = "approval_required"
)

type Confirmation string

const (
	ConfirmSingle Confirmation = "single"
	ConfirmTask   Confirmation = "task"
	ConfirmEither Confirmation = "either"
)

type ResourceRevision struct {
	ID                 string `json:"id"`
	ConnectionRevision int64  `json:"connectionRevision"`
	ConnectionDigest   string `json:"connectionDigest"`
	State              string `json:"state"`
	Local              bool   `json:"local"`
	ConnectionIdentity string `json:"connectionIdentity,omitempty"`
}

type CredentialRevision struct {
	Reference string `json:"reference"`
	Revision  int64  `json:"revision"`
}

type RevisionRef struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

// PreparedOperation contains references and digests only. The trusted host
// resolves actual parameters and secrets separately. StateRevision is omitted:
// normal approval waiting must not invalidate its own prepared descriptor.
type PreparedOperation struct {
	RequireSingleConfirmation bool                 `json:"requireSingleConfirmation"`
	CommandTargetRevision     int64                `json:"commandTargetRevision"`
	FormatVersion             int                  `json:"formatVersion"`
	ID                        string               `json:"id"`
	Actor                     string               `json:"actor"`
	LocalExecution            bool                 `json:"localExecution"`
	StoreID                   string               `json:"storeId"`
	RecoveryEpoch             string               `json:"recoveryEpoch"`
	ProjectID                 string               `json:"projectId"`
	SessionID                 string               `json:"sessionId"`
	GoalID                    string               `json:"goalId"`
	GoalRevision              int64                `json:"goalRevision"`
	PlanRevision              int64                `json:"planRevision"`
	StepID                    string               `json:"stepId"`
	StepRevision              int64                `json:"stepRevision"`
	AttemptID                 string               `json:"attemptId"`
	TaskID                    string               `json:"taskId"`
	ExecutionRevision         int64                `json:"executionRevision"`
	RootTurnID                string               `json:"rootTurnId"`
	ChildScopeID              string               `json:"childScopeId"`
	CallID                    string               `json:"callId"`
	Tool                      string               `json:"tool"`
	RegistryVersion           string               `json:"registryVersion"`
	TargetKind                TargetKind           `json:"targetKind"`
	Resources                 []ResourceRevision   `json:"resources"`
	Capabilities              []string             `json:"capabilities"`
	Proof                     ProofLevel           `json:"proof"`
	ArgumentsDigest           string               `json:"argumentsDigest"`
	PreviewDigest             string               `json:"previewDigest"`
	TargetRevision            int64                `json:"targetRevision"`
	EnvelopeRevision          int64                `json:"envelopeRevision"`
	LegacyPolicyRevision      int64                `json:"legacyPolicyRevision"`
	PolicyRevision            int64                `json:"policyRevision"`
	BoundaryRevisions         []RevisionRef        `json:"boundaryRevisions"`
	GrantRevisions            []RevisionRef        `json:"grantRevisions"`
	TerminalGeneration        string               `json:"terminalGeneration"`
	TerminalID                string               `json:"terminalId"`
	TerminalContextRevision   int64                `json:"terminalContextRevision"`
	MCPBindingRevision        int64                `json:"mcpBindingRevision"`
	MCPCatalogRevision        int64                `json:"mcpCatalogRevision"`
	MCPConfigRevision         int64                `json:"mcpConfigRevision"`
	MCPServerID               string               `json:"mcpServerId"`
	MCPToolName               string               `json:"mcpToolName"`
	Credentials               []CredentialRevision `json:"credentials"`
	OwnerID                   string               `json:"ownerId"`
	OwnerGeneration           int64                `json:"ownerGeneration"`
	CommandProfileID          string               `json:"commandProfileId"`
	CommandProfileVersion     int64                `json:"commandProfileVersion"`
	CommandArgumentsDigest    string               `json:"commandArgumentsDigest"`
	ServiceID                 string               `json:"serviceId"`
	Scope                     OperationScope       `json:"scope"`
	Parents                   []ParentBinding      `json:"parents"`
}

type ParentBinding struct {
	ScopeID           string `json:"scopeId"`
	OwnerBindingID    string `json:"ownerBindingId"`
	OwnerGeneration   int64  `json:"ownerGeneration"`
	TaskID            string `json:"taskId"`
	ExecutionRevision int64  `json:"executionRevision"`
	BoundaryID        string `json:"boundaryId"`
	BoundaryRevision  int64  `json:"boundaryRevision"`
	AuthorityID       string `json:"authorityId"`
	AuthorityRevision int64  `json:"authorityRevision"`
	RoleDigest        string `json:"roleDigest"`
}

// OperationScope records the exact limits frozen by the adapter. Limits are
// enforced again by that adapter at I/O time (e.g. symlink/DNS revalidation).
type OperationScope struct {
	ProbeID             string   `json:"probeId"`
	ProbeVersion        int64    `json:"probeVersion"`
	FileRoot            string   `json:"fileRoot"`
	FileIdentity        string   `json:"fileIdentity"`
	FileSize            int64    `json:"fileSize"`
	FileModifiedNanos   int64    `json:"fileModifiedNanos"`
	FileRootIdentity    string   `json:"fileRootIdentity"`
	FilePath            string   `json:"filePath"`
	ExpectedContentHash string   `json:"expectedContentHash"`
	DatabaseID          string   `json:"databaseId"`
	Schema              string   `json:"schema"`
	MaxRows             int64    `json:"maxRows"`
	MaxDurationMS       int64    `json:"maxDurationMs"`
	ClusterID           string   `json:"clusterId"`
	Namespace           string   `json:"namespace"`
	ResourceKind        string   `json:"resourceKind"`
	Verb                string   `json:"verb"`
	LogLines            int64    `json:"logLines"`
	LogSeconds          int64    `json:"logSeconds"`
	NetworkScheme       string   `json:"networkScheme"`
	NetworkHost         string   `json:"networkHost"`
	NetworkPort         int      `json:"networkPort"`
	ResolvedAddresses   []string `json:"resolvedAddresses"`
}

type NetworkLimit struct {
	Scheme, Host string
	Port         int
	AddressCIDRs []string
}

type ScopeLimits struct {
	FileRoots                        []string
	DatabaseID                       string
	Schemas                          []string
	MaxRows, MaxDurationMS           int64
	ClusterID                        string
	Namespaces, ResourceKinds, Verbs []string
	MaxLogLines, MaxLogSeconds       int64
	NetworkTargets                   []NetworkLimit
}

type Rule struct {
	Capability     string
	ResourceIDs    []string // nil/empty means project-wide; this is not a boundary.
	Effect         Effect
	Grantable      bool
	Confirmation   Confirmation
	Limits         ScopeLimits
	matchingLimits []ScopeLimits
}

type ProjectPolicy struct {
	ProjectID, StoreID, RecoveryEpoch, Mode string
	SchemaVersion                           int
	Revision                                int64
	Confirmed                               bool
	ResourceIDs                             []string // explicit project resource ceiling; empty permits none.
	DenyLocal                               bool
	Rules                                   []Rule
}

type TaskGrant struct {
	CommandTargetRevisions                                           []RevisionRef
	BackgroundPolicy                                                 string // Approval snapshot; live task/envelope remain authoritative.
	ID, StoreID, RecoveryEpoch, ProjectID, SessionID, GoalID, TaskID string
	Revision                                                         int64
	Resources                                                        []ResourceRevision
	Capabilities                                                     []string
	CommandProfiles                                                  []CommandProfileScope
	ServiceIDs                                                       []string
	CreatedAt                                                        time.Time
	ExpiresAt                                                        time.Time
	Revoked                                                          bool
	RemainingUses                                                    int64
	// ParentAuthority is revalidated from current authority records by the host.
	ParentAuthorityID    string
	ParentAuthorityValid bool
	AllowedChildScopes   []string
	Limits               ScopeLimits
}

type CommandProfileScope struct {
	ID              string
	Version         int64
	ArgumentsDigest string
}

type SingleApproval struct {
	ID, StoreID, RecoveryEpoch, TaskID, SessionID, RootTurnID, ChildScopeID, DescriptorDigest string
	ExecutionRevision                                                                         int64
	CreatedAt                                                                                 time.Time
	ExpiresAt                                                                                 time.Time
	Authorized, Consumed                                                                      bool
	EnvelopeException                                                                         bool
}

type AuthoritySource struct {
	Capability string `json:"capability"`
	ResourceID string `json:"resourceId,omitempty"`
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	Revision   int64  `json:"revision"`
}

type Decision struct {
	Effect               Effect            `json:"effect"`
	ReasonCode           ReasonCode        `json:"reasonCode"`
	OperationID          string            `json:"operationId"`
	DescriptorDigest     string            `json:"descriptorDigest"`
	Authorities          []AuthoritySource `json:"authorities,omitempty"`
	RequiredCapabilities []string          `json:"requiredCapabilities,omitempty"`
}

type ExecutionOwner struct {
	ID         string
	Generation int64
	LeaseUntil time.Time
}

// ParentRestriction is resolved from the live parent chain, not a copied grant.
type ParentRestriction struct {
	SharedTaskScope         bool
	ScopeID, OwnerBindingID string
	OwnerGeneration         int64
	Task                    SecurityTask
	Boundary                *ExecutionBoundary
	RoleCapabilities        []string
	AuthorityValid          bool
	AuthorityID             string
	AuthorityRevision       int64
}

type TaskEnvelope struct {
	CommandTargetRevisions []RevisionRef
	BudgetGrantIDs         []string
	Resources              []ResourceRevision
	BackgroundPolicy       string
	Revision               int64
	ResourceIDs            []string
	Capabilities           []string
	CommandProfiles        []CommandProfileScope
	ServiceIDs             []string
	Limits                 ScopeLimits
}

type EvaluationInput struct {
	CommandTargetRevision                                     int64
	LegacyPolicyRevision                                      int64
	LocalExecution                                            bool
	Now                                                       time.Time
	StoreID, RecoveryEpoch                                    string
	GateOpen                                                  bool
	Operation                                                 PreparedOperation
	Task                                                      SecurityTask
	Policy                                                    ProjectPolicy
	Resources                                                 []ResourceRevision
	Owner                                                     ExecutionOwner
	TargetRevision                                            int64
	Boundaries                                                []ExecutionBoundary
	Parents                                                   []ParentRestriction
	RoleCapabilities                                          []string // non-nil explicitly constrains the current role.
	Envelope                                                  *TaskEnvelope
	Grants                                                    []TaskGrant
	Approvals                                                 []SingleApproval
	TerminalGeneration                                        string
	TerminalContextRevision                                   int64
	MCPServerID, MCPToolName                                  string
	MCPConfigRevision, MCPCatalogRevision, MCPBindingRevision int64
	CredentialRevisions                                       []CredentialRevision
	// These facts must come from the authoritative runtime/store snapshot.
	GoalReady, RootTurnCurrent, ChildScopeCurrent bool
	Cancelled, UnresolvedEffects                  bool
}
