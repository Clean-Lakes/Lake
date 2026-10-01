package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/lake/agent"
	agentpolicy "github.com/cloudwego/eino/lake/agent/policy"
	"github.com/cloudwego/eino/schema"
	googlejsonschema "github.com/google/jsonschema-go/jsonschema"
)

var toolName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,127}$`)

// ErrInvalidInput identifies rejected model arguments. Callers may let a
// presentation-only tool request a correction without changing validation or
// converting authorization and execution failures into success.
var ErrInvalidInput = errors.New("invalid tool input")

type Registry struct {
	mu    sync.RWMutex
	tools map[string]tool.BaseTool
}

func NewRegistry() *Registry { return &Registry{tools: make(map[string]tool.BaseTool)} }

func (r *Registry) Register(spec agent.ToolSpec, base tool.BaseTool) error {
	if r == nil || base == nil || !toolName.MatchString(spec.Name) || spec.Description == "" || spec.Capability == "" || spec.MaxOutputBytes < 32 || spec.MaxOutputBytes > 1024*1024 || spec.Timeout < 0 || (spec.Timeout == 0 && spec.Capability != "user_input") || spec.Timeout > 5*time.Minute {
		return errors.New("invalid tool specification")
	}
	var inputSchema map[string]any
	if err := json.Unmarshal(spec.InputSchema, &inputSchema); err != nil || inputSchema["type"] != "object" {
		return errors.New("tool input schema must be a JSON object schema")
	}
	var parsed googlejsonschema.Schema
	if err := json.Unmarshal(spec.InputSchema, &parsed); err != nil {
		return fmt.Errorf("decode tool schema: %w", err)
	}
	resolved, err := parsed.Resolve(nil)
	if err != nil {
		return fmt.Errorf("resolve tool schema: %w", err)
	}
	info, err := base.Info(context.Background())
	if err != nil || info == nil || info.Name != spec.Name {
		return errors.New("tool metadata does not match specification")
	}
	invokable, ok := base.(tool.InvokableTool)
	if !ok {
		return errors.New("tool must implement InvokableRun")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tools == nil {
		r.tools = make(map[string]tool.BaseTool)
	}
	if _, exists := r.tools[spec.Name]; exists {
		return fmt.Errorf("tool %q is already registered", spec.Name)
	}
	r.tools[spec.Name] = &boundedTool{spec: spec, original: invokable, schema: resolved}
	return nil
}

func (r *Registry) List(scope agent.RunScope) []tool.BaseTool {
	if r == nil || scope.LakeID == "" {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		if scope.AllTools || contains(scope.ToolNames, name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	result := make([]tool.BaseTool, 0, len(names))
	for _, name := range names {
		bounded := *(r.tools[name].(*boundedTool))
		bounded.scope = scope
		result = append(result, &bounded)
	}
	return result
}

func contains(items []string, candidate string) bool {
	for _, item := range items {
		if item == candidate {
			return true
		}
	}
	return false
}

func (r *Registry) Resolve(name string) (tool.BaseTool, error) {
	if r == nil {
		return nil, errors.New("nil tool registry")
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	item, ok := r.tools[name]
	if !ok {
		return nil, fmt.Errorf("tool %q is not registered", name)
	}
	return item, nil
}

type boundedTool struct {
	spec     agent.ToolSpec
	original tool.InvokableTool
	schema   *googlejsonschema.Resolved
	scope    agent.RunScope
}

func (t *boundedTool) Info(ctx context.Context) (*schema.ToolInfo, error) {
	return t.original.Info(ctx)
}

func (t *boundedTool) InvokableRun(ctx context.Context, arguments string, opts ...tool.Option) (string, error) {
	if t.scope.LakeID != "" && (t.spec.Capability == "read" || t.spec.Capability == "delegate" || t.spec.Capability == "user_input") {
		if err := agentpolicy.Authorize(ctx, agentpolicy.Input{Spec: t.spec, Scope: t.scope, Origin: "model"}, nil); err != nil {
			return "", err
		}
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(arguments), &input); err != nil || input == nil {
		return "", fmt.Errorf("%w: tool input must be a JSON object", ErrInvalidInput)
	}
	if err := t.schema.Validate(input); err != nil {
		return "", fmt.Errorf("%w: tool input violates schema: %w", ErrInvalidInput, err)
	}
	if t.spec.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, t.spec.Timeout)
		defer cancel()
	}
	output, err := t.original.InvokableRun(ctx, arguments, opts...)
	if err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(output) <= t.spec.MaxOutputBytes {
		return output, nil
	}
	const suffix = "…[truncated]"
	limit := t.spec.MaxOutputBytes - len(suffix)
	for limit > 0 && !utf8.ValidString(output[:limit]) {
		limit--
	}
	return output[:limit] + suffix, nil
}
