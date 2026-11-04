package ai

// Historical strategy snapshots remain readable for audit and source withdrawal.
// This format is not an active learning queue; preserve its JSON and hash contract.
type StrategyEvidence struct {
	CallID     string `json:"callId"`
	Tool       string `json:"tool"`
	Status     string `json:"status"`
	ResultHash string `json:"resultHash"`
}
type StrategyTurnSnapshot struct {
	Deferred            bool               `json:"deferred,omitempty"`
	HistoryStart        int                `json:"historyStart,omitempty"`
	HistoryEnd          int                `json:"historyEnd,omitempty"`
	UserTextHash        string             `json:"userTextHash,omitempty"`
	UserMessageID       string             `json:"userMessageId"`
	SessionID           string             `json:"sessionId"`
	ProjectID           string             `json:"projectId"`
	TurnID              string             `json:"turnId"`
	StartedAt           string             `json:"startedAt"`
	FinishedAt          string             `json:"finishedAt"`
	GlobalEpoch         int64              `json:"globalEpoch"`
	ProjectEpoch        int64              `json:"projectEpoch"`
	Status              string             `json:"status"`
	Profile             string             `json:"profile"`
	UserText            string             `json:"userText"`
	AssistantText       string             `json:"assistantText"`
	Evidence            []StrategyEvidence `json:"evidence"`
	IgnoreProjectMemory bool               `json:"ignoreProjectMemory,omitempty"`
	Correction          bool               `json:"correction"`
	ModelRef            string             `json:"modelRef"`
	SnapshotHash        string             `json:"snapshotHash"`
}

func SealStrategySnapshot(s StrategyTurnSnapshot) StrategyTurnSnapshot {
	s.SnapshotHash = ""
	s.SnapshotHash = hash(js(s))
	return s
}
func ValidStrategySnapshot(s StrategyTurnSnapshot) bool {
	return s.UserMessageID != "" && s.SessionID != "" && s.ProjectID != "" && s.TurnID != "" && len(js(s)) <= 32768 && s.SnapshotHash == SealStrategySnapshot(s).SnapshotHash && (s.Status == "completed" || s.Status == "failed")
}
