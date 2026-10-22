package strategy

import (
	"encoding/json"
	"strings"
)

type PromptLayer string

const (
	FixedRules      PromptLayer = "fixed_rules"
	BuiltinStrategy PromptLayer = "builtin_strategy"
	UserStrategy    PromptLayer = "user_strategy"
	TaskContext     PromptLayer = "task_context"
)

// PromptPart is trusted host composition metadata, never an instruction or a
// permission supplied by a model. Order and whitespace are significant.
type PromptPart struct {
	Layer        PromptLayer
	Source, Text string
}
type Composition struct{ Parts []PromptPart }

func (c *Composition) Append(layer PromptLayer, source, text string) {
	if text != "" {
		c.Parts = append(c.Parts, PromptPart{layer, source, text})
	}
}
func (c *Composition) AppendComposition(other Composition) { c.Parts = append(c.Parts, other.Parts...) }
func (c Composition) Text() string {
	var b strings.Builder
	for _, p := range c.Parts {
		b.WriteString(p.Text)
	}
	return b.String()
}

type PromptFragment struct {
	Layer       PromptLayer `json:"layer"`
	Source      string      `json:"source"`
	ContentHash string      `json:"contentHash"`
	Bytes       int         `json:"bytes"`
}

func (c Composition) Fragments() []PromptFragment {
	out := make([]PromptFragment, 0, len(c.Parts))
	for _, p := range c.Parts {
		out = append(out, PromptFragment{p.Layer, p.Source, ContentHash(p.Text), len(p.Text)})
	}
	return out
}
func (c Composition) LayerHash(layer PromptLayer) string {
	return FragmentLayerHash(c.Fragments(), layer)
}

// PromptManifest describes one prepared provider request, including request
// copies and recovery retries. It contains fingerprints, never source bodies,
// URL/header/credential configuration, tool outputs or model reasoning.
type PromptManifest struct {
	SchemaVersion           int               `json:"schemaVersion"`
	RequestID               string            `json:"requestId"`
	RunID                   string            `json:"runId"`
	TurnID                  string            `json:"turnId"`
	Round                   int               `json:"round"`
	RetryOf                 string            `json:"retryOf,omitempty"`
	BuildCommit             string            `json:"buildCommit"`
	BuildDirty              bool              `json:"buildDirty"`
	Profile                 string            `json:"profile"`
	Role                    string            `json:"role,omitempty"`
	FixedRulesHash          string            `json:"fixedRulesHash"`
	BuiltinStrategyHash     string            `json:"builtinStrategyHash"`
	Fragments               []PromptFragment  `json:"fragments"`
	SelectedAssets          []RevisionRef     `json:"selectedAssets"`
	SkillSnapshots          []SkillSnapshot   `json:"skillSnapshots"`
	ModelConfigHash         string            `json:"modelConfigHash"`
	ToolCatalogHash         string            `json:"toolCatalogHash"`
	PermissionPolicyVersion string            `json:"permissionPolicyVersion"`
	PermissionSettingsHash  string            `json:"permissionSettingsHash"`
	TargetScopeHash         string            `json:"targetScopeHash"`
	InputBudget             PromptInputBudget `json:"inputBudget"`
	OmittedAssets           []OmittedAsset    `json:"omittedAssets"`
	ProjectSettingsRevision int64             `json:"projectSettingsRevision,omitempty"`
	ProjectEpoch            int64             `json:"projectEpoch,omitempty"`
	SettingsRevision        int64             `json:"settingsRevision"`
	Epoch                   int64             `json:"epoch"`
	SystemHash              string            `json:"systemHash"`
	RequestHash             string            `json:"requestHash"`
	CompositionMatched      bool              `json:"compositionMatched"`
	PreparedAt              string            `json:"preparedAt"`
}
type SkillSnapshot struct {
	ResultHash  string `json:"resultHash"` // Exact paired tool-message payload, including clipping.
	ID          string `json:"id"`
	ContentHash string `json:"contentHash"`
	CallID      string `json:"callId"`
}
type OmittedAsset struct {
	Ref    RevisionRef `json:"ref"`
	Reason string      `json:"reason"`
}
type PromptInputBudget struct {
	ContextWindow int `json:"contextWindow"`
	MaxOutput     int `json:"maxOutput"`
	MaxSteps      int `json:"maxSteps"`
	HistoryCost   int `json:"historyCost"`
	ToolsCost     int `json:"toolsCost"`
}

// CanonicalJSON uses this struct's field order and encoding/json's sorted map
// keys and UTF-8 escaping. All arrays preserve actual request/injection order;
// callers must not sort an ordered prompt or tool catalog to compute its hash.
func (m PromptManifest) CanonicalJSON() ([]byte, error) { return json.Marshal(m) }

// PromptBaseline freezes the host-assigned layer layout for the first system
// message of a turn. It contains no prompt body and survives approval recovery.
type PromptBaseline struct {
	Strategy   *Selection       `json:"strategy,omitempty"`
	SystemHash string           `json:"systemHash"`
	Fragments  []PromptFragment `json:"fragments"`
}
type ManifestRef struct {
	RequestID   string `json:"requestId"`
	FileName    string `json:"fileName"`
	Version     int64  `json:"version"`
	ContentHash string `json:"contentHash"`
}

func FragmentLayerHash(fragments []PromptFragment, layer PromptLayer) string {
	parts := []PromptFragment{}
	for _, p := range fragments {
		if p.Layer == layer {
			parts = append(parts, p)
		}
	}
	b, _ := json.Marshal(parts)
	return ContentHash(string(b))
}
