package agent

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type SessionID string
type ToolCallID string

// AgentEvent is the shared, versioned envelope used by Lake's user interfaces.
// Payload schemas belong to each event kind; sensitive tool arguments do not
// belong in this envelope.
type AgentEvent struct {
	Version      int             `json:"version"`
	SessionID    SessionID       `json:"session_id"`
	Sequence     uint64          `json:"sequence"`
	Kind         string          `json:"kind"`
	Actor        string          `json:"actor"`
	ToolCallID   ToolCallID      `json:"tool_call_id,omitempty"`
	LegacyTurnID string          `json:"legacy_turn_id,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	CreatedAt    time.Time       `json:"created_at,omitempty"`
}

type ToolSpec struct {
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	Capability     string          `json:"capability"`
	InputSchema    json.RawMessage `json:"input_schema"`
	MaxOutputBytes int             `json:"max_output_bytes"`
	Timeout        time.Duration   `json:"timeout"`
}

// RunScope uses explicit All flags. An empty list grants no resource or tool.
// ProjectRoot is a lexical boundary; file operations must separately resolve
// symlinks and recheck the actual path before access.
type RunScope struct {
	LakeID       string   `json:"lake_id"`
	AllResources bool     `json:"all_resources,omitempty"`
	ResourceIDs  []string `json:"resource_ids,omitempty"`
	AllTools     bool     `json:"all_tools,omitempty"`
	ToolNames    []string `json:"tool_names,omitempty"`
	ProjectRoot  string   `json:"project_root,omitempty"`
}

var ErrScopeConflict = errors.New("run scopes have incompatible lake or project boundaries")

// Intersect derives the permissions a delegated specialist may use. Neither
// an unrestricted child nor an omitted child list expands its parent scope.
func (s RunScope) Intersect(child RunScope) (RunScope, error) {
	if s.LakeID == "" || s.LakeID != child.LakeID {
		return RunScope{}, ErrScopeConflict
	}
	project, err := intersectProjectRoot(s.ProjectRoot, child.ProjectRoot)
	if err != nil {
		return RunScope{}, err
	}
	resources, allResources := intersectNames(s.ResourceIDs, s.AllResources, child.ResourceIDs, child.AllResources)
	tools, allTools := intersectNames(s.ToolNames, s.AllTools, child.ToolNames, child.AllTools)
	return RunScope{
		LakeID:       s.LakeID,
		AllResources: allResources,
		ResourceIDs:  resources,
		AllTools:     allTools,
		ToolNames:    tools,
		ProjectRoot:  project,
	}, nil
}

func intersectNames(parent []string, parentAll bool, child []string, childAll bool) ([]string, bool) {
	if parentAll && childAll {
		return nil, true
	}
	if parentAll {
		return sortedUnique(child), false
	}
	if childAll {
		return sortedUnique(parent), false
	}
	allowed := make(map[string]struct{}, len(parent))
	for _, name := range parent {
		if name != "" {
			allowed[name] = struct{}{}
		}
	}
	var intersection []string
	for _, name := range child {
		if _, ok := allowed[name]; ok {
			intersection = append(intersection, name)
		}
	}
	return sortedUnique(intersection), false
}

func sortedUnique(names []string) []string {
	unique := make(map[string]struct{}, len(names))
	for _, name := range names {
		if name != "" {
			unique[name] = struct{}{}
		}
	}
	if len(unique) == 0 {
		return nil
	}
	result := make([]string, 0, len(unique))
	for name := range unique {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func intersectProjectRoot(parent, child string) (string, error) {
	if child == "" {
		return "", nil
	}
	if parent == "" || !filepath.IsAbs(parent) || !filepath.IsAbs(child) {
		return "", ErrScopeConflict
	}
	parent = filepath.Clean(parent)
	child = filepath.Clean(child)
	rel, err := filepath.Rel(parent, child)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrScopeConflict
	}
	return child, nil
}

type PermissionRequest struct {
	ID           string     `json:"id"`
	ToolCallID   ToolCallID `json:"tool_call_id"`
	ToolName     string     `json:"tool_name"`
	Capability   string     `json:"capability"`
	Scope        RunScope   `json:"scope"`
	Target       string     `json:"target"`
	Summary      string     `json:"summary"`
	ArgumentsSHA string     `json:"arguments_sha256"`
}

type PermissionOutcome string

const (
	PermissionAllow PermissionOutcome = "allow"
	PermissionAsk   PermissionOutcome = "ask"
	PermissionDeny  PermissionOutcome = "deny"
)

type PermissionDecision struct {
	RequestID string            `json:"request_id"`
	Outcome   PermissionOutcome `json:"outcome"`
	Reason    string            `json:"reason,omitempty"`
}
