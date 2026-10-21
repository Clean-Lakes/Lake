package ai

import (
	"context"
	"github.com/Clean-Lakes/Lake/internal/strategy"
)

// RunIdentity is assigned by the host, never supplied through model arguments.
// It survives pauses and identifies every execution and its audit projection.
type RunIdentity struct {
	Branch         string       `json:"branch,omitempty"`
	IsolationScope string       `json:"isolationScope,omitempty"`
	ScopeID        string       `json:"scopeId,omitempty"`
	SessionID      string       `json:"sessionId"`
	RootTurnID     string       `json:"rootTurnId"`
	TaskID         string       `json:"taskId,omitempty"`
	PlanRevisionID string       `json:"planRevisionId,omitempty"`
	PlanRunID      string       `json:"planRunId,omitempty"`
	StepID         string       `json:"stepId,omitempty"`
	AttemptID      string       `json:"attemptId,omitempty"`
	Role           SREAgentRole `json:"role,omitempty"`
	InvocationID   string       `json:"invocationId,omitempty"`
	OperationID    string       `json:"operationId,omitempty"`
}

type RuntimeCheckpoint struct {
	PromptManifest       *strategy.ManifestRef `json:"promptManifest,omitempty"`
	Detached             bool                  `json:"detached,omitempty"`
	ModelRounds          int                   `json:"modelRounds"`
	PendingConfirmations map[string]string     `json:"pendingConfirmations,omitempty"`
	SchemaVersion        int                   `json:"schemaVersion"`
	SessionID            string                `json:"sessionId"`
	HistoryHash          string                `json:"historyHash,omitempty"`
	Identity             RunIdentity           `json:"identity"`
	EventCursor          string                `json:"eventCursor,omitempty"`
}

// RuntimeInput is the complete server-resolved turn input shared by Web, CLI,
// scheduled workflows and role hosts. Config is never serialized with secrets.
type RuntimeInput = TurnInput

type RoleInput struct {
	Identity RunIdentity `json:"identity"`
	Task     SRETask     `json:"task"`
	Step     SREPlanStep `json:"step"`
	Prompt   string      `json:"prompt"`
	NoTools  bool        `json:"noTools"`
}

type RuntimeEvent struct {
	ID       string      `json:"id"`
	Identity RunIdentity `json:"identity"`
	Kind     string      `json:"kind"`
}

// RuntimeCapabilities resolves the same domain catalog and prompt used by an
// ADK turn without mutating an otherwise idle session.
func (e *Engine) RuntimeCapabilities(ctx context.Context, id string, coordination bool) ([]Tool, string, error) {
	s, err := e.get(id)
	if err != nil {
		return nil, "", err
	}
	s.mu.Lock()
	c := s.state.Config
	s.mu.Unlock()
	c.sreCoordinator = coordination
	return e.sessionCatalog(ctx, id, c), Prompt(c), nil
}

func (e *Engine) ConfigForSession(id string) (Config, error) {
	s, err := e.get(id)
	if err != nil {
		return Config{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Config, nil
}
