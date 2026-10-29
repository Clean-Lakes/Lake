package strategy

// Historical, body-free selection metadata retained for persisted audit decoding.
type Selection struct {
	GlobalEpoch             int64             `json:"globalEpoch"`
	ProjectEpoch            int64             `json:"projectEpoch"`
	SettingsRevision        int64             `json:"settingsRevision"`
	ProjectSettingsRevision int64             `json:"projectSettingsRevision"`
	Selected                []RevisionRef     `json:"selected"`
	Omitted                 []OmittedAsset    `json:"omitted"`
	Reasons                 []SelectionReason `json:"reasons,omitempty"`
}
