package ai

import "encoding/json"

// SRE product roles are independent of legacy diagnostic domains.
type SREAgentRole string

const (
	SRECoordinator  SREAgentRole = "coordinator"
	SREInvestigator SREAgentRole = "investigator"
	SREExecutor     SREAgentRole = "executor"
	SREVerifier     SREAgentRole = "verifier"
)

type SREError struct {
	Status  int
	Message string
}

func (e *SREError) Error() string               { return e.Message }
func sreError(status int, message string) error { return &SREError{status, message} }

type SRECheck struct {
	ID            string     `json:"id"`
	Description   string     `json:"description"`
	Kind          string     `json:"kind"`
	ResourceID    string     `json:"resourceId,omitempty"`
	Probe         *SREAction `json:"probe,omitempty"`
	Path          string     `json:"path,omitempty"`
	Operator      string     `json:"operator,omitempty"`
	Expected      any        `json:"expected,omitempty"`
	Unit          string     `json:"unit,omitempty"`
	WindowSeconds int        `json:"windowSeconds,omitempty"`
	MinSamples    int        `json:"minSamples,omitempty"`
}

type SREAction struct {
	Tool          string         `json:"tool"`
	Arguments     map[string]any `json:"arguments"`
	Reason        string         `json:"reason,omitempty"`
	Impact        string         `json:"impact,omitempty"`
	Rollback      string         `json:"rollback,omitempty"`
	StopCondition string         `json:"stopCondition,omitempty"`
}

type SREPlanStep struct {
	ID               string       `json:"id"`
	Role             SREAgentRole `json:"role"`
	Kind             string       `json:"kind"`
	Description      string       `json:"description"`
	Capability       string       `json:"capability,omitempty"`
	DependsOn        []string     `json:"dependsOn"`
	ResourceIDs      []string     `json:"resourceIds"`
	CompletionChecks []string     `json:"completionChecks"`
	Action           *SREAction   `json:"action,omitempty"`
}

type SREPlanRevision struct {
	CollaborationVersion int           `json:"collaborationVersion,omitempty"`
	ID                   string        `json:"id"`
	TaskID               string        `json:"taskId"`
	Version              int           `json:"version"`
	Goal                 string        `json:"goal"`
	TaskType             string        `json:"taskType"`
	Scope                []string      `json:"scope"`
	Steps                []SREPlanStep `json:"steps"`
	Acceptance           []SRECheck    `json:"acceptance"`
	ChangeReason         string        `json:"changeReason"`
	CreatedAt            string        `json:"createdAt"`
}

type SREPlanRun struct {
	ID             string `json:"id"`
	TaskID         string `json:"taskId"`
	PlanRevisionID string `json:"planRevisionId"`
	ProfileVersion int    `json:"profileVersion"`
	Status         string `json:"status"`
	ResumeOfRunID  string `json:"resumeOfRunId,omitempty"`
	StartedAt      string `json:"startedAt"`
	FinishedAt     string `json:"finishedAt,omitempty"`
}

type SREOperation struct {
	Risk           string `json:"risk,omitempty"` // Trusted runtime policy, never a model assertion.
	ResolutionNote string `json:"resolutionNote,omitempty"`
	ResolvedBy     string `json:"resolvedBy,omitempty"`
	ResolvedAt     string `json:"resolvedAt,omitempty"`
	ID             string `json:"id"`
	Call           Call   `json:"call"`
	Digest         string `json:"digest"`
	ResourceID     string `json:"resourceId"`
	Status         string `json:"status"`
	PreparedAt     string `json:"preparedAt"`
	DispatchedAt   string `json:"dispatchedAt,omitempty"`
	FinishedAt     string `json:"finishedAt,omitempty"`
	ApprovalID     string `json:"approvalId,omitempty"`
	Result         string `json:"result,omitempty"`
}

type SREStepAttempt struct {
	Report              *SRERoleReport  `json:"report,omitempty"`
	ReusedFromAttemptID string          `json:"reusedFromAttemptId,omitempty"`
	ID                  string          `json:"id"`
	PlanRunID           string          `json:"planRunId"`
	StepID              string          `json:"stepId"`
	RoleRunID           string          `json:"roleRunId"`
	Status              string          `json:"status"`
	Evidence            []AgentEvidence `json:"evidence"`
	Operations          []SREOperation  `json:"operations"`
	Result              string          `json:"result,omitempty"`
	StartedAt           string          `json:"startedAt"`
	FinishedAt          string          `json:"finishedAt,omitempty"`
}

