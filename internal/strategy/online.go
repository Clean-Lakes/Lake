package strategy

// OnlineObservation contains references and hashes, never raw tool output.
type OnlineObservation struct {
	CallID          string `json:"callId"`
	Tool            string `json:"tool"`
	CheckHash       string `json:"checkHash"`
	EvidenceHash    string `json:"evidenceHash"`
	TargetHash      string `json:"targetHash"`
	Class           string `json:"class"`
	TrustedReadOnly bool   `json:"trustedReadOnly"`
	Success         bool   `json:"success"`
	At              string `json:"at"`
}

type OnlineRevision struct {
	SourceID            string `json:"sourceId"`
	RefutedHypothesis   string `json:"refutedHypothesis"`
	Changes             string `json:"changes"`
	ExpectedInformation string `json:"expectedInformation"`
	StopCondition       string `json:"stopCondition"`
	Tool                string `json:"tool"`
	Arguments           string `json:"arguments"`
	CallID              string `json:"callId,omitempty"`
	Progress            bool   `json:"progress"`
}

type OnlineReport struct {
	SchemaVersion      int                 `json:"schemaVersion"`
	ID                 string              `json:"id"`
	TaskID             string              `json:"taskId,omitempty"`
	TurnID             string              `json:"turnId"`
	Arm                ExperimentArm       `json:"arm"`
	ModelRef           string              `json:"modelRef"`
	GlobalEpoch        int64               `json:"globalEpoch"`
	ProjectEpoch       int64               `json:"projectEpoch"`
	Budget             Budget              `json:"budget"`
	StartedAt          string              `json:"startedAt"`
	ActiveAt           string              `json:"activeAt"`
	ActiveMilliseconds int64               `json:"activeMilliseconds"`
	WaitSince          string              `json:"waitSince,omitempty"`
	SelectedAssets     []RevisionRef       `json:"selectedAssets"`
	Manifests          []ManifestRef       `json:"manifests"`
	PermissionHash     string              `json:"permissionHash"`
	Profile            string              `json:"profile"`
	StopReason         StopReason          `json:"stopReason,omitempty"`
	Pending            *OnlineObservation  `json:"pending,omitempty"`
	Observations       []OnlineObservation `json:"observations"`
	OpenChecks         []OnlineObservation `json:"openChecks"`
	Revisions          []OnlineRevision    `json:"revisions"`
	NoProgress         int                 `json:"noProgress"`
	Requests           int                 `json:"requests"`
	TokensCharged      int64               `json:"tokensCharged"`
	UsageUnknown       bool                `json:"usageUnknown"`
	UnknownRequests    int                 `json:"unknownRequests"`
	InFlightCall       string              `json:"inFlightCall,omitempty"`
	InFlightRequest    bool                `json:"inFlightRequest"`
	Recovered          bool                `json:"recovered"`
}

// A completed sample covers a known failed check only when its logical check
// and authorized target are unchanged. Novel text, IDs or timestamps do not
// prove progress. Alternate checks remain observations, not recovery proof.
func OnlineProgress(failed, sample OnlineObservation) bool {
	return !failed.Success && failed.TrustedReadOnly && sample.TrustedReadOnly &&
		sample.Success && failed.CheckHash != "" && failed.CheckHash == sample.CheckHash &&
		failed.TargetHash != "" && failed.TargetHash == sample.TargetHash && sample.EvidenceHash != ""
}
