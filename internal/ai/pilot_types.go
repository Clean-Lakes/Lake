package ai

type PilotSettings struct {
	Enabled     bool `json:"enabled"`
	AutoAdvance bool `json:"autoAdvance"`
	Revision    int  `json:"revision"`
}

// The default is captured at task creation, never reread from the project in
// the middle of an operation. Missing policies identify historical SRE work.
type PilotTaskPolicy struct {
	AutoAdvance      bool                  `json:"autoAdvance"`
	SettingsRevision int                   `json:"settingsRevision"`
	Decisions        []PilotChoiceDecision `json:"decisions,omitempty"`
}

type PilotOperationCandidate struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
	DependsOn []string       `json:"dependsOn,omitempty"`
	Risk      string         `json:"risk"`
}

type PilotDirection struct {
	ID          string                    `json:"id"`
	Title       string                    `json:"title"`
	Reason      string                    `json:"reason"`
	Recommended bool                      `json:"recommended,omitempty"`
	Operations  []PilotOperationCandidate `json:"operations"`
}

type PilotChoice struct {
	SessionID      string           `json:"sessionId"`
	TaskID         string           `json:"taskId"`
	PlanRevisionID string           `json:"planRevisionId"`
	StepID         string           `json:"stepId"`
	AttemptID      string           `json:"attemptId"`
	Role           SREAgentRole     `json:"role"`
	Directions     []PilotDirection `json:"directions"`
}

type PilotSelection struct {
	Level        string   `json:"level"`
	DirectionID  string   `json:"directionId,omitempty"`
	OperationIDs []string `json:"operationIds,omitempty"`
}

type PilotChoiceDecision struct {
	RequestID      string                    `json:"requestId"`
	PlanRevisionID string                    `json:"planRevisionId"`
	StepID         string                    `json:"stepId"`
	AttemptID      string                    `json:"attemptId"`
	Selection      PilotSelection            `json:"selection"`
	Fingerprints   []string                  `json:"fingerprints,omitempty"`
	Operations     []PilotOperationCandidate `json:"operations,omitempty"`
	CreatedAt      string                    `json:"createdAt"`
}
