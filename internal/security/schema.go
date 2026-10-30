// Package security defines Lake's trusted security contracts without depending
// on the AI runtime, Web server, or SDK internals.
package security

const (
	SchemaVersion = 1
	ReaderVersion = 1
	ControlFormat = 1
)

type ControlState struct {
	FormatVersion int    `json:"formatVersion"`
	StoreID       string `json:"storeID"`
	RecoveryEpoch string `json:"recoveryEpoch"`
	RuntimeRoot   string `json:"runtimeRoot"`
	Gate          string `json:"gate"`
	StoreReady    bool   `json:"storeReady"`
	RecoveryID    string `json:"recoveryID,omitempty"`
}