type SREFact struct {
	Statement   string   `json:"statement"`
	EvidenceIDs []string `json:"evidenceIds"`
}
type SRERoleReport struct {
	SchemaVersion int       `json:"schemaVersion"`
	Summary       string    `json:"summary"`
	Facts         []SREFact `json:"facts"`
	Hypotheses    []string  `json:"hypotheses"`
	Unknowns      []string  `json:"unknowns"`
	NextChecks    []string  `json:"nextChecks"`
}

type SRETranscriptEntry struct {
	ToRoleID    SREAgentRole `json:"toRoleId,omitempty"`
	EvidenceIDs []string     `json:"evidenceIds,omitempty"`
	Source      string       `json:"source,omitempty"`
	ID          string       `json:"id"`
	SessionID   string       `json:"sessionId"`
	TaskID      string       `json:"taskId"`
	RoleID      SREAgentRole `json:"roleId"`
	RoleRunID   string       `json:"roleRunId"`
	Kind        string       `json:"kind"`
	Body        string       `json:"body"`
	Revision    int          `json:"revision"`
	Sequence    int64        `json:"sequence"`
	PlanVersion int          `json:"planVersion,omitempty"`
	AttemptID   string       `json:"attemptId,omitempty"`
	CreatedAt   string       `json:"createdAt"`
}

type SRECheckResult struct {
	CheckID     string   `json:"checkId"`
	Status      string   `json:"status"`
	Reason      string   `json:"reason"`
	EvidenceIDs []string `json:"evidenceIds"`
	Samples     int      `json:"samples"`
	Value       any      `json:"value,omitempty"`
	AttestedBy  string   `json:"attestedBy,omitempty"`
	CheckedAt   string   `json:"checkedAt"`
}

type SREVerificationResult struct {
	ReviewSummary string           `json:"reviewSummary,omitempty"`
	ID            string           `json:"id"`
	TaskID        string           `json:"taskId"`
	PlanRunID     string           `json:"planRunId"`
	Checks        []SRECheckResult `json:"checks"`
	Verdict       string           `json:"verdict"`
	CheckedAt     string           `json:"checkedAt"`
}

type SRETask struct {
	Requests        map[string]string       `json:"requests,omitempty"`
	ID              string                  `json:"id"`
	SessionID       string                  `json:"sessionId"`
	ProjectID       string                  `json:"projectId"`
	RequestID       string                  `json:"requestId"`
	Goal            string                  `json:"goal"`
	Scope           []string                `json:"scope"`
	Mode            string                  `json:"mode"`
	Status          string                  `json:"status"`
	Outcome         string                  `json:"outcome"`
	RecoveryStatus  string                  `json:"recoveryStatus"`
	RootCauseStatus string                  `json:"rootCauseStatus"`
	ProfileID       string                  `json:"profileId"`
	ProfileVersion  int                     `json:"profileVersion"`
	Revision        int                     `json:"revision"`
	TokenBudget     int                     `json:"tokenBudget"`
	BudgetPolicy    string                  `json:"budgetPolicy,omitempty"`
	BudgetSpent     int                     `json:"budgetSpent"`
	Usage           Usage                   `json:"usage"`
	Plans           []SREPlanRevision       `json:"plans"`
	Runs            []SREPlanRun            `json:"runs"`
	Attempts        []SREStepAttempt        `json:"attempts"`
	Messages        []SRETranscriptEntry    `json:"messages"`
	Verifications   []SREVerificationResult `json:"verifications"`
	Error           string                  `json:"error,omitempty"`
	CreatedAt       string                  `json:"createdAt"`
	UpdatedAt       string                  `json:"updatedAt"`
}

type SREEvent struct {
	ID        int64           `json:"id"`
	TaskID    string          `json:"taskId"`
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"createdAt"`
}

type SRESnapshot struct {
	FeatureVersion int       `json:"featureVersion"`
	Enabled        bool      `json:"enabled"`
	Tasks          []SRETask `json:"tasks"`
}

func (t *SRETask) LatestPlan() *SREPlanRevision {
	if len(t.Plans) == 0 {
		return nil
	}
	return &t.Plans[len(t.Plans)-1]
}
func (t *SRETask) ActiveRun() *SREPlanRun {
	if len(t.Runs) == 0 {
		return nil
	}
	return &t.Runs[len(t.Runs)-1]
}
func (t *SRETask) AddMessage(role SREAgentRole, roleRunID, kind, body, attemptID string) {
	entry := SRETranscriptEntry{ID: uid(), SessionID: t.SessionID, TaskID: t.ID, RoleID: role, RoleRunID: roleRunID, Kind: kind, Body: body, AttemptID: attemptID, Revision: 1, CreatedAt: timestamp()}
	if p := t.LatestPlan(); p != nil {
		entry.PlanVersion = p.Version
	}
	t.Messages = append(t.Messages, entry)
}
