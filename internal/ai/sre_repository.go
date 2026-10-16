package ai

// Repository transactions own all externally visible SRE facts. Model history
// files are context only and cannot authorize a dispatch or complete a task.
type SRERepository interface {
	CreateSRETask(SRETask) (SRETask, error)
	LoadSRETask(sessionID, taskID string) (SRETask, error)
	ListSRETasks(sessionID string, limit int, cursor string) ([]SRETask, error)
	MutateSRETask(sessionID, taskID string, revision int, event string, update func(*SRETask) error) (SRETask, error)
	SREEvents(sessionID, taskID string, after int64, limit int) ([]SREEvent, error)
}
