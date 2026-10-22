package ai

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/Clean-Lakes/Lake/internal/strategy"
	"time"
)

type Model struct {
	ReasoningEffort     string               `json:"reasoningEffort,omitempty"`
	Reasoning           *ReasoningCapability `json:"reasoningCapability,omitempty"`
	SupportsImageInput  bool                 `json:"supportsImageInput,omitempty"`
	SupportsImageOutput bool                 `json:"supportsImageOutput,omitempty"`
	URL                 string               `json:"url"`
	Name                string               `json:"name"`
	Key                 string               `json:"key,omitempty"`
	Protocol            string               `json:"protocol,omitempty"`
	ContextLimit        int                  `json:"contextLimit,omitempty"`
	ContextLimitSource  string               `json:"contextLimitSource,omitempty"`
	ContextWindow       int                  `json:"contextWindow,omitempty"`
	MaxOutput           int                  `json:"maxOutput,omitempty"`
	Headers             map[string]string    `json:"headers,omitempty"`
}
type Asset struct {
	FolderPath []string       `json:"folderPath,omitempty"`
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Kind       string         `json:"kind"`
	SSH        *SSH           `json:"ssh,omitempty"`
	Settings   map[string]any `json:"settings,omitempty"`
}
type SSH struct {
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Username      string `json:"username"`
	IdentityFile  string `json:"identityFile,omitempty"`
	AuthMethod    string `json:"authMethod,omitempty"`
	CredentialRef string `json:"credentialRef,omitempty"`
	KnownHosts    string `json:"-"`
}
type Config struct {
	ConversationMode        string `json:"conversationMode,omitempty"`
	ModelProviderID         string `json:"modelProviderId,omitempty"` // Logical catalog ID only; never an endpoint or credential.
	legacyInvestigations    bool   // Historical runtime compatibility; never enabled by user settings.
	sreCoordinator          bool
	sre                     *sreRoleContext
	targetScope             *TargetScope
	StrategyLearnEnabled    bool             `json:"-"`
	StrategyCorrectEnabled  bool             `json:"-"`
	StrategyBudget          strategy.Budget  `json:"-"`
	StrategyGlobalEpoch     int64            `json:"-"`
	StrategyProjectEpoch    int64            `json:"-"`
	MemoryProjectID         string           `json:"-"`
	MemoryEnabled           bool             `json:"-"`
	MemoryExtractionEnabled bool             `json:"-"`
	MemoryEpoch             int              `json:"-"`
	MemoryKnowledgeRevision int              `json:"-"`
	Directories             []AssetDirectory `json:"directories,omitempty"`
	agentRole               string
	workflowMode            bool
	MultiAgentMode          string       `json:"multiAgentMode,omitempty"`
	Permissions             *Permissions `json:"permissions,omitempty"`
	ReferencedAssets        []string     `json:"-"`
	AuthSecrets             []string     `json:"-"`
	CredentialDir           string       `json:"-"`
	Model                   Model        `json:"model"`
	Profile                 string       `json:"profile"`
	UserPrompt              string       `json:"userPrompt,omitempty"`
	Runtime                 string       `json:"runtime,omitempty"`
	AssetRef                string       `json:"asset_ref,omitempty"`
	Container               string       `json:"container_id,omitempty"`
	TerminalID              string       `json:"terminal_id,omitempty"`
	Assets                  []Asset      `json:"assets"`
	MaxSteps                int          `json:"maxSteps,omitempty"`
	Workspace               string       `json:"workspace,omitempty"`
}
type Call struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}
type Message struct {
	Images         []ImageAttachment `json:"images,omitempty"`
	NativeProtocol string            `json:"nativeProtocol,omitempty"`
	NativeModel    string            `json:"nativeModel,omitempty"`
	Role           string            `json:"role"`
	Content        string            `json:"content"`
	Reasoning      string            `json:"reasoning,omitempty"`
	Calls          []Call            `json:"tool_calls,omitempty"`
	CallID         string            `json:"tool_call_id,omitempty"`
	Name           string            `json:"name,omitempty"`
	Native         []json.RawMessage `json:"native,omitempty"`
}
type Usage struct {
	InputKnown  bool `json:"inputKnown"`
	OutputKnown bool `json:"outputKnown"`
	Known       bool `json:"known,omitempty"`
	CachedInput *int `json:"cachedInput"`
	Input       int  `json:"input"`
	Output      int  `json:"output"`
	Total       int  `json:"total"`
}
type Card struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Title   string `json:"title,omitempty"`
	Content string `json:"content,omitempty"`
	Data    any    `json:"data,omitempty"`
	Status  string `json:"status"`
	At      string `json:"at"`
}
type Approval struct {
	ResourceID         string `json:"resourceId,omitempty"`
	TerminalID         string `json:"terminalId,omitempty"`
	TerminalGeneration string `json:"terminalGeneration,omitempty"`
	TerminalVersion    int    `json:"terminalVersion,omitempty"`
	Kind               string `json:"kind,omitempty"`
	NeedsTerminal      bool   `json:"needsTerminal,omitempty"`
	Preview            any    `json:"preview,omitempty"`
	ID                 string `json:"id"`
	Call               Call   `json:"call"`
	Target             string `json:"target"`
	Risk               string `json:"risk"`
	Confirmation       string `json:"confirmation,omitempty"`
	Fingerprint        string `json:"fingerprint"`
}
type View struct {
	ProposedPlan      *ProposedPlan      `json:"proposedPlan,omitempty"`
	OperationOutcomes []OperationOutcome `json:"operationOutcomes,omitempty"`
	PendingApprovals  []*Approval        `json:"pendingApprovals,omitempty"`
	Todos             []Todo             `json:"todos,omitempty"`
	Question          *QuestionRequest   `json:"question,omitempty"`
	MemoryStatus      string             `json:"memoryStatus,omitempty"`
	AgentRuns         []AgentRun         `json:"agentRuns,omitempty"`
	DelegatedUsage    Usage              `json:"delegatedUsage,omitempty"`
	RootTurnID        string             `json:"rootTurnId,omitempty"`
	CardsOffset       int                `json:"cardsOffset"`
	TotalCards        int                `json:"totalCards"`
	StartedAt         string             `json:"startedAt,omitempty"`
	TurnStartedAt     string             `json:"turnStartedAt,omitempty"`
	TurnFinishedAt    string             `json:"turnFinishedAt,omitempty"`
	Session           string             `json:"session"`
	Status            string             `json:"status"`
	Cards             []Card             `json:"cards"`
	Pending           *Approval          `json:"pending,omitempty"`
	Context           *ContextUsage      `json:"context,omitempty"`
	Usage             Usage              `json:"usage"`
	Profile           string             `json:"profile"`
	Summary           string             `json:"summary,omitempty"`
	Turns             int                `json:"turns"`
}
type State struct {
	PromptBaseline         *strategy.PromptBaseline       `json:"promptBaseline,omitempty"`
	SkillSnapshots         []strategy.SkillSnapshot       `json:"skillSnapshots,omitempty"`
	Runtime                *RuntimeCheckpoint             `json:"runtime,omitempty"`
	SREHandoff             *SREHandoff                    `json:"sreHandoff,omitempty"`
	QuestionDecisions      map[string]map[string][]string `json:"questionDecisions,omitempty"`
	FileReads              map[string]string              `json:"fileReads,omitempty"`
	StrategyOutbox         []StrategyTurnSnapshot         `json:"strategyOutbox,omitempty"`
	MemoryOutbox           []MemoryTurnSnapshot           `json:"memoryOutbox,omitempty"`
	MemoryRecentUserInputs []string                       `json:"memoryRecentUserInputs,omitempty"`
	TargetScope            *TargetScope                   `json:"targetScope,omitempty"`
	RootQuestion           string                         `json:"rootQuestion,omitempty"`
	ReferencedAssetIDs     []string                       `json:"referencedAssetIds,omitempty"`
	LastRequest            *Usage                         `json:"lastRequest,omitempty"`
	LastRequestAt          string                         `json:"lastRequestAt,omitempty"`
	ContextMeasurement     *ContextMeasurement            `json:"contextMeasurement,omitempty"`
	View                   View                           `json:"view"`
	History                []Message                      `json:"history"`
	Checkpoints            []int                          `json:"checkpoints"`
	Config                 Config                         `json:"config"`
	Undo                   []FileUndo                     `json:"undo,omitempty"`
}
type FileUndo struct {
	TargetHash string `json:"targetHash,omitempty"`
	Path       string `json:"path"`
	Before     string `json:"before"`
	AfterHash  string `json:"afterHash"`
	Existed    bool   `json:"existed"`
	Runtime    string `json:"runtime"`
	AssetRef   string `json:"asset_ref,omitempty"`
	Container  string `json:"container_id,omitempty"`
}
type Event struct {
	Session string `json:"session"`
	Type    string `json:"type"`
	Data    any    `json:"data"`
}
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}
type Bridge func(context.Context, string, string, map[string]any, bool) (any, error)
type Preset struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
}

func uid() string       { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }
func timestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func str(v any) string  { s, _ := v.(string); return s }
func num(v any, fallback int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case json.Number:
		if value, err := n.Int64(); err == nil {
			return int(value)
		}
	}
	return fallback
}
func js(v any) string { b, _ := json.Marshal(v); return string(b) }
func args(c Call) (map[string]any, error) {
	var a map[string]any
	if err := json.Unmarshal([]byte(c.Arguments), &a); err != nil || a == nil {
		return nil, fmt.Errorf("invalid tool arguments")
	}
	return a, nil
}
